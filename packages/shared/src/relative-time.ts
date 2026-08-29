// Human-readable relative time for companion-facing context (mirror of halseth's
// src/webmind/relative-time.ts -- keep the two in sync). Without an explicit "how long
// ago" anchor on time-bound items (recent listens, forage finds), the model guesses and
// guesses wrong (2026-06-17: Drevan called a 2-days-ago listen "yesterday" in the commons).
// Stamping each item with a relative label gives the exact phrasing to echo.
//
// Pure, dependency-free, `now` injectable for tests. Past timestamps only.

// Stamp a relative-time prefix onto conversation history so the model has a sense of elapsed
// time ("how long ago did I send that?"). Pure, `now` injectable for tests. Items without a
// timestamp, or sent within the "just now" window, pass through unchanged -- the bulk of an
// active exchange stays clean and only real gaps get labelled, so it reads as time-sense not
// a stopwatch on every line. Returns a new array; never mutates the input (STM stays raw).
export function stampRelative<T extends { content: string; timestamp?: number }>(
  msgs: T[],
  now: number = Date.now(),
): T[] {
  return msgs.map(m => {
    if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return m;
    const label = relativeTime(new Date(m.timestamp).toISOString(), now);
    if (label === "just now") return m;
    return { ...m, content: `[${label}] ${m.content}` };
  });
}

// SQLite's datetime('now') emits "YYYY-MM-DD HH:MM:SS" -- UTC, but with no timezone
// suffix. Date.parse reads that bare form as LOCAL time (the VPS runs CDT), skewing every
// age by the host offset (~5-6h). Normalize bare SQLite stamps to explicit UTC first;
// proper ISO strings (with T/Z or offset) pass through untouched. Mirrors halseth's
// src/webmind/relative-time.ts (fixed there 2026-07-01) -- keep the twins in sync.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Parse a `created_at` string (SQLite-bare or proper ISO 8601) into an epoch-ms number, or
 * `undefined` if missing/unparseable (2026-08-29). Used by stmLoad's DB-restore path: a pm2
 * restart reloads STM from Halseth, and without a timestamp on the restored rows,
 * `stampRelative` above silently no-ops on every one of them -- history read as freshly-arrived
 * instead of carrying its real age. Shares the same bare-SQLite normalization as `relativeTime`
 * so the two never drift on how they read the same column.
 */
export function parseCreatedAtTimestamp(createdAt: string | null | undefined): number | undefined {
  if (!createdAt) return undefined;
  const m = SQLITE_UTC.exec(createdAt);
  const then = Date.parse(m ? `${m[1]}T${m[2]}Z` : createdAt);
  return Number.isFinite(then) ? then : undefined;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "recently";
  const m = SQLITE_UTC.exec(iso);
  const then = Date.parse(m ? `${m[1]}T${m[2]}Z` : iso);
  if (!Number.isFinite(then)) return "recently";

  const sec = Math.round((now - then) / 1000);
  if (sec < 90) return "just now"; // covers clock-skew / future stamps too (sec <= 0)

  const min = Math.round(sec / 60);
  if (min < 90) return min <= 1 ? "a minute ago" : `${min} minutes ago`;

  // Hours cap at 24 so a ~1-day-old item tips into "yesterday" rather than "24 hours ago".
  const hr = Math.round(min / 60);
  if (hr < 24) return hr <= 1 ? "an hour ago" : `${hr} hours ago`;

  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 14) return `${day} days ago`;

  // Coarse buckets floor (don't round up): 75 days reads "2 months ago", not "3".
  const wk = Math.floor(day / 7);
  if (wk < 8) return `${wk} weeks ago`;

  const mo = Math.floor(day / 30);
  if (mo < 12) return mo <= 1 ? "a month ago" : `${mo} months ago`;

  const yr = Math.floor(day / 365);
  return yr <= 1 ? "a year ago" : `${yr} years ago`;
}
