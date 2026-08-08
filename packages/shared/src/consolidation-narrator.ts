import { readFileSync, statSync } from "node:fs";
import type { InferenceAdapter } from "./inference.js";
import { DeepSeekAdapter } from "./inference.js";

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

/** Env var holding each companion's identity file path (already set on the VPS for the worker). */
const IDENTITY_ENV: Record<string, string> = {
  cypher: "CYPHER_IDENTITY_PATH",
  drevan: "DREVAN_IDENTITY_PATH",
  gaia: "GAIA_IDENTITY_PATH",
};

/**
 * mtime-keyed cache. Editing an identity file takes effect on the next consolidation with no
 * restart and no cache-busting step to remember -- the same self-healing requirement that chose the
 * whole file over a slice. `statSync` per call is trivial next to a network round trip.
 */
const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

/**
 * Read a companion's identity file, cached against its mtime+size.
 * Returns null (never throws) if the path is unset or unreadable, so the caller can fall back.
 */
export function loadIdentity(companionId: string): string | null {
  const envVar = IDENTITY_ENV[companionId];
  if (!envVar) {
    console.warn(`[narrator] ${companionId}: no identity env var mapped`);
    return null;
  }
  const path = process.env[envVar]?.trim();
  if (!path) {
    console.warn(`[narrator] ${companionId}: ${envVar} is unset -- cannot build voice preamble`);
    return null;
  }
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(path, "utf8");
    // An identity file that reads as near-empty is a broken deploy, not a terse companion. Writing
    // handoffs in no voice at all is worse than paying for the Hermes path, so refuse it.
    if (text.trim().length < 500) {
      console.error(
        `[narrator] ${companionId}: identity file ${path} is only ${text.trim().length} chars -- ` +
        `refusing to narrate in no voice; falling back`,
      );
      return null;
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
    console.log(`[narrator] ${companionId}: loaded identity (${text.length} chars) from ${path}`);
    return text;
  } catch (e) {
    console.error(`[narrator] ${companionId}: cannot read ${envVar}=${path}`, e);
    return null;
  }
}

/** The system prompt for a consolidation call: full identity + the one-shot frame. */
export function buildNarratorPrompt(companionId: string): string | null {
  const identity = loadIdentity(companionId);
  return identity === null ? null : identity + ONE_SHOT_FRAME;
}

/**
 * Build the narrator adapter, or null when it cannot be built (no DeepSeek key).
 *
 * Deliberately a DeepSeekAdapter and not `buildAdapter`: the bots run INFERENCE_MODE=hermes, so
 * every `buildAdapter` call returns the Hermes adapter by design (`forceHermes`), which is the
 * exact path this exists to avoid. Going through DeepSeekAdapter also inherits
 * DEEPSEEK_REASONING_HEADROOM -- v4-flash reasons, reasoning is billed against `max_tokens`, and a
 * bare ceiling returns an EMPTY string (hit while measuring: 1024 completion tokens, all of them
 * reasoning, zero content).
 */
export function createNarrator(): InferenceAdapter | null {
  const key = process.env["DEEPSEEK_API_KEY"]?.trim();
  if (!key) {
    console.warn(
      "[narrator] DEEPSEEK_API_KEY unset -- consolidation will fall back to the Hermes agent path " +
      "(~44.6k prompt tokens/call instead of ~7.7k cold / ~200 warm)",
    );
    return null;
  }
  return new DeepSeekAdapter(key);
}
