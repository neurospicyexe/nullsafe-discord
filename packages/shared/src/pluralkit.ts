import type { Message } from "discord.js";
import type { Attribution } from "./types.js";

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
  // discord.js v14 Message.applicationId is set to the application that created the webhook.
  // PluralKit sets this to its own application ID on every proxied message.
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

  /** Drop entries older than a few hold windows so the map never grows unbounded. */
  private prune(): void {
    const cutoff = Date.now() - this.holdMs * 4;
    for (const [ch, list] of this.byChannel) {
      const kept = list.filter((o) => o.ts >= cutoff);
      if (kept.length) this.byChannel.set(ch, kept);
      else this.byChannel.delete(ch);
    }
  }
}

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  author: { id: string; bot: boolean };
}

export async function resolveAttribution(
  message: DiscordMessage,
  ownerDiscordId: string,
  knownSenderId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
  blueDiscordId?: string,
  bluePkSystemId?: string,
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
    // timeout or network error -- fall through
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
