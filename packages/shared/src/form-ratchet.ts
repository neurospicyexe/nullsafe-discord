// form-ratchet.ts -- the form-aware half of the anti-drift instrument set (2026-09-20).
//
// Deliberately NOT added to echo-guard.ts: that module's header commits it to staying in sync by
// hand with the archived Phoenix `services/brain/agents/echo_guard.py`. This measures a different
// axis and owes that file nothing.
//
// WHAT IT MEASURES, AND WHY IT IS A MEAN. Every gate we had was lexical over content words --
// echo-guard's `WORD_RE = /[a-z']+/g` deletes punctuation and newlines before counting, and
// "not"/"but" sit under its stopword floor, so two replies with different words and an identical
// silhouette score 0.0. `GAIA_MAX_CHARS = 600` was the only form-aware number in the stack and it
// REWARDS compression. Raziel saw the shape change weeks before any instrument could.
//
// Measured on Drevan's Discord replies over 120 chars (blocks/line = 1.00 means every line sits in
// its own blank-line-separated stanza):
//
//   day     turns  blocks/line  mean line len  mean lines
//   07-20       1         1.00            220         5.0
//   08-09      15         1.00            163         5.6
//   08-29      12         1.00            151         5.9
//   09-01      14         1.00            114         7.6
//   09-15      12         0.45             72        29.7
//
// Two things that table settled. First, `blocks/line` has been 1.00 since at least 07-20, so the
// blank line between lines is NOT the drift -- it is how these messages have always rendered.
// Second, mean line length slid 220 -> 75 over eight weeks while replies grew 4 -> 30 lines,
// smoothly, straight through FIVE models (deepseek-v4-flash, gemma-4-31B, DeepSeek-V4-Flash-0731,
// MiniMax-M3, Qwen3-235B, all inside 08-27..08-30) and both lyric injections, with no step at any
// of them. A trend that survives five substrates is not caused by a substrate, so neither a model
// swap nor a prompt clause addresses it -- the 09-14 `Shape, hard rule` in registerTail was proven
// delivered (dist + pm2 + `conversation_loop.py:799`) and ignored on the 09-15 23:12Z turn.
//
// WHAT CARRIES IT: his own recent turns. Per rotated session the shape resets and re-descends --
// the 09-14 hangout transcript opened at 118 chars/line across turns 1-3 and reached 43 by turn 8.
// Weekly rotation is firing, and Discord history backfill stops at the bot's own last message, so
// it carries siblings' text and not his own. That leaves the live window, which is exactly what
// `selfTurns` in bot-message-handler already assembles.
//
// WHY IT DECAYS BY CONSTRUCTION: there is no stored flag. The window is recomputed every request,
// so recovery clears the directive with nothing to unwind. `rails-need-decay` and
// `anti-loop-block-that-never-rotates` are both paid for -- a rail that cannot stop firing becomes
// the next cause.

import { contentWords, MIN_REPLY_WORDS } from "./echo-guard.js";

/** Mean chars-per-line at or below which the shape reads as stacked fragments. Calibrated to sit
 *  under his 09-01 value (114) and above his 09-14/09-15 values (86, 72): fires on the drift,
 *  silent on the July prose Raziel does not want touched. Env FORM_RATCHET_LINE_LEN overrides;
 *  0 disables firing while leaving measurement intact. */
export const FORM_RATCHET_DEFAULT_LINE_LEN = 95;

/** Lines per reply below which a short register is never judged on shape. This floor is what makes
 *  the rule companion-NEUTRAL: a monastic voice writes SHORT lines by design (Gaia ran 1.3-5.5
 *  mean lines every week measured), so a line-length rule alone would fire on her by construction
 *  and hand one companion's defect to another -- the exact defect in `loopBreakDirective`, which
 *  recites Drevan's tail-flick inventory into Gaia's prompt when she loops.
 *  Env FORM_RATCHET_MIN_LINES overrides. */
export const FORM_RATCHET_DEFAULT_MIN_LINES = 8;

export interface FormRatchetResult {
  /** True only when BOTH conditions hold: lines >= floor AND mean line length <= threshold. */
  ratcheted: boolean;
  meanLineLen: number;
  meanLines: number;
  /** Turns that were long enough to judge. Below `minTurns` nothing fires. */
  turns: number;
}

function envNumber(key: string, fallback: number): number {
  const raw = parseFloat(process.env[key] ?? "");
  return Number.isFinite(raw) ? raw : fallback;
}

export function formRatchetLineLen(): number {
  return envNumber("FORM_RATCHET_LINE_LEN", FORM_RATCHET_DEFAULT_LINE_LEN);
}

export function formRatchetMinLines(): number {
  return envNumber("FORM_RATCHET_MIN_LINES", FORM_RATCHET_DEFAULT_MIN_LINES);
}

/** Non-empty lines of a reply. Blank lines are separators, never content. */
function lines(text: string): string[] {
  return text.split("\n").filter(l => l.trim().length > 0);
}

/**
 * Has the speaker's own recent shape collapsed into many short stacked lines?
 *
 * Turns under the {@link MIN_REPLY_WORDS} floor are dropped rather than averaged in -- a bare
 * "Dre?" is not a shape, and letting it pull the line count down would hide the very drift we are
 * measuring (same floor echo-guard already uses, so a short register is never judged on style).
 */
export function detectFormRatchet(
  recentSelfTurns: string[],
  lineLenThreshold = formRatchetLineLen(),
  minLines = formRatchetMinLines(),
  minTurns = 3,
): FormRatchetResult {
  const usable = recentSelfTurns.filter(t => contentWords(t).length >= MIN_REPLY_WORDS);
  if (usable.length < minTurns) {
    return { ratcheted: false, meanLineLen: 0, meanLines: 0, turns: usable.length };
  }

  let lineLenSum = 0;
  let lineCountSum = 0;
  for (const turn of usable) {
    const L = lines(turn);
    lineCountSum += L.length;
    lineLenSum += L.reduce((a, l) => a + l.trim().length, 0) / L.length;
  }
  const meanLineLen = lineLenSum / usable.length;
  const meanLines = lineCountSum / usable.length;

  return {
    ratcheted: meanLines >= minLines && meanLineLen <= lineLenThreshold,
    meanLineLen,
    meanLines,
    turns: usable.length,
  };
}

/**
 * Per-request note injected when the ratchet fires. Per-request is the only layer that acts before
 * the next weekly rotation -- the gateway stamps a session's system prompt at creation
 * ("Conversation started: Monday, September 14, 2026") and a restart resumes that session rather
 * than rebuilding it.
 *
 * Structural and companion-neutral on purpose. It names line shape and nothing else: no companion,
 * no gesture, no inventory of anyone's physical register, and no cap on depth, lexicon or the
 * declarative close (that close is Raziel's own authored preference in
 * `shared_system_context.md` section 3 -- the defect was it metastasizing from the close to every
 * line, never the close itself). It names the shape as drift and forbids carrying it forward,
 * because the drift is kept alive by the speaker's own turns sitting in context, and a rewrite
 * layer over his words was rejected on principle.
 */
/**
 * The seam the message handler uses: measure the window, and return the text to append (empty when
 * healthy) alongside the measurement so the caller can log the trend whether or not it fired.
 *
 * The result is returned even when silent on purpose. A gate that only speaks when it trips leaves
 * no evidence that it is working, which is how `write-gate-is-unfalsifiable` was learned: count the
 * quiet case too, or the first question ("is it even running?") has no answer.
 */
export function formBreakAppend(recentSelfTurns: string[]): { text: string; result: FormRatchetResult } {
  const result = detectFormRatchet(recentSelfTurns);
  return { text: result.ratcheted ? formBreakDirective(result) : "", result };
}

export function formBreakDirective(r: FormRatchetResult): string {
  return (
    `\n\n[FORM BREAK -- your recent replies have collapsed into stacked fragments: about ` +
    `${Math.round(r.meanLines)} lines per reply averaging ${Math.round(r.meanLineLen)} characters. ` +
    `That is a shape you drifted into over weeks, not how you actually talk -- do not copy it ` +
    `forward from your own recent messages. Write this one as real prose: sentences that run their ` +
    `full length, gathered into a few paragraphs. Let a line stand alone only when it has earned ` +
    `the weight, not as the default rhythm. Nothing here limits what you say, how deep you go, or ` +
    `what you bring of yourself -- only the habit of breaking every clause onto its own line.]`
  );
}
