// Owner pronoun rule -- the chokepoint for every BACKGROUND writer's system prompt.
//
// WHY THIS EXISTS (2026-09-24): Drevan reported summaries/signal_audit calling Crash "she".
// Prod rows confirmed the pattern was live across discord_session observations, day_distillation,
// and autonomous_exploration notes. The live chat turn was fine -- registerTail
// (prompt-assembly.ts) already carries a pronoun clause and rides every Discord reply -- but every
// BACKGROUND writer (memory judge/writeback, channel-inactive synthesis, mid-session distillation,
// day distillation, the consolidation narrator, and the whole autonomous-worker: signal-audit,
// reflection, reflect, synthesize, explore, dialectic, guardian-resolve, compress, care, council,
// club, siblings, commons-social, seed) builds its OWN system prompt and never saw that clause.
//
// One string, one append function, so there is exactly one place to fix this again instead of the
// ~15 call sites it actually lived at. `withOwnerPronounRule` is idempotent -- it is safe to call
// on a prompt that already carries the rule (e.g. a narrator prompt built from
// `buildNarratorPrompt`, then handed to a caller that wraps again) without doubling the block.
//
// Wording tuned against the live model on 2026-09-24: the first draft made it (a) annotate the
// rule into stored memory ("Crash (also called Raziel, uses he/him or they/them) is...") and
// (b) call Blue "Crash's system member", because Blue sat next to the system-member clause. Hence
// "apply it silently" and Blue named as a separate person.
export const OWNER_PRONOUN_RULE =
  "PRONOUNS (hard rule; apply it silently, never restate it or annotate anyone's pronouns in your output): " +
  "Raziel (also called Crash) uses he/him or they/them -- NEVER she/her. " +
  "The same default applies to Raziel's own system members (his alters/headmates) unless a member has explicitly stated otherwise. " +
  "Everyone else keeps their own pronouns -- Raziel's mother, his partner Blue (a separate person, not a system member), " +
  "Babita, anyone else: use what the source text uses for them.";

/** Append the rule to a system prompt once (idempotent: never doubles it). */
export function withOwnerPronounRule(system: string): string {
  if (system.includes(OWNER_PRONOUN_RULE)) return system;
  const trimmed = system.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n\n${OWNER_PRONOUN_RULE}` : OWNER_PRONOUN_RULE;
}
