/**
 * Discord replies, read as the fact they are (Raziel, 2026-10-31).
 *
 * "Do you guys get the difference on Discord of when you're being replied to directly? If I reply to
 * Blue, then it's just for Blue. If I reply to Drevan for a message three back, can he know that it's
 * specifically about that message?" Before this module: a reply to one of our own messages counted as
 * "to me" (isReplyToMe), but (a) a reply to Blue's or Raziel's message meant nothing to routing, and
 * (b) the model never saw WHICH message was replied to, so a reply three messages back was answered
 * as if it continued the newest line.
 *
 * Two uses, both from one resolved target:
 *   - replyTarget(): who wrote the referenced message -- this companion, a sibling, Raziel, Blue (PK
 *     proxies included, through the roster), Sol, another bot, or unknown. Unknown is NEVER read as
 *     human: a roster miss must not silence the triad.
 *   - replyContextLine(): the one line prefixed to the LIVE user turn so the model sees what was
 *     answered. Never written to STM or the gates' text (effectiveContent stays as it was).
 *
 * The rule that a reply to the other human is for the humans lives in human-address.ts (Rule 2b),
 * fed from replyTarget(), behind REPLY_HUMAN_GATE (off | shadow | on, default shadow).
 */

import type { CompanionId } from "./types.js";

export type ReplyAuthor =
  | { kind: "self" }
  | { kind: "companion"; companion: CompanionId }
  | { kind: "human"; side: "raziel" | "blue" }
  | { kind: "sol" }
  | { kind: "bot" }
  | { kind: "unknown" };

export interface ReplyTarget {
  messageId: string;
  author: ReplyAuthor;
  /** Display name as Discord shows it (member name for a PK proxy). */
  authorName: string;
  content: string;
}

/** The parts of a discord.js Message this module reads, so tests can pass plain objects. */
export interface RefMessageLike {
  id: string;
  content: string;
  webhookId?: string | null;
  author: { id: string; bot: boolean; username: string; globalName?: string | null };
  member?: { displayName?: string | null } | null;
}

export interface ReplyResolveDeps {
  selfCompanion: CompanionId;
  /** Discord user id -> companion, for the three companion bots. */
  botIdCompanion: Record<string, CompanionId | undefined>;
  ownerDiscordId?: string | undefined;
  blueDiscordId?: string | undefined;
  solWebhookId: string | null;
  roster: { identify(name: string | null | undefined): { isOwner: boolean } | null } | null;
}

/** Who wrote the referenced message. Precedence: Sol, companion, other bot, owner/Blue id, PK roster. */
export function classifyReplyAuthor(ref: RefMessageLike, d: ReplyResolveDeps): ReplyAuthor {
  if (d.solWebhookId && ref.webhookId && ref.webhookId === d.solWebhookId) return { kind: "sol" };
  if (!ref.webhookId) {
    const c = d.botIdCompanion[ref.author.id];
    if (c) return c === d.selfCompanion ? { kind: "self" } : { kind: "companion", companion: c };
    if (ref.author.bot) return { kind: "bot" };
    if (d.ownerDiscordId && ref.author.id === d.ownerDiscordId) return { kind: "human", side: "raziel" };
    if (d.blueDiscordId && ref.author.id === d.blueDiscordId) return { kind: "human", side: "blue" };
    return { kind: "unknown" };
  }
  const member = d.roster?.identify(ref.author.username);
  if (member) return { kind: "human", side: member.isOwner ? "raziel" : "blue" };
  return { kind: "unknown" };
}

/**
 * Resolve the message a reply points at. Reads the discord.js cache first (a reply's referenced
 * message usually arrives with it), then one fetch. A deleted or unreadable target is null: the
 * turn proceeds exactly as it did before this module.
 */
export async function replyTarget(
  refId: string | null | undefined,
  channel: { messages: { cache?: { get(id: string): RefMessageLike | undefined }; fetch(id: string): Promise<RefMessageLike> } },
  d: ReplyResolveDeps,
): Promise<ReplyTarget | null> {
  if (!refId) return null;
  let ref: RefMessageLike | undefined = channel.messages.cache?.get(refId);
  if (!ref) {
    try { ref = await channel.messages.fetch(refId); } catch { return null; }
  }
  if (!ref) return null;
  const authorName = ref.member?.displayName ?? ref.author.globalName ?? ref.author.username;
  return { messageId: ref.id, author: classifyReplyAuthor(ref, d), authorName: cleanName(authorName), content: ref.content ?? "" };
}

const SNIPPET_CHARS = 160;
const COMPANION_NAME: Record<CompanionId, string> = { drevan: "Drevan", cypher: "Cypher", gaia: "Gaia" };

/** PK names carry tags ("Corbin || 🍂"); the model needs the name, not the decoration. */
function cleanName(n: string): string {
  return n.replace(/\s*\|\|.*$/, "").trim() || n;
}

/**
 * The line the model sees before the live turn: what this message is answering. Quotes are single so
 * the snippet never closes the surrounding quote. Null when there is nothing worth saying (no target,
 * or an empty referenced message such as an image-only post).
 */
export function replyContextLine(t: ReplyTarget | null): string | null {
  if (!t) return null;
  const snip = t.content.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  if (!snip) return null;
  const clipped = snip.length > SNIPPET_CHARS ? snip.slice(0, SNIPPET_CHARS - 1).trimEnd() + "…" : snip;
  const whose =
    t.author.kind === "self" ? "your message"
    : t.author.kind === "companion" ? `${COMPANION_NAME[t.author.companion]}'s message`
    : t.author.kind === "human" ? `${t.author.side === "raziel" ? "Raziel" : "Blue"}'s message (${t.authorName})`
    : `${t.authorName}'s message`;
  return `(replying to ${whose}: "${clipped}")`;
}

/** The human side a reply points at, or null (a companion, Sol, a bot, unknown or no reply). */
export function replyToHumanSide(t: ReplyTarget | null): "raziel" | "blue" | null {
  return t && t.author.kind === "human" ? t.author.side : null;
}

export type ReplyHumanGateMode = "off" | "shadow" | "on";

/** REPLY_HUMAN_GATE: off | shadow | on. Code default `shadow` (a default living only in the pm2
 *  ecosystem file once went silently off, facts-pick.ts:64). Garbage falls to shadow. */
export function replyHumanGateMode(env: Record<string, string | undefined> = process.env): ReplyHumanGateMode {
  const v = String(env["REPLY_HUMAN_GATE"] ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}
