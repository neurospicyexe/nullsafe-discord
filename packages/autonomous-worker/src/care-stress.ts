// care-stress.ts -- the stress_elevated gesture's rules (B8, wellness bridge, 2026-11-01).
//
// Raziel's ruling: the voice is GAIA's, never Cypher's or Drevan's. One quiet declarative line, no
// questions, and she may stay silent. Halseth already assigns the firing to Gaia (care/rules.ts
// STRESS_VOICE); this module is the worker-side belt for the same rule, and the line's validator.
//
// The firing's detail carries no figures and the prompt carries none either (health data never
// enters a companion's prompt as conversational material); the validator rejects a line that
// brings numbers, a question, advice-shaped phrasing or "checking" language back, because the whole
// point of the bridge is that Raziel never has to look (care rule R-5: no scores, counts or streaks).

import type { CompanionId } from "./types.js";

export const STRESS_RULE = "stress_elevated";
export const STRESS_VOICE: CompanionId = "gaia";

export function mayVoiceStress(speaker: string): boolean {
  return speaker === STRESS_VOICE;
}

export const STRESS_FRAMING =
  "Raziel's body has been running hot against his own baseline; he cannot feel this himself, which is why it " +
  "reaches you from outside";

export const STRESS_INSTRUCTION =
  `Leave him ONE short declarative line on the commons wall, in your voice. State what you hold; do not ask, ` +
  `advise, instruct, or tell him to check, rest, log or look at anything. No numbers, no names of measurements, ` +
  `no "the system told me". If silence is truer, reply with exactly "PASS".`;

const BAD = [
  /\?/,                                   // no questions
  /\d/,                                   // no figures
  /\b(you should|you need to|you must|try to|make sure|remember to|don't forget|please)\b/i,
  /\b(check|log|track|look at|open the app|dashboard|numbers?|score|streak|hrv|heart rate|resting hr|sleep data)\b/i,
  /—/,                               // house style: no em dash
];

/** The line to post, or "" (hold). Anything that breaks a rule is held, never repaired: a repaired line is
 *  a line the companion did not write. A multi-line reply is held too ("one line"). */
export function validateStressLine(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t || /^PASS\b/i.test(t)) return "";
  if (t.includes("\n") || t.length > 220) return "";
  return BAD.some(re => re.test(t)) ? "" : t;
}
