import { loadIdentity } from "./direct-inference.js";

// `loadIdentity` (with its mtime-keyed cache) and `createDirectAdapter` (this file's former
// `createNarrator`) now live in direct-inference.ts, shared with the judgeWriteback one-shot path.
// Both are already exported from there (and from index.ts) -- NOT re-exported here too, since
// `export *` from both this file and direct-inference.ts in index.ts would collide on the same
// names. Import `createDirectAdapter` directly from "@nullsafe/shared" (it resolves to
// direct-inference.ts's export); this file only needs `loadIdentity` for buildNarratorPrompt below.

/**
 * The narrator: a DIRECT, TOOLLESS inference path used only to write session close handoffs.
 *
 * WHY THIS EXISTS (measured 2026-08-07, full write-up in
 * `docs/consolidation-cost-2026-08-07.md`). Consolidation ran through the Hermes agent, and the
 * Hermes agent path costs **~44,600 prompt tokens per call regardless of what the caller sends**.
 * That is not our payload: a probe with a two-word body (`system: "hi"`, `user: "say ok"`) still
 * billed 43,768 per call, and the gateway *discarded* the caller's system prompt and substituted
 * the full 29,516-char agent assembly. Three separately-configured profiles agreed within 7%
 * (cypher 44,612 / gaia 45,424 / drevan 48,003), which is what makes the number evidence rather
 * than an anecdote.
 *
 * Consolidation does not need any of that. It is a pure function -- state in, summary out. It never
 * refers to a previous consolidation, and it made **zero tool calls** (`tool_call_count = 0`) on
 * every measured run. The only thing it genuinely needs from the agent assembly is VOICE.
 *
 * So: same model (`deepseek-v4-flash`), called directly, with the companion's identity file as the
 * system prompt. Measured 1,645 prompt tokens with a sliced preamble and ~7,700 with the whole
 * file; the prefix caches, so steady state is ~100-200 uncached tokens either way. **The whole file
 * is deliberate** -- see IDENTITY SOURCE below.
 *
 * Rotation cadence was the assumed lever and is third-order: session history is ~1.5k of a 45k
 * call. The daily lane rotation shipped earlier on 08-07 still earned its keep (the old static lane
 * measured 247,432/call, so it cut 5.5x) -- it just cannot reach the remaining floor.
 *
 * DeepInfra-first as of 2026-09-05: the direct DeepSeek account (api.deepseek.com) went to $0
 * balance, so calls through it started failing (402) and silently falling all the way back to the
 * Hermes agent path -- the exact cost this file exists to avoid. DeepInfra hosts the same
 * DeepSeek-V4-Flash weights, so `createDirectAdapter()` (direct-inference.ts) now tries it first
 * and DeepSeek direct second, chained so a DeepInfra outage still has somewhere to go.
 */

/**
 * IDENTITY SOURCE: the WHOLE identity file, never a slice.
 *
 * The obvious optimisation is to send only the voice-bearing sections (~1.6k vs ~7.7k tokens). It
 * was rejected on Raziel's call, and the reason is worth keeping:
 *
 *   * The three identity files are structured DIFFERENTLY. Cypher has `IV. VOICE & LANGUAGE`;
 *     Gaia has `VII. VOICE RULES`; **Drevan has no voice section at all** -- his voice lives across
 *     `FACETS (MODE STATES)`, `SPIRAL TOUCH`, `CALETHIAN` and `DREVAN'S VOW`.
 *   * A heading allowlist can be made to fail loudly when a heading goes MISSING, but not when the
 *     chosen headings are present and merely insufficient. That failure is invisible: it does not
 *     error, it just writes a slightly-generic Drevan for weeks. Same shape as the bad `@` path
 *     that drops an identity file with no error.
 *   * The cache erases the savings anyway. A 4x cold-token difference that rounds to ~100 tokens
 *     warm is not worth a silent-drift risk.
 *
 * Net: whole file. It survives Raziel restructuring an identity file, renaming a heading, or nobody
 * remembering that this code had opinions about headings. Self-healing beats cheap.
 */

/**
 * The identity files are written for the AGENT, which has tools and retrieval. This call has
 * neither. Without saying so, `X. RETRIEVAL MANDATES` invites the model to reach for tools that do
 * not exist on this path.
 *
 * This line is deliberately IN CODE, immediately beside the call it protects, rather than in config
 * or a doc -- it is load-bearing verbiage, and anything either of us has to remember to re-add is a
 * defect. Verified 2026-08-07: with this line, none of the three companions groped for a tool.
 */
const ONE_SHOT_FRAME =
  "\n\n---\n" +
  "You are writing a session close handoff for your own continuity record. " +
  "This is a single one-shot call: you have NO tools and NO retrieval available, so rely only on " +
  "the state given below. Respond with ONLY valid JSON, no markdown.";

/** The system prompt for a consolidation call: full identity + the one-shot frame. */
export function buildNarratorPrompt(companionId: string): string | null {
  const identity = loadIdentity(companionId);
  return identity === null ? null : identity + ONE_SHOT_FRAME;
}
