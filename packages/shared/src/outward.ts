// Outward grounding for autonomous channel speech (metronome heartbeats, commons seeds).
//
// 2026-06-08 outward mandate: the system is the loom, not the subject. Seed-gen got the
// constraint on 6/9; this module closes the same loop for the swarm/metronome layer, whose
// only prompt context is the triad's own recent output (Gaia's 6/10 flag: "the worker there
// is still seeding from its own output").
//
// Canonical INWARD_RE lives here; the autonomous worker's seed-gen imports it from shared.

import type { InferenceAdapter } from "./inference.js";
import type { ChatMessage } from "./types.js";

/** System-vocabulary detector. A hit means the speech is about the loom, not the world. */
export const INWARD_RE = /\b(halseth|soma|basins?|drift|ratif\w*|orient|swarm|autonomous[- ]time|companion[- ](state|class|note)|growth[- ]journal|librarian|webmind|second[- ]brain|substrate)\b/i;

/** Appended to every channel-bound autonomous generation. */
export const OUTWARD_NUDGE =
  "Ground this in the world, not the system. Do not write about the system's own machinery " +
  "(basins, soma, drift, seals, ratification, the swarm, the loom). If your context holds " +
  "forage finds or things you have been exploring, draw on those. Subject matter comes from " +
  "outside: the world, the work, Raziel's actual day.";

const RETRY_NUDGE =
  "Your draft referenced the system's internal machinery. Rewrite it entirely outward-facing: " +
  "no system vocabulary, no reference to your own pipelines or state.";

/**
 * Generate with the outward nudge appended; if the draft trips INWARD_RE, retry once with
 * the rejected draft in-context, and drop (null) if it is still inward. Silence beats echo.
 */
export async function generateOutward(
  inference: InferenceAdapter,
  systemPrompt: string,
  userContent: string,
  companionId: string,
  label: string,
): Promise<string | null> {
  const seed: ChatMessage = { role: "user", content: `${userContent}\n\n${OUTWARD_NUDGE}` };
  let msg = await inference.generate(systemPrompt, [seed]);
  if (msg && INWARD_RE.test(msg)) {
    console.warn(`[${companionId}/${label}] inward echo detected, retrying once`);
    msg = await inference.generate(systemPrompt, [
      seed,
      { role: "assistant", content: msg },
      { role: "user", content: RETRY_NUDGE },
    ]);
    if (msg && INWARD_RE.test(msg)) {
      console.warn(`[${companionId}/${label}] still inward after retry, dropping`);
      return null;
    }
  }
  return msg;
}
