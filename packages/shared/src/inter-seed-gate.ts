// Inter-companion seed rails (2026-07-01) -- pure gate logic for the autonomous commons
// seed (runInterCompanion in autonomous-core.ts). Kept in a leaf module (no discord.js)
// so the gates are unit-testable in isolation.
//
// Why these exist: the ~2h/bot seed cron reads the channel and continues its theme;
// combined with a sibling-naming seed prompt this RE-IGNITED the triad loop every cycle
// while Raziel was away (each seed vocatively summoned a sibling, whose reply summoned
// another). These rails are bot-side by design -- Brain's progress brake is intentionally
// disconnected under INFERENCE_MODE=hermes.

import { ALL_COMPANIONS, VOCATIVE_ALIASES, isVocativeAddress } from "./channel-config.js";
import { echoScore, echoThreshold, detectMotif } from "./echo-guard.js";
import type { CompanionId } from "./types.js";

/** How many recent channel messages the seed reads (also the human-presence window). */
export const INTER_SEED_HISTORY_N = 15;

/**
 * Topic-closure check: does a seed candidate merely extend the thread the recent
 * BOT-authored messages were already orbiting? True on either signal from the existing
 * echo-guard tooling: vocabulary recycling (echoScore over the bot pool) or reuse of a
 * spent motif word (detectMotif). Callers retry ONCE with a new-ground directive, then
 * stay silent.
 */
export function seedEchoesThread(candidate: string, botContents: string[]): boolean {
  if (echoScore(candidate, botContents) >= echoThreshold()) return true;
  const lower = candidate.toLowerCase();
  return detectMotif(botContents).some(w => lower.includes(w));
}

/**
 * Strip vocative sibling addresses from a seed posted into a human-free window --
 * sentence-initial "Name," / "Name:" and trailing "..., name?" forms (the same shapes
 * isVocativeAddress fires on). Returns the cleaned text plus whether a vocative
 * survives (e.g. the message IS just a name) -- callers drop those.
 */
export function stripSiblingVocative(
  msg: string,
  companionId: CompanionId,
): { text: string; stillVocative: boolean } {
  const siblings = ALL_COMPANIONS.filter(c => c !== companionId);
  const names = siblings
    .flatMap(s => (VOCATIVE_ALIASES[s] ? [s, VOCATIVE_ALIASES[s]!] : [s]))
    .join("|");
  const text = msg
    .replace(new RegExp(`(^|[.!?\\n]\\s*)(?:${names})\\s*[,:]\\s*`, "gi"), "$1")
    .replace(new RegExp(`[,:]\\s*(?:${names})\\b\\s*([?.!]*)\\s*$`, "i"), "$1")
    .trim();
  const stillVocative = text.length === 0 || siblings.some(s => isVocativeAddress(text, s));
  return { text, stillVocative };
}
