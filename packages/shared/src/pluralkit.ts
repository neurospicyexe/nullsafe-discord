import type { Message } from "discord.js";
import type { Attribution } from "./types.js";
import type { PkRoster } from "./pk-roster.js";

// PluralKit's Discord application ID -- stable, not subject to change.
// When PluralKit proxies a message via webhook, message.applicationId equals this value.
const PLURALKIT_APP_ID = "466378653216014359";

export interface PKContext {
  isPluralKit: boolean;
  memberName: string | null; // display name of the fronting system member
}

export function detectPluralKit(message: Message): PKContext {
  if (!message.webhookId) {
    return { isPluralKit: false, memberName: null };
  }
  // applicationId is only populated when Discord attributes the webhook to an application;
  // for a classic webhook execute (which is how PK proxies) it is frequently NULL. So this
  // is a positive signal only -- never treat `false` here as "not PluralKit". The caller
  // combines it with roster identification and the dedup pairing (see isPKProxy in
  // bot-message-handler), which is what actually carries the decision.
  const isPluralKit = message.applicationId === PLURALKIT_APP_ID;
  return {
    isPluralKit,
    memberName: isPluralKit ? (message.author?.username ?? null) : null,
  };
}

interface PendingOriginal {
  messageId: string;
  content: string; // trimmed original content (still carries proxy tags)
  senderId: string;
  skip: boolean;
  ts: number;
  /** Set by a waiting turn; fired the instant a webhook claims this original. */
  notify?: () => void;
}

/**
 * Proxy-tag-tolerant suppression of the direct+webhook message pair PluralKit
 * produces. When PK proxies a message it deletes the user's original and reposts
 * it via webhook with the proxy tag stripped ("cy: hello" -> "hello"). Keying
 * dedup on exact content therefore misses every tag-based proxy, causing both
 * copies to be processed (double reply) and the webhook to lose the captured
 * sender id (identity falls back to guest when the PK API races).
 *
 * Matching is by content *containment* within the same channel: the proxied
 * text is always a contiguous substring of the original, whether the tag is a
 * prefix, suffix, or both. Fully offline -- it does not depend on the PK API,
 * which is exactly what fails in the moments dedup matters most.
 *
 * ORDERING (2026-07-27, load-bearing): `addOriginal` and `matchWebhook` MUST be called at
 * messageCreate event time, never inside a ChannelInbox turn. The inbox serializes turns per
 * channel, so a hold taken inside a turn blocks the very webhook turn it is waiting for --
 * the claim can never arrive, every original is processed as if unproxied, and the webhook
 * loses the captured sender id. Only the *decision* belongs in the turn, via `waitForClaim`.
 */
// Longest plausible PluralKit proxy tag including brackets/spaces. Containment
// matches are rejected when the original is longer than the webhook by more than
// this, so a short proxied message ("ok") can't be swallowed by an unrelated
// long pending message that merely contains it.
const PK_TAG_BUDGET = 16;

export class PkDedup {
  private byChannel = new Map<string, PendingOriginal[]>();
  constructor(private readonly holdMs = 3000) {}

  /** Record a direct (non-webhook) message that may shortly be proxied by PK. */
  addOriginal(channelId: string, messageId: string, content: string, senderId: string): void {
    this.prune();
    const list = this.byChannel.get(channelId) ?? [];
    list.push({ messageId, content: content.trim(), senderId, skip: false, ts: Date.now() });
    this.byChannel.set(channelId, list);
  }

  /**
   * Called when a webhook arrives. If it matches an un-consumed pending original
   * in the same channel (by containment), marks that original to be skipped and
   * returns the captured sender id so the webhook can attribute correctly even
   * if the PK API is slow or down. Returns null when there is no match.
   */
  matchWebhook(channelId: string, webhookContent: string): { senderId: string } | null {
    const text = webhookContent.trim();
    if (!text) return null; // image-only proxy: cannot match safely, never dedup-all
    const list = this.byChannel.get(channelId);
    if (!list) return null;
    // Newest first so rapid identical messages pair in send order.
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i]!;
      if (!o.skip && o.content.includes(text) && o.content.length - text.length <= PK_TAG_BUDGET) {
        o.skip = true;
        o.notify?.(); // release a turn already waiting on this original
        return { senderId: o.senderId };
      }
    }
    return null;
  }

  /** After the hold window, report whether the original was claimed by a proxy, then forget it. */
  resolveOriginal(channelId: string, messageId: string): { skip: boolean } {
    const list = this.byChannel.get(channelId);
    if (!list) return { skip: false };
    const idx = list.findIndex((o) => o.messageId === messageId);
    if (idx === -1) return { skip: false };
    const [removed] = list.splice(idx, 1);
    if (list.length === 0) this.byChannel.delete(channelId);
    return { skip: removed!.skip };
  }

  /**
   * Wait for this original to be claimed by a proxy, releasing the moment it is (or as soon
   * as the claim is found to have already happened, which is the common case when the queue
   * was busy). Falls through after `timeoutMs` and reports the original as unproxied.
   *
   * This is the only part of pairing that may run inside a serialized inbox turn.
   */
  waitForClaim(channelId: string, messageId: string, timeoutMs: number): Promise<{ skip: boolean }> {
    const list = this.byChannel.get(channelId);
    const entry = list?.find((o) => o.messageId === messageId);
    // Never registered (or already pruned): nothing can claim it -- treat as unproxied.
    if (!entry) return Promise.resolve({ skip: false });
    // Claim already landed while this turn was queued behind another: no wait at all.
    if (entry.skip) return Promise.resolve(this.resolveOriginal(channelId, messageId));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete entry.notify;
        resolve(this.resolveOriginal(channelId, messageId));
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      entry.notify = finish;
    });
  }

  /**
   * Bound the map. Claimed-but-unresolved and still-waiting entries are kept far longer than
   * the hold window on purpose: under hermes a queued turn can start minutes after its
   * message arrived, and pruning its entry first would silently restore the double-process
   * bug. A per-channel cap is the real backstop against unbounded growth.
   */
  private prune(): void {
    const cutoff = Date.now() - PK_PENDING_TTL_MS;
    for (const [ch, list] of this.byChannel) {
      const kept = list.filter((o) => o.ts >= cutoff);
      const capped = kept.length > PK_PENDING_CAP ? kept.slice(kept.length - PK_PENDING_CAP) : kept;
      if (capped.length) this.byChannel.set(ch, capped);
      else this.byChannel.delete(ch);
    }
  }
}

/** How long an unresolved original stays claimable -- must exceed the worst inbox backlog. */
const PK_PENDING_TTL_MS = 10 * 60 * 1000;
/** Hard per-channel bound so a wedged worker can't grow the map without limit. */
const PK_PENDING_CAP = 50;

interface IngestMessage {
  id: string;
  channelId: string;
  content: string;
  webhookId: string | null;
  authorId: string;
  authorIsBot: boolean;
}

/**
 * Register/claim half of PK pairing. MUST be called at messageCreate event time, before the
 * message is handed to the channel inbox -- see the ordering note on PkDedup.
 *
 * Returns the sender id recovered from the matching original for a webhook message, so
 * attribution has a certain, offline answer even when the PK API races or is down.
 */
export function pkIngestAtEvent(message: IngestMessage, dedup: PkDedup): { pkSenderId?: string } {
  if (message.webhookId) {
    const match = dedup.matchWebhook(message.channelId, message.content);
    return match ? { pkSenderId: match.senderId } : {};
  }
  if (!message.authorIsBot) {
    dedup.addOriginal(message.channelId, message.id, message.content, message.authorId);
  }
  return {};
}

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  author: { id: string; bot: boolean; username?: string };
}

export async function resolveAttribution(
  message: DiscordMessage,
  ownerDiscordId: string,
  knownSenderId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
  blueDiscordId?: string,
  bluePkSystemId?: string,
  roster?: PkRoster | null,
): Promise<Attribution> {
  if (!message.webhookId) {
    return {
      isOwner: message.author.id === ownerDiscordId,
      discordUserId: message.author.id,
      frontMember: null,
      frontState: "unknown",
      source: "direct",
    };
  }

  // Roster first (2026-07-27): PK writes the member's display name onto the webhook, so a
  // loaded roster answers offline and instantly. This is what stops a raced /v2/messages
  // lookup from demoting Raziel's own proxied message to guest-and-peer-bot.
  const known = roster?.identify(message.author.username);
  if (known) {
    return {
      isOwner: known.isOwner,
      discordUserId: known.discordUserId,
      frontMember: known.memberName,
      frontState: "known",
      source: "pluralkit",
    };
  }

  // Two attempts (2026-07-27): PK creates the /v2/messages record just *after* dispatching
  // the webhook, so a single shot at arrival loses a real race. Only reached on a roster miss.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 400));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetchFn(
        `https://api.pluralkit.me/v2/messages/${message.id}`,
        { signal: controller.signal },
      ).finally(() => clearTimeout(timeout));

      if (res.ok) {
        const pk = await res.json() as { sender: string; member?: { name: string }; system?: { id: string } };
        if (pk.sender === ownerDiscordId) {
          return {
            isOwner: true,
            discordUserId: pk.sender,
            frontMember: pk.member?.name ?? null,
            frontState: "known",
            source: "pluralkit",
          };
        }
        // Blue's system: match by Discord ID or PK system ID (belt-and-suspenders).
        const isBlue = (blueDiscordId && pk.sender === blueDiscordId)
          || (bluePkSystemId && pk.system?.id === bluePkSystemId);
        return {
          isOwner: false,
          discordUserId: isBlue ? (blueDiscordId ?? pk.sender) : pk.sender,
          frontMember: pk.member?.name ?? null,
          frontState: "known",
          source: "pluralkit",
        };
      }
    } catch {
      // timeout or network error -- try once more, then fall through
    }
  }

  // Fallback: use dedup-captured sender if available; otherwise truly unknown.
  // Never assume owner -- misattribution (Blue treated as owner) is worse than
  // a missed response (owner treated as guest, can retry).
  const senderId = knownSenderId ?? "unknown";
  return {
    isOwner: senderId === ownerDiscordId,
    discordUserId: senderId,
    frontMember: null,
    frontState: "unknown",
    source: "fallback",
  };
}
