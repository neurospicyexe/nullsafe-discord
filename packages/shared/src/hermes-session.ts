/**
 * Hermes gateway session rotation (2026-09-05).
 *
 * The bot pinned ONE gateway session per companion+channel forever (`companionId:channelId`,
 * 2026-07-01 -- see the header comment this replaces in inference.ts). That was the fix for a
 * worse problem (a fresh gateway session almost every reply), but a busy channel's session now
 * just grows without bound -- one hit ~270k tokens -- and Hermes compacts it on the critical
 * path (3-12 minutes observed), with the compaction itself adding to the session it's trying to
 * shrink.
 *
 * Fix: split the one id into two. `sessionKey` is the stable long-term-memory scope (unchanged
 * shape, `companionId:channelId`) -- Hermes gateway LTM (e.g. Honcho) stays anchored across any
 * number of transcript rotations. `sessionId` is the TRANSCRIPT the gateway compacts, and it
 * rotates on a schedule (`sessionKey:epoch`) so no single transcript grows unbounded.
 */

export type HermesRotation = "weekly" | "daily" | "off";

/**
 * Reads `HERMES_SESSION_ROTATION` from the given env (defaults to `process.env`). Unknown or
 * missing values fall back to "weekly" -- never throws, since a typo'd env var should degrade to
 * the safe default, not take inference down.
 */
export function hermesRotationMode(env: NodeJS.ProcessEnv = process.env): HermesRotation {
  const raw = env["HERMES_SESSION_ROTATION"];
  if (raw === "daily" || raw === "off") return raw;
  return "weekly";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Rotation boundary (B28, 2026-09-28). The epoch used to roll at 00:00 UTC, which is 19:00 CDT /
// 18:00 CST: the middle of Raziel's evening, so every weekly rotation dropped the live transcript
// of whatever conversation was happening. It now rolls at 04:00 America/Chicago, his
// lowest-traffic hour (a 30-day audit found ZERO inbound messages between 03:00 and 05:00).
//
// DST-aware by construction: the Chicago wall clock comes from Intl (never a fixed offset), and the
// "rotation day" is that wall-clock date, minus one day before 04:00. Both DST switches happen at
// 02:00 on a Sunday, two hours before the boundary and on a day that is never a Monday, so the
// repeated hour in November and the skipped hour in March both fall inside one rotation day: the
// epoch is stable and never goes backwards across either change.
const ROTATION_TZ = "America/Chicago";
const ROTATION_HOUR = 4;
const chicagoParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ROTATION_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

/**
 * The calendar day a rotation period belongs to, as a UTC-midnight Date carrying that Chicago
 * date's y/m/d: the Chicago date of `now`, or the previous date when it is before 04:00 there.
 */
function rotationDay(now: Date): Date {
  const p: Record<string, number> = {};
  for (const part of chicagoParts.formatToParts(now)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // Day arithmetic in UTC fields sidesteps DST entirely; this Date is a calendar label, not an instant.
  const day = new Date(Date.UTC(p.year!, p.month! - 1, p.day!));
  if (p.hour! < ROTATION_HOUR) day.setUTCDate(day.getUTCDate() - 1);
  return day;
}

/**
 * ISO-8601 week string (`YYYY-Www`) of a calendar day, Monday-start, ISO year rules -- the ISO week and its
 * "week year" can differ from the calendar year at both ends of December/January (e.g.
 * 2027-01-01 falls in ISO week 2026-W53; 2024-12-30 falls in ISO week 2025-W01). Standard
 * algorithm: shift to the Thursday of the same ISO week, then the week number is that Thursday's
 * ordinal day-of-year divided by 7.
 */
function isoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayOfWeek = d.getUTCDay() || 7; // Sunday (0) -> 7, Monday (1) -> 1, ...
  d.setUTCDate(d.getUTCDate() + 4 - isoDayOfWeek); // move to this ISO week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad2(weekNo)}`;
}

/**
 * The rotation epoch for `now` under `mode` -- `null` for "off" (no rotation, caller keeps the
 * stable key as the session id), the rotation day (`YYYY-MM-DD`) for "daily", or the Monday-start
 * ISO week (`YYYY-Www`) of the rotation day for "weekly". Both roll at 04:00 America/Chicago, so
 * weekly rolls Monday 04:00 Chicago (daily moved with it: same evening-rollover problem).
 */
export function hermesSessionEpoch(now: Date, mode: HermesRotation): string | null {
  if (mode === "off") return null;
  const day = rotationDay(now);
  if (mode === "daily") {
    return `${day.getUTCFullYear()}-${pad2(day.getUTCMonth() + 1)}-${pad2(day.getUTCDate())}`;
  }
  return isoWeekString(day);
}

/**
 * The two Hermes gateway ids for one companion+channel turn at time `now` under `mode`.
 *
 * `bump` (2026-09-26, rotate-on-retract): a per-channel counter that forces a fresh transcript
 * NOW instead of at the next scheduled epoch. `<prefix>: retract` pulled a mistaken reply out of
 * every memory store, and the gateway transcript still carried it -- so the model kept seeing (and
 * re-answering from) a reply Raziel had already retracted, until the next scheduled rotation (then
 * Sunday 19:00 CDT; since B28, 2026-09-28, Monday 04:00 America/Chicago). A bump
 * > 0 suffixes the id with `:r<n>`; the key (LTM scope) never moves, and the next scheduled
 * epoch still changes the id further, so bumps and the schedule compose rather than collide.
 */
export function hermesSessionIds(
  companionId: string,
  channelId: string,
  now: Date,
  mode: HermesRotation,
  bump = 0,
): { sessionId: string; sessionKey: string } {
  const sessionKey = `${companionId}:${channelId}`;
  const epoch = hermesSessionEpoch(now, mode);
  const base = epoch === null ? sessionKey : `${sessionKey}:${epoch}`;
  return { sessionId: bump > 0 ? `${base}:r${bump}` : base, sessionKey };
}
