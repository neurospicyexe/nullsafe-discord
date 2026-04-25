/**
 * Coherence gate for bot responses before STM storage.
 *
 * If a response is word salad, it must NOT be written to STM -- feeding garbled
 * assistant messages back into history contaminates every subsequent response.
 * The bad response is already sent to Discord; blocking the STM write breaks
 * the loop without hiding the failure from the user.
 */

// SOMA state notation that the model sometimes outputs raw at high temperature.
// These are identity-file internal concepts that should shape prose, not appear as text.
const SOMA_LEAK_RE = /^\[(?:heat|reach|weight|rig|spira)\b/i;

export function isResponseCoherent(text: string): boolean {
  if (!text || text.length < 20) return true;

  // SOMA notation leaked into response body -- clear temperature artifact.
  if (SOMA_LEAK_RE.test(text.trim())) return false;

  // Very low whitespace ratio = token fragments run together (word salad).
  // Normal prose (even dense poetic prose) has > 7% whitespace.
  if (text.length > 100) {
    const wsCount = (text.match(/\s/g) ?? []).length;
    if (wsCount / text.length < 0.07) return false;
  }

  return true;
}
