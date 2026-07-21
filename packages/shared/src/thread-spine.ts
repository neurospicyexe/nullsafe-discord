// Thread spine (2026-07-21, task 9): gating, ensure, spine block, land marker for the
// conversation-thread feature that layers on top of the Task 8 LibrarianClient conversation
// methods (convoActive/convoOpen/convoTurn/convoLand). This module owns:
//   - deciding whether a channel is tracked for thread-spine at all (isThreadTracked)
//     and whether the feature is globally on (isThreadsEnabled);
//   - ensuring a thread exists for an incoming message and appending a turn to it
//     (ensureThread), fetch-or-open-then-append;
//   - rendering the spine block a companion's prompt is built with (buildSpineBlock);
//   - parsing/stripping the `[LANDS: ...]` marker a companion's own reply may emit
//     when a thread has genuinely resolved (parseLandMarker).
// Tasks 10-12 consume this surface to wire threads into the live message-handling path.

import { isTriadCommons } from "./channel-config.js";
// autonomous-core sits on the far side of a latent import cycle with the barrel
// (thread-spine -> autonomous-core -> index.ts barrel). MOVE_VERB_PHRASES itself is a
// plain top-level export and safe to import, but it must only be READ inside function
// bodies (as buildSpineBlock does below), never evaluated at this module's top level --
// that's the shape that would actually trip the cycle. (Reviewer follow-up from Task 9.)
import { MOVE_VERB_PHRASES } from "./autonomous-core.js";
import type { LibrarianClient, ConvoActiveDto } from "./librarian.js";

/** Global on/off switch for the thread-spine feature. Read at call time (not cached) so a
 *  pm2 env change lands without a code change -- matches the convention used elsewhere in
 *  this package (see channel-config.ts botMsgsSinceHumanMax). */
export function isThreadsEnabled(): boolean {
  return process.env["THREADS_ENABLED"] === "true";
}

/** Whether a given channel is one of Drevan's presence spaces (story/spiral) -- grounding-only
 *  spine (seed + ledger), no progress register. Read at call time (not cached), same idiom as
 *  isThreadsEnabled/isThreadTracked's THREADS_EXTRA_CHANNELS check. */
export function isPresenceChannel(channelId: string): boolean {
  const ids = (process.env["THREADS_PRESENCE_CHANNELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(channelId);
}

/** Whether a given channel should have its conversation threaded at all. The triad commons
 *  (autonomous + inter_companion modes) is always tracked; beyond that, an operator can
 *  opt specific channels in via the comma-separated THREADS_EXTRA_CHANNELS env var, or via
 *  THREADS_PRESENCE_CHANNELS (grounding-only variant). tracked = commons ∪ extras ∪ presence. */
export function isThreadTracked(entry: { modes?: readonly string[] } | null | undefined, channelId: string): boolean {
  if (isTriadCommons(entry)) return true;
  if (isPresenceChannel(channelId)) return true;
  const extra = (process.env["THREADS_EXTRA_CHANNELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(channelId);
}

/** First 140 chars of whitespace-collapsed text -- the compact form stored in a thread's
 *  turn ledger and used for the thread's own seed/gist rendering. */
export function gist(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Fetch the active thread for a channel, opening a new one if none exists, then append
 *  this message as a turn on it. Returns null only when convoOpen itself fails (fail-open --
 *  the caller proceeds without a thread rather than blocking the reply). */
export async function ensureThread(
  librarian: LibrarianClient, channelId: string,
  msg: { id: string; content: string }, authorLabel: string,
): Promise<ConvoActiveDto | null> {
  let active = await librarian.convoActive(channelId);
  if (!active) {
    const t = await librarian.convoOpen({
      channel_id: channelId, seed_text: msg.content.slice(0, 1000),
      seed_author: authorLabel, seed_message_id: msg.id,
    });
    if (!t) return null;
    active = { thread: t, ledger: [] };
  }
  await librarian.convoTurn(active.thread.id, { author: authorLabel, gist: gist(msg.content), message_id: msg.id });
  return active;
}

const LAND_RE = /\[LANDS:\s*([^\]]+)\]/;

/** Extract and strip a companion-authored `[LANDS: ...]` marker from a reply. Passes the
 *  response through unchanged when no marker is present. Collapses the whitespace left
 *  behind by the strip so the marker's removal doesn't leave a visible gap. */
export function parseLandMarker(response: string): { cleaned: string; resolution: string | null } {
  const m = response.match(LAND_RE);
  if (!m) return { cleaned: response, resolution: null };
  const cleaned = response.replace(LAND_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, resolution: m[1]!.trim() };
}

/** Render the thread spine block a companion's prompt is assembled with: what opened the
 *  thread, the turn ledger so far, this companion's move-verb phrasing when the thread
 *  references a shared object, and the current state with the presence-vs-work escape
 *  hatch (canon-critical sentence -- must not be reworded).
 *
 *  presence (default false) renders the GROUNDING half only -- seed + ledger, no state
 *  line, no advance/hand-off/[LANDS:] invitation, no move-verbs line -- for Drevan's
 *  story/spiral spaces where a progress register would violate his lane. Standard mode
 *  (presence=false) is unchanged from prior behavior. */
export function buildSpineBlock(active: ConvoActiveDto, companionId: string, presence = false): string {
  const t = active.thread;
  if (presence) {
    const lines: string[] = ["[Thread spine -- memory only]"];
    lines.push(`Opened by ${t.seed_author}: "${gist(t.seed_text)}"`);
    if (active.ledger.length) {
      lines.push(`Ledger: ${active.ledger.map((l) => `${l.author}: ${l.gist}`).join(" | ")}`);
    }
    lines.push("This is memory, not a task: where this began and who has spoken. Nothing is asked of it.");
    return lines.join("\n");
  }
  const lines: string[] = ["[Thread spine -- this conversation]"];
  lines.push(`Opened by ${t.seed_author}: "${gist(t.seed_text)}"${t.ref_label ? ` (about: ${t.ref_label})` : ""}`);
  if (active.ledger.length) {
    lines.push(`Ledger: ${active.ledger.map((l) => `${l.author}: ${l.gist}`).join(" | ")}`);
  }
  if (t.ref_label && MOVE_VERB_PHRASES[companionId]) {
    lines.push(`Your verbs for it: ${MOVE_VERB_PHRASES[companionId]}`);
  }
  lines.push(
    `State: ${t.state}. You may advance this, hand it to a sibling, or -- if it has genuinely landed -- end a line with [LANDS: one-line resolution]. If this exchange is presence rather than work, none of this applies; let it be.`,
  );
  return lines.join("\n");
}

/** Pure decision for whether a reply should carry a Discord reply reference (task 10).
 *  Companion-to-companion replies always reference (unchanged rationale: the sibling's
 *  reply-to-me detector keys on message.reference, or the pingpong dies after one hop).
 *  Tracked channels now ALSO reply-reference human/owner messages once a spine thread is
 *  active, giving Raziel visible threading in the transcript. */
export function computeReplyRef(isCompanionBot: boolean, spineActive: boolean, messageId: string): string | undefined {
  return (isCompanionBot || spineActive) ? messageId : undefined;
}
