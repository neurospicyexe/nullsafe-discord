/**
 * Tolerant JSON extraction from model output.
 *
 * Models asked for "ONLY valid JSON" still routinely reply with prose
 * ("I know you..."), markdown fences, narration before the object, or get
 * truncated mid-object by max_tokens. A raw JSON.parse at those sites throws
 * and the whole write is lost (2026-06-30/07-01 consolidation crash class).
 *
 * This takes the first {...} block in the output and parses it; anything that
 * still fails (prose with no object, truncated JSON with no closing brace)
 * returns null so callers can warn + skip instead of crashing.
 *
 * Canonical implementation -- extracted from autonomous-worker/src/club.ts,
 * which now re-exports this one.
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Short single-line preview of raw model output for warn logs. */
export function rawPreview(raw: string, len = 120): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, len);
}
