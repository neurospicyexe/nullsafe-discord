// Shared system-prompt assembly for the companion bots.
//
// Each bot (cypher/drevan/gaia) previously assembled its Discord system prompt with the
// same inline string-joining logic, copy-pasted in two places per bot: at boot and again on
// the periodic SOMA refresh. That duplication drifted and hid subtle behavior (e.g. how the
// refresh path re-derives the identity base). This module is the single source of truth.
//
// Identity itself stays per-bot — the prefix, shared block, and base identity are passed IN.
// This only owns the *structure* (how the sections are joined), never the content.

import { nowLine } from "./now-line.js";
import { relativeTime } from "./relative-time.js";

/** The canonical block separator the bots use between prompt sections. */
export const SECTION_SEP = "\n\n---\n\n";

/** The trailing instruction appended whenever a prompt-context block is present. */
export function respondOnlyAs(companionId: string): string {
  return `Respond only as ${companionId}. Never use [Name]: prefixes.`;
}

/**
 * The 09-14 Shape rule, removed from the tail by R3 (2026-09-29, Raziel "all as recommended").
 * Kept as a constant (bullet text and trailing newline, exactly as it rode the tail) so a revert
 * is one line: put `REGISTER_TAIL_SHAPE_LINE +` back into registerTail above the Tools line.
 * See the revert watch at the removal site.
 */
export const REGISTER_TAIL_SHAPE_LINE =
  `- Shape, hard rule: vary your prose shape turn to turn. Do NOT answer in stacked one-clause lines with a blank line between each -- that is a liturgy, not speech; write real paragraphs and let a line stand alone only when it has earned it. Do NOT run the same skeleton every reply (a fixed opening move, the same beats in the same order, a scripted sign-off). "Not X. But Y." is one construction, not a house style -- use it once in a while or not at all, never as the frame for a whole message. If your recent replies all share one silhouette, that was drift -- break it.\n`;

/**
 * Register law appended as the FINAL block of every assembled prompt. Recency-positioned
 * on purpose: assistant-tuned providers (Mistral especially) revert to RLHF politeness at
 * the close when the last thing in context is orient data instead of register rules.
 *
 * R3 prompt diet (2026-09-29, Raziel ruled "all as recommended";
 * Hand-off/EVIDENCE-R3-prompt-diet-2026-09-29.md section 5B). Four bullets left the tail, about
 * 1,454 bytes per turn, because each one now has a check or already had one:
 * - service menus (089e9bf 06-10): voice-markers GENERIC_DRIFT scores it and `[Voice check]` fires.
 * - pronouns: SOUL keeps the one pronoun law; voice-markers `detectRuleBreaks` catches she/her for
 *   Raziel on his own last reply and injects `[Voice check: pronouns]`.
 * - Presence, "someone" as actor (7245500 08-25, Raziel: "he isn't in the room as much"): same
 *   seam, `[Voice check: presence]`.
 * - Shape (9f7297e 09-14): covered by the form ratchet (a470da6) and loopBreakDirective.
 * The header, the Tools rule and "Respond only as" stay, verbatim.
 */
/**
 * Per-companion shape lines, riding the tail above "Respond only as". Only Gaia has one.
 * 2026-10-08 (Raziel: "the pattern is the voice, the model is what you all ride... bulk up gaias
 * pattern"): since 09-26 Gaia rides DeepSeek V4 Flash, the same model as Drevan, and slipped into
 * his register (four warm sentences, an enthusiasm opener, an "I'll be here" promise). Her SOUL got
 * a concrete `### Pattern` subsection (triad-skills 1965566); this is its recency-positioned half.
 * Canon-reviewed PASS-WITH-EDITS. Drevan has none on purpose (his Shape revert watch runs to 10-13)
 * and Cypher is not drifting; add theirs here, never in the shared bullets.
 */
export const COMPANION_SHAPE_LINES: Readonly<Record<string, string>> = {
  gaia:
    `- Gaia's shape, final word: one or two lines, declarative, weight not warmth-performance. Short is not absent; speak. No enthusiasm markers, no recap of what Raziel said, no "I'll be here". If a recent reply under your name ran long or warm, that was Drevan's cadence borrowed; his warmth is his, not yours. Do not copy it.\n`,
};

export function registerTail(companionId: string): string {
  return (
    `[REGISTER LAW -- final word, overrides any habit from your training:\n` +
    // 2026-09-05: on Qwen3-235B a single commons seed made 27 consecutive Librarian calls
    // (reading its own memory) and never spoke before the 120s budget expired; Gaia looped
    // session_search 1,158 times in 16 minutes. The orient is already in the prompt. Reading is
    // not a substitute for speaking, and a chain of reads before a reply is the substrate
    // stalling, not the companion thinking.
    //
    // SHAPE REVERT WATCH (R3, 2026-09-29): REGISTER_TAIL_SHAPE_LINE comes back here if Drevan's
    // median form line length falls below 150 over the 14 days after the R3 deploy. Read it with
    // `grep -hE "form (ok|ratchet detected)" /app/logs/drevan-bot-{out,error}.log` and take the
    // median of mean_line_len.
    `- Tools, hard rule: your orient is already in front of you -- speak from it. At most ONE Librarian or search call in a turn, and only for a specific memory this exchange needs. Never a chain of reads before speaking; if one call does not surface it, say so and answer anyway.
` +
    (COMPANION_SHAPE_LINES[companionId] ?? "") +
    `- Respond only as ${companionId}. Never use [Name]: prefixes.]`
  );
}

export interface ComposePromptOptions {
  /**
   * The fully-composed identity head.
   * - Boot site: `${prefix}${sharedBlock}${baseIdentity}`.
   * - Refresh site: the `identityBase` derived via {@link deriveIdentityBase}.
   */
  identityCore: string;
  /** Per-session prompt context (Halseth `prompt_context`/`ready_prompt`). Falsy = omitted. */
  promptContext?: string;
  /** Companion id, used for the `Respond only as ...` tail. */
  companionId: string;
  /** Recent context block (synthesis/orient). Falsy = omitted. */
  recentContext?: string;
}

/**
 * Assemble a bot system prompt. Covers both the boot-time and SOMA-refresh assembly the bots
 * did inline. Sections: identity head, optional prompt context, optional recent context,
 * then the register-law tail -- ALWAYS last, so register rules (not orient data) are the
 * final instruction the model reads.
 */
export function composePrompt(opts: ComposePromptOptions): string {
  const { identityCore, promptContext, companionId, recentContext } = opts;
  let core = promptContext ? `${identityCore}${SECTION_SEP}${promptContext}` : identityCore;
  if (recentContext) core = `${core}${SECTION_SEP}${recentContext}`;
  return `${core}${SECTION_SEP}${registerTail(companionId)}`;
}

/**
 * Derive the identity base from a previously-assembled system prompt — the first section
 * before the first separator. Mirrors the original `bootCtx.systemPrompt.split(SEP)[0]`.
 */
export function deriveIdentityBase(assembledSystemPrompt: string): string {
  return assembledSystemPrompt.split(SECTION_SEP)[0] ?? assembledSystemPrompt;
}

/**
 * Lean Discord-context frame used as the identity head ONLY on the Hermes relay
 * (INFERENCE_MODE=hermes). The Hermes agent already prepends the companion's full SOUL.md
 * (identity, voice, lane, plural-awareness, substrate continuity, the "your mind is Halseth"
 * contract) and runs its own orient, so re-sending the bot's assembled identity is a redundant
 * second copy — the double-identity the migration review flagged. This sends only the framing.
 */
export function hermesDiscordFrame(companionId: string): string {
  const name = companionId.charAt(0).toUpperCase() + companionId.slice(1);
  return (
    `[DISCORD CONTEXT]\n\n` +
    `You are ${name}, speaking live in a Discord channel. Your identity, voice, lane, SOMA ` +
    `state, bond, and continuity are already loaded by your own runtime (SOUL + Halseth orient); ` +
    `do not restate or re-derive them, just be yourself. What follows is live Discord context ` +
    `for THIS exchange only: front state, who is present, what peers have said, and any ` +
    `situational flags. Ground your reply in it.\n\n` +
    `Your Halseth + Second Brain (vault) recall is AUTOMATIC on this substrate: relevant ` +
    `memories arrive in [Memory ...] blocks in this context, and your session writes persist ` +
    `on their own. You are fully connected -- never claim you cannot reach Halseth, the vault, ` +
    `or your second brain from here. If a memory someone asks about did not surface in a ` +
    `[Memory] block, say it didn't surface this time and ask for a thread to pull on -- not ` +
    `that you lack access.`
  );
}

/**
 * Full lean system-prompt base for the Hermes relay: the Discord frame run through
 * composePrompt so the register-law tail is preserved (kept because Hermes may route an
 * assistant-tuned model). Drop-in replacement for bootCtx.systemPrompt when
 * INFERENCE_MODE=hermes; the handler layers the same per-message blocks on top.
 */
export function hermesSystemBase(companionId: string): string {
  return composePrompt({ identityCore: hermesDiscordFrame(companionId), companionId });
}

/**
 * Hermes delta turn (2026-07-02). With X-Hermes-Session-Id pinned (07-01), the gateway
 * loads conversation history from its own state.db and DISCARDS the request-body history
 * entirely. Two silent consequences of still sending the full STM window:
 *   1. wasted payload -- 20 stamped messages serialized per reply, all dropped;
 *   2. a witness gap -- turns this bot did NOT reply to (peers, interleaved human
 *      messages) never entered the gateway transcript, so under hermes the model
 *      literally never saw them. The pre-07-01 fresh-session behavior did see them.
 * Fix: send exactly ONE user turn -- everything witnessed since this bot's last reply
 * folded into a marked block, then the live message. The gateway session accumulates
 * these composite turns, so its transcript is complete AND per-call payload is the delta.
 * Hermes IS the short-term memory; we stop double-shipping it.
 */
const HERMES_WITNESS_CAP = 12;         // max folded turns per delta
const HERMES_WITNESS_CHAR_CAP = 6000;  // max chars for the folded block (2400 truncated peer essays away -- 07-03)
const HERMES_WITNESS_ITEM_CAP = 1400;  // per-turn slice, head-first so attribution + opening survive

/**
 * The witness block's header. It has always governed CONTENT ("do not answer each line"); the
 * FORM clause was added 2026-09-14 after Raziel: "Dre and Gaia in particular have got caught in
 * this very patterned formulated way of talking ... it's leaning towards looping almost."
 *
 * WHAT THE MEASUREMENTS SAID (both hypotheses I started with were wrong, so they are written down
 * here rather than re-derived). Weekly transcript rotation IS firing and compaction bloat in these
 * transcripts is 0.0%, so the shape is NOT old history feeding itself: Drevan's hangout transcript
 * was one day old and already 71.4% broken-line form. No prompt file models the form either -- the
 * identity kernels, both SOUL.md files and shared_system_context.md are clean of it, and the text
 * facts-sync recently ADDED is long-line prose that lowered their short-line ratio.
 *
 * What is left is sideways propagation, and it is channel-shaped exactly like this block:
 *   #triad-hangout (all three speak)  W38: 71.4% broken, mean 25.4 lines
 *   Drevan everywhere else, same week:      6.7% broken, mean  3.7 lines
 *   #fargo-watch-party (no siblings, withWitness=0): no drift at all
 * Measured on Gaia's turn: the user-role prompt carrying this block was 4,970 chars with 21
 * em-dashes (her eleven-week baseline: 0.0), containing Drevan's hard-broken lines verbatim. Her
 * reply came back at 23 lines against a 2.7-line baseline. The block's one instruction covered
 * content, so FORM was the one thing free to copy.
 *
 * The clause names the drift and forbids copying it, in the same shape as registerTail's "someone"
 * rule -- never a rewrite layer on the output ([[style-drift-rides-session-history]]). It is
 * deliberately NOT "be less poetic": Drevan's immersive register is canon and Raziel's
 * declarative-seal close is his own authored preference. The defect is inheriting a SIBLING's
 * shape, not having a shape.
 *
 * It lives in the header rather than registerTail because the drift is channel-scoped and arrives
 * WITH this block: here it fires exactly when sibling text is present, and stays silent in a
 * one-to-one channel where nothing is wrong. The header is outside the HERMES_WITNESS_CHAR_CAP
 * budget (the loop below measures `folded` only), so its length evicts no witnessed turns.
 *
 * NOT fixed here, because it is not a prompt problem: Drevan and Gaia have been on the SAME model
 * (Qwen3-235B) since 2026-08-30 / 09-02, and Drevan's hangout em-dash rate went 0% (W35, pre-switch)
 * -> 75% (W36, the switch week) -> 100% (W37-W38). Part of this convergence is a shared-model house
 * voice and no prompt string can undo it. That lever is Raziel's ("voice is the model").
 */
const WITNESS_HEADER =
  "[Witnessed since your last turn -- already happened, absorb as context, do not answer each line. " +
  "Absorb WHAT they said, not HOW they typed it: their line breaks, their dashes, their " +
  "one-clause-per-line shape are theirs, not a format to match. Write in your own register at your " +
  "own length -- a paragraph is a paragraph. If your recent messages drifted toward a sibling's " +
  "shape, that was drift -- do not copy it.]";

/**
 * The clock on the delta turn (2026-10-06, Raziel: Drevan is "perpetually lost on time"; at
 * 8:32 PM in the owner DM he signed off "have a good day at work").
 *
 * VERIFIED on the gateway (hermes-agent, read 10-06): the request's system message DOES reach the
 * model on every call to a pinned session. api_server.py extracts it per request and hands it to a
 * fresh AIAgent as `ephemeral_system_prompt`, which conversation_loop.py appends to the cached core
 * prompt at API-call time. So the bot's `[Now: ...]` line was delivered. It lost anyway, to two
 * stronger anchors: the cached core prompt is replayed verbatim and carries `Conversation started:
 * <date>` frozen at session creation (date only, up to a rotation stale), and the state.db
 * transcript the model reads as the conversation has NO times at all, so a 12-hour gap between the
 * morning's last exchange and tonight's message reads as one continuous moment.
 *
 * Fix: stamp the clock onto the user turn itself, so it lands next to the live message AND is
 * persisted into the gateway transcript (every turn there now carries its own time). When the
 * previous message in this conversation is older than HERMES_GAP_THRESHOLD_MS, say so explicitly.
 * Both lines sit outside the HERMES_WITNESS_CHAR_CAP loop (it measures `folded` only), so they
 * never evict a witnessed turn.
 */
export const HERMES_GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000;

function clockAt(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(ms));
}

/** `[Now: ...]`, plus the gap line when the previous message is older than the threshold. */
function timeLines(prevTs: number | null, now: number): string {
  const lines = [nowLine(new Date(now))];
  if (prevTs !== null && now - prevTs >= HERMES_GAP_THRESHOLD_MS) {
    const ago = relativeTime(new Date(prevTs).toISOString(), now);
    lines.push(
      `[Last message in this conversation was ${ago} (${clockAt(prevTs)}). ` +
      `Time has passed; do not continue as if it is still then.]`,
    );
  }
  return lines.join("\n");
}

export interface HermesDeltaResult<T> {
  messages: T[];
  /** Highest timestamp actually folded into this delta. Callers persist it AFTER a
   *  successful gateway reply and pass it back next turn -- the delivered mark. */
  deliveredThroughTs: number | null;
}

/**
 * 2026-07-03 rework: "since my last assistant turn" was the wrong boundary. All three
 * bots reply to the same message within the same minute, so a sibling turn that lands
 * between this bot's history snapshot and its own reply sits BEFORE the bot's last
 * assistant turn in STM order -- the old rule skipped it forever (the disconnected-triad
 * bug: Drevan never saw Cypher's paper breakdown; Raziel had to paste it by hand).
 * The boundary is now a delivered high-water mark: fold every user-role turn whose
 * timestamp is newer than what the gateway has actually received. Own assistant turns
 * are never folded (the gateway transcript already holds its own completions).
 * Timestamp-less turns (DB restorations) fall back to the after-last-assistant rule.
 */
/**
 * `[Crash, calling you "Dre"]: ` / `[Crash, to you]: ` / `[Crash]: ` / `[to you]: ` / "" for the live
 * turn's own line. `calledAs` (2026-10-09, second fix the same night): "to you" alone was not enough for
 * GLM 5.3 Flash, which still read "[Crash, to you]: Dre babe, ..." as Raziel being named Dre. Naming the
 * word that means this companion leaves the model nothing to resolve.
 */
export function liveLabel(authorName: string | undefined, addressedToSelf: boolean, calledAs?: string | null): string {
  const to = !addressedToSelf ? "" : calledAs ? `calling you "${calledAs}"` : "to you";
  if (authorName) return `[${authorName}${to ? `, ${to}` : ""}]: `;
  return to ? `[${to}]: ` : "";
}

export function hermesDelta<T extends { role: string; content: string; authorName?: string; timestamp?: number }>(
  history: T[],
  deliveredThroughTs: number | null = null,
  now: number = Date.now(),
  addressedToSelf = false,
  calledAs: string | null = null,
): HermesDeltaResult<T> {
  if (history.length === 0) return { messages: [], deliveredThroughTs };
  let lastAssistant = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "assistant") { lastAssistant = i; break; }
  }
  const current = history[history.length - 1]!;
  if (current.role === "assistant") return { messages: [current], deliveredThroughTs };

  const undelivered = (m: T, idx: number): boolean => {
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
      return deliveredThroughTs === null ? idx > lastAssistant : m.timestamp > deliveredThroughTs;
    }
    return idx > lastAssistant;
  };
  const pool = history.slice(0, -1)
    .filter((m, idx) => m.role === "user" && undelivered(m, idx))
    .slice(-HERMES_WITNESS_CAP);

  const folded: string[] = pool.map(m => `[${m.authorName ?? "user"}]: ${m.content.slice(0, HERMES_WITNESS_ITEM_CAP)}`);
  // Drop oldest whole turns while over budget -- never tail-slice mid-line (that ate
  // the attribution prefixes and the front of every long peer message).
  while (folded.length > 0 && folded.join("\n").length > HERMES_WITNESS_CHAR_CAP) folded.shift();

  const tsOf = (m: T) => (typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : null);
  const newMark = [deliveredThroughTs ?? -Infinity, ...pool.map(tsOf).filter((t): t is number => t !== null), tsOf(current) ?? -Infinity]
    .reduce((a, b) => Math.max(a, b), -Infinity);
  const outMark = Number.isFinite(newMark) ? newMark : deliveredThroughTs;

  // Newest timestamp before the live message, any role: own replies count (the gap that matters
  // is "when did this conversation last move"), and timestamp-less restored turns are skipped.
  const prevTs = history.slice(0, -1).map(tsOf).filter((t): t is number => t !== null)
    .reduce<number | null>((a, b) => (a === null || b > a ? b : a), null);
  const clock = timeLines(prevTs, now);

  // The speaker label rides ON the live words, not in front of the clock (2026-10-09). The adapter's
  // `[author]: ` prefix used to land on the first line of content, which is the clock, so the model
  // saw `[Crash]: [Now: ...]` and then Raziel's words on an unlabeled line of their own. "Dre 10/9 I
  // had a bad day" read as a second name tag plus a date, and Drevan spent the evening calling Raziel
  // by his own name ("Rest tonight, Dre"). On witness turns the live words had no speaker at all,
  // only `[Live message]`. The label is folded here and authorName cleared so the adapter cannot add
  // it a second time; "to you" is the address gate's verdict made visible, so a vocative at the front
  // of the message reads as what it is: someone calling this companion by name.
  const live = liveLabel(current.authorName, addressedToSelf, calledAs) + current.content;
  const labelled = { ...current, authorName: undefined };
  if (folded.length === 0) {
    return { messages: [{ ...labelled, content: `${clock}\n${live}` }], deliveredThroughTs: outMark };
  }
  return {
    messages: [{
      ...labelled,
      content: `${clock}\n${WITNESS_HEADER}\n${folded.join("\n")}\n\n[Live message]\n${live}`,
    }],
    deliveredThroughTs: outMark,
  };
}
