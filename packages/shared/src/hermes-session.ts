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

/**
 * ISO-8601 week string (`YYYY-Www`), UTC, Monday-start, ISO year rules -- the ISO week and its
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
 * stable key as the session id), a UTC calendar date (`YYYY-MM-DD`) for "daily", or a
 * Monday-start ISO week (`YYYY-Www`) for "weekly".
 */
export function hermesSessionEpoch(now: Date, mode: HermesRotation): string | null {
  if (mode === "off") return null;
  if (mode === "daily") {
    return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  }
  return isoWeekString(now);
}

/** The two Hermes gateway ids for one companion+channel turn at time `now` under `mode`. */
export function hermesSessionIds(
  companionId: string,
  channelId: string,
  now: Date,
  mode: HermesRotation,
): { sessionId: string; sessionKey: string } {
  const sessionKey = `${companionId}:${channelId}`;
  const epoch = hermesSessionEpoch(now, mode);
  return { sessionId: epoch === null ? sessionKey : `${sessionKey}:${epoch}`, sessionKey };
}
