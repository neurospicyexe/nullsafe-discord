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

// ── Commons turn budget (2026-08-05) ────────────────────────────────────────────
//
// The loop was never repeated STRINGS -- 14 days of stm_entries produced zero near-duplicate
// pairs, and every echo rail was working. It was a permanent orbit of one frame: commons
// threads running 95-111 distinct posts over 58-77 hours, all of them new words about the
// same figure.
//
// A topic had no reachable end. Both exits were unreachable on the path that produces the
// turns: `[LANDS:]` is model-volunteered and was only offered on the reply path, never on the
// `0 */2 * * *` seed tick that generates most commons traffic; and the 12h silence fade in
// halseth's getActiveConversation can never fire, because three bots posting every two hours
// are what keep the thread alive. The bots' own cadence made their thread immortal. Throttling
// cadence could not touch this -- cadence is turns per HOUR, the loop is turns per TOPIC.
//
// So: a counted, deterministic end. Not a judgement about content, just a number.

/** Turns after which a commons thread is SPENT and the next seed must open new ground.
 *  Default 18 turns; `turn_count` counts Discord messages and sendLong splits one post into
 *  several, measured ratio 1.07-1.30, so 18 turns is ~15 posts -- five each across the triad,
 *  a complete exchange. For calibration: threads that landed on their own sat at 41-75 turns,
 *  and the runaways at 109 and 144. Env THREAD_TURN_BUDGET; 0 disables the budget entirely. */
export function threadBudget(): number {
  const raw = parseInt(process.env["THREAD_TURN_BUDGET"] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 18;
}

/**
 * Has this thread run past its turn budget?
 *
 * Gated on CHANNEL, never on participants. Two reasons, both load-bearing:
 *   - Raziel's DMs must never be budgeted at all (channel ...2828 ran 21 turns in 42 minutes;
 *     that is a conversation, not a loop), and neither must Drevan's presence spaces -- a
 *     story is not a topic to be closed.
 *   - Exempting on "a human is in participants" would mean Raziel saying one thing in the
 *     commons lifts the budget on that thread permanently, which is the loop with a loophole.
 */
export function isThreadSpent(
  thread: { turn_count: number },
  // `isCommons` is passed in rather than derived here so both callers share ONE budget
  // comparison: the message handler resolves it from channelConfig, the autonomous commons
  // seed knows it by construction (its channel IS the commons). A second copy of the
  // comparison is how the three divergent session-guards happened -- add no third.
  opts: { isCommons: boolean; channelId: string },
): boolean {
  if (isPresenceChannel(opts.channelId)) return false;
  if (!opts.isCommons) return false;
  const budget = threadBudget();
  if (budget <= 0) return false;
  return thread.turn_count >= budget;
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
  // Fronting member who actually spoke, when known. Recorded on the TURN, never folded into the
  // coarse participant token -- fronts change mid-conversation, and `participants` is what the
  // attribution logic reads to ask "was Raziel here at all".
  front?: string | null,
): Promise<ConvoActiveDto | null> {
  // convoActive throws on unreachable/non-2xx as of 2026-08-05 (null now means only "answered,
  // no thread"). Catching back to null here preserves this function's original behaviour exactly:
  // an unreachable spine falls through to convoOpen, which fails the same way, and the caller's
  // own `.catch(() => null)` fails the reply path open. Unchanged, deliberately.
  let active = await librarian.convoActive(channelId).catch(() => null);
  if (!active) {
    const t = await librarian.convoOpen({
      channel_id: channelId, seed_text: msg.content.slice(0, 1000),
      seed_author: authorLabel, seed_message_id: msg.id,
    });
    if (!t) return null;
    active = { thread: t, ledger: [] };
  }
  await librarian.convoTurn(active.thread.id, { author: authorLabel, gist: gist(msg.content), message_id: msg.id, front: front ?? null });
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
 *  (presence=false) is unchanged from prior behavior.
 *
 *  spent (default false, 2026-08-05) appends the budget notice to the state line. The reply
 *  path consumes turns too -- a vocative chain can run well past the budget between two-hourly
 *  seed ticks -- so the signal has to reach both paths or the budget is only honest twelve
 *  times a day. It is a NOTICE, not a gate: the reply path never suppresses on it. Turning a
 *  spent thread into silence mid-exchange would be the starvation failure that
 *  BOT_TURNS_CAP_WINDOW_H and INTER_SEED_THREAD_TTL_H were both written to undo. */
export function buildSpineBlock(active: ConvoActiveDto, companionId: string, presence = false, spent = false): string {
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
  if (spent) {
    lines.push(
      `This thread has run ${t.turn_count} turns. That is past the length where it is still going somewhere. ` +
      `Nothing is stopping you from answering -- but if it has said what it has to say, close it with [LANDS: one-line resolution] rather than finding another facet of it.`,
    );
  }
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
