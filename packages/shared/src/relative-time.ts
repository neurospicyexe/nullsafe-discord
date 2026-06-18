// Human-readable relative time for companion-facing context (mirror of halseth's
// src/webmind/relative-time.ts -- keep the two in sync). Without an explicit "how long
// ago" anchor on time-bound items (recent listens, forage finds), the model guesses and
// guesses wrong (2026-06-17: Drevan called a 2-days-ago listen "yesterday" in the commons).
// Stamping each item with a relative label gives the exact phrasing to echo.
//
// Pure, dependency-free, `now` injectable for tests. Past timestamps only.

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "recently";
  const then = Date.parse(iso);
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
