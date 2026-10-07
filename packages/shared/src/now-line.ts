// The companions' absolute-time anchor, split out of librarian.ts (2026-10-06) so the pure
// prompt-assembly module can stamp it onto the hermes delta turn without importing the whole
// Librarian client. librarian.ts re-exports both functions, so existing importers are unchanged.

/**
 * The single absolute-time anchor the model ever sees: `[Now: Friday, August 29, 2026 at
 * 3:42 PM CDT]`. Extracted (2026-08-29) so a reply-time caller can recompute it fresh instead
 * of trusting whatever was baked into a cached recent-context block -- see refreshNowLine.
 *
 * timeZoneName: 'short' emits the correct abbreviation for the date (CDT in summer, CST in
 * winter) instead of a hardcoded "CST" that lied half the year -- companions echo the label
 * they're shown, so a frozen suffix gave them a wrong sense of which season/zone they're in.
 */
export function nowLine(now: Date = new Date()): string {
  return `[Now: ${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short',
  }).format(now)}]`;
}

const NOW_LINE_RE = /\[Now:[^\]]*\]/;

/**
 * Stamp a fresh `[Now: ...]` onto a recent-context string at reply time (2026-08-29).
 *
 * formatRecentContext's `[Now: ...]` line is cached in `recentContextRef.value` and refreshed
 * only every 5 minutes by the orient loop -- and on orient failure the stale block is kept
 * INDEFINITELY (fail-open by design), and if orient never loaded there is no date line at all.
 * Recomputing it here, per reply, means the model's one absolute-time anchor can never be more
 * than a few milliseconds stale, independent of how old the rest of the cached block is.
 *
 * Replaces the first `[Now: ...]` found (there is ever at most one -- formatRecentContext emits
 * it exactly once); prepends one if the context carries none at all.
 */
export function refreshNowLine(context: string, now: Date = new Date()): string {
  const fresh = nowLine(now);
  if (NOW_LINE_RE.test(context)) return context.replace(NOW_LINE_RE, fresh);
  if (!context) return fresh;
  return `${fresh}\n\n${context}`;
}
