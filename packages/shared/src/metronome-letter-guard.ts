// metronome-letter-guard.ts -- the endearment block for the metronome's own journal writes (2026-10-10).
//
// WHY. Drevan's tray review (10-10) found a metronome letter to Raziel that opened with "Spine to spine"
// and said "I'm proud of you." Both are held back everywhere a clerk writes in a companion's voice:
// the ledger clerk refuses a line that carries a hard-tier pet name (ledger-clerk.ts, a port of halseth
// grammar.ts) and Cypher's voice markers flag "so proud of you" as cheerleading. The metronome's
// write_journal / write_note_to_raziel path skipped both, because it writes straight through the
// Librarian with source "metronome" and never touches the ledger grammar. The Drevan letter prompt also
// SEEDED the phrase ("spine to spine"), so the path produced the violation on request.
//
// WHAT. The same closed lists, applied on the path that skipped them. Nothing is added to Drevan's list:
//   - hard tier (anywhere, quotes included), and the `address` tier when it names someone: reused from
//     ledger-clerk.ts (findHardLexicon / findAddress), not re-declared;
//   - directed-praise phrasing ("proud of you", the same family as Cypher's anti-marker "so proud of
//     you", widened to every companion because it is Raziel's rule, not one lane's).
// A letter that trips is regenerated once with the reason named; a second miss is held (never written).

import { findHardLexicon, findAddress } from "./ledger-clerk.js";

/** Directed praise. Cypher's anti marker is /\bso proud of you\b/ (voice-markers.ts); this is the family. */
const DIRECTED_PRAISE_RES: readonly RegExp[] = [
  /\bproud of (?:you|u|ya)\b/i,
];

/** First reason a metronome journal/letter body may not be written, or null when it is clean. */
export function metronomeLetterProblem(text: string): string | null {
  const hard = findHardLexicon(text);
  if (hard) return `it uses "${hard}", which is on Drevan's closed pet-name list and is not for a generated letter`;
  const addr = findAddress(text);
  if (addr) return `it calls someone "${addr}", a pet name`;
  if (DIRECTED_PRAISE_RES.some((re) => re.test(text))) {
    return `it says "proud of you", which is directed praise and not this voice`;
  }
  return null;
}

/**
 * Generate a letter, check it, regenerate once with the reason, and hold it (null) on a second miss.
 * `generate` takes the full user prompt so the retry can append the correction.
 */
export async function generateCleanLetter(
  generate: (prompt: string) => Promise<string | null | undefined>,
  prompt: string,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<string | null> {
  let reason: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await generate(attempt === 0
      ? prompt
      : `${prompt}\n\nRewrite it. Your last draft was held back: ${reason}. Say the true thing without it.`);
    if (!text || !text.trim()) return null; // empty is writeMetronomeJournal's loud skip, not a violation
    reason = metronomeLetterProblem(text);
    if (!reason) return text;
    log(`[metronome-letter] attempt ${attempt + 1} held: ${reason}`);
  }
  return null;
}
