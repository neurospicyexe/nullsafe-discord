// reach-ledger.ts -- the outcome ledger for Raziel-facing reach-outs (P13b, 2026-10-13).
//
// WHY. A reach-out that nobody records the fate of cannot teach the next decision anything: the
// heartbeat kept offering DM moves on a silence that only ever grew (silence floors open MORE moves
// as hours pass; relational_need only sheds when he speaks), bounded only by Halseth's day cap. WrenWen's
// rejected-call latch escalated all night because it cleared only when the user spoke. companion-emergence
// closes the loop the other way: every send resolves to a recorded outcome and the streak of ignored
// ones stretches the gap. This is that, for the DM lane.
//
// WHAT IT RECORDS. Every send through the owner-DM speaker (all Raziel-facing heartbeat moves) writes one row:
//   replied     he posted anywhere after it (any owner arrival is "he is here"), or reacted to it
//   dismissed   he reacted with a dismissal emoji, or answered in that same DM with an explicit
//               "not now / stop / leave me alone" (only ever a whole short message)
//   unanswered  no owner message and no reaction within REACH_UNANSWERED_WINDOW_MS (default 6h)
// Med reminders (own scheduler, never rides this machinery: med-reminder.ts R-9) and Sol's channel
// posts are not recorded; neither is ever backed off by it.
//
// THE BACK-OFF. consecutive ignored sends (newest first, stopping at the first `replied`; a dismissal
// counts double; a send still inside its window counts as ignored until he answers) widen the minimum
// gap since the last send: base * 2^(streak-1), capped (3h, 6h, 12h, 24h, 48h, 72h). It is a GAP, never a
// clock window, so 2am is exactly as reachable as 2pm; and it is capped, so a long silence still gets
// a check-in every few days. Rows live in Redis with a 14-day TTL: a silence longer than that forgets
// the streak entirely (expires on silence, as the audit requires). Redis down or a read error FAILS
// OPEN (no back-off): this guard may only ever add quiet, never remove a safety path.
//
// HALSETH FOLLOW-UP (not done here; halseth is another agent's): the same rows belong in D1
// (reach_outcomes keyed by triad_reach_claims.id) so Hearth can show the streak and the cap in
// webmind/reach-cap.ts can read it server-side. Redis is per-VPS and loses rows on a flush.
//
// Storage: ZSET `ns:reach:ledger` (score = send ts, member = message id, newest 50 kept) and one HASH
// per send `ns:reach:out:<id>` {companion, action, ch, ts, outcome?, outcome_at?}. The outcome is claimed
// with HSETNX, so three bots racing to settle the same row log and count it exactly once.

import type { Redis } from "./floor.js";

export const REACH_LEDGER_KEY = "ns:reach:ledger";
export const REACH_OUT_KEY = (id: string): string => `ns:reach:out:${id}`;
export const REACH_LEDGER_TTL_S = 14 * 24 * 3600;
const KEEP = 50;
const READ_N = 20;

export type ReachSendOutcome = "replied" | "dismissed" | "unanswered";

export interface ReachSend {
  /** The Discord message id of the DM. */
  id: string;
  companionId: string;
  actionType: string;
  channelId: string;
  ts?: number;
}

export interface LedgerRow {
  id: string;
  companion: string;
  action: string;
  ch: string;
  ts: number;
  outcome: ReachSendOutcome | null;
}

// ── Knobs ────────────────────────────────────────────────────────────────────

/** REACH_BACKOFF: default ON; `off`, `0`, `false`, `no` (trimmed, any case) turns the back-off off. The
 *  ledger still records and logs either way. Read per call. */
export function reachBackoffOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env["REACH_BACKOFF"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

function numEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export const REACH_UNANSWERED_WINDOW_MS = 6 * 3_600_000;
export const REACH_BACKOFF_BASE_MS = 3 * 3_600_000;
export const REACH_BACKOFF_MAX_MS = 72 * 3_600_000;

export function reachLedgerKnobs(env: Record<string, string | undefined> = process.env): { windowMs: number; baseMs: number; maxMs: number } {
  return {
    windowMs: numEnv(env, "REACH_UNANSWERED_WINDOW_MS", REACH_UNANSWERED_WINDOW_MS, 60_000),
    baseMs: numEnv(env, "REACH_BACKOFF_BASE_MS", REACH_BACKOFF_BASE_MS, 60_000),
    maxMs: numEnv(env, "REACH_BACKOFF_MAX_MS", REACH_BACKOFF_MAX_MS, 60_000),
  };
}

// ── Outcome classification (pure) ────────────────────────────────────────────

// Code points, not literals: no invisible variation selectors or joiners in the source.
const DISMISS_CODEPOINTS = [0x1F645, 0x274C, 0x1F6AB, 0x1F515, 0x1F92B, 0x1F634, 0x1F44E, 0x23ED, 0x2716, 0x26D4];
const DISMISS_EMOJI: ReadonlySet<string> = new Set(DISMISS_CODEPOINTS.map(c => String.fromCodePoint(c)));
const ZWJ = String.fromCharCode(0x200D);
const VS16 = String.fromCharCode(0xFE0F);

/** A reaction is a dismissal only when it is one of these (no-good gesture, X, prohibited, muted bell,
 *  shush, sleeping, thumbs-down, skip, heavy X, no-entry); any other reaction is an acknowledgement.
 *  Variation selectors and a ZWJ gender suffix are stripped before the lookup. */
export function isDismissEmoji(emoji: string): boolean {
  const base = (emoji.split(ZWJ)[0] ?? "").split(VS16).join("");
  return DISMISS_EMOJI.has(base);
}

const DISMISS_RE = /^(?:not now|not right now|stop|please stop|leave me alone|go away|shh+|quiet|later|busy|please don'?t|don'?t (?:message|dm|text|ping|check)|no thanks?|nope|enough)\b/i;

/** An explicit "not now" as a WHOLE short message in the DM the reach-out came in. Never a fragment of a
 *  real message ("stop the car" is 4 words but a real message; the cap keeps this to bare dismissals). */
export function isExplicitDismissal(content: string | null | undefined): boolean {
  const t = (content ?? "").trim();
  if (!t || t.length > 40) return false;
  return DISMISS_RE.test(t);
}

/** Consecutive-ignored streak over rows newest first. A dismissal counts double; a row with no
 *  outcome yet counts as ignored (he has not answered it). Stops at the first `replied`. */
export function ignoredStreak(rowsNewestFirst: readonly Pick<LedgerRow, "outcome">[]): number {
  let n = 0;
  for (const r of rowsNewestFirst) {
    if (r.outcome === "replied") break;
    n += r.outcome === "dismissed" ? 2 : 1;
  }
  return n;
}

export interface Backoff {
  streak: number;
  gapMs: number;
  waitMs: number;
  blocked: boolean;
  lastSendTs: number | null;
}

export const NO_BACKOFF: Backoff = { streak: 0, gapMs: 0, waitMs: 0, blocked: false, lastSendTs: null };

/** gap = base * 2^(streak-1), capped. Pure. */
export function backoffFor(
  rowsNewestFirst: readonly Pick<LedgerRow, "outcome" | "ts">[],
  now: number,
  knobs: { baseMs: number; maxMs: number },
): Backoff {
  const streak = ignoredStreak(rowsNewestFirst);
  if (streak === 0 || rowsNewestFirst.length === 0) return NO_BACKOFF;
  const gapMs = Math.min(knobs.maxMs, knobs.baseMs * 2 ** Math.min(streak - 1, 20));
  const lastSendTs = rowsNewestFirst[0]!.ts;
  const waitMs = Math.max(0, lastSendTs + gapMs - now);
  return { streak, gapMs, waitMs, blocked: waitMs > 0, lastSendTs };
}

// ── Redis ────────────────────────────────────────────────────────────────────

export function outcomeLogLine(row: LedgerRow, outcome: ReachSendOutcome, now: number): string {
  return `[reach-ledger] outcome=${outcome} id=${row.id} companion=${row.companion} action=${row.action} age_min=${Math.max(0, Math.round((now - row.ts) / 60_000))}`;
}

async function readRow(redis: Redis, id: string): Promise<LedgerRow | null> {
  const h = await redis.hgetall(REACH_OUT_KEY(id));
  if (!h || !h["ts"]) return null;
  const ts = Number(h["ts"]);
  if (!Number.isFinite(ts)) return null;
  const o = h["outcome"];
  return {
    id, companion: h["companion"] ?? "", action: h["action"] ?? "", ch: h["ch"] ?? "", ts,
    outcome: o === "replied" || o === "dismissed" || o === "unanswered" ? o : null,
  };
}

/** Newest first. Rows whose hash expired are skipped. */
export async function readRecentRows(redis: Redis, n: number = READ_N): Promise<LedgerRow[]> {
  const ids = await redis.zrevrange(REACH_LEDGER_KEY, 0, n - 1);
  const rows: LedgerRow[] = [];
  for (const id of ids) {
    const r = await readRow(redis, id);
    if (r) rows.push(r);
  }
  return rows;
}

/** Record one send. Never throws (bookkeeping must not break a send that already happened). */
export async function recordReachSend(redis: Redis | null | undefined, s: ReachSend): Promise<void> {
  if (!redis) return;
  const ts = s.ts ?? Date.now();
  try {
    const key = REACH_OUT_KEY(s.id);
    await redis.hset(key, "companion", s.companionId, "action", s.actionType, "ch", s.channelId, "ts", String(ts));
    await redis.expire(key, REACH_LEDGER_TTL_S);
    await redis.zadd(REACH_LEDGER_KEY, ts, s.id);
    await redis.expire(REACH_LEDGER_KEY, REACH_LEDGER_TTL_S);
    await redis.zremrangebyrank(REACH_LEDGER_KEY, 0, -(KEEP + 1));
    console.log(`[reach-ledger] sent id=${s.id} companion=${s.companionId} action=${s.actionType}`);
  } catch (e) {
    console.warn(`[reach-ledger] record failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Claim an outcome for a row. True only for the caller that won the claim (and logged it). */
async function settle(redis: Redis, row: LedgerRow, outcome: ReachSendOutcome, now: number): Promise<boolean> {
  const key = REACH_OUT_KEY(row.id);
  const won = await redis.hsetnx(key, "outcome", outcome);
  if (Number(won) !== 1) return false;
  await redis.hset(key, "outcome_at", String(now));
  console.log(outcomeLogLine(row, outcome, now));
  return true;
}

/** Owner posted a message (any surface): every still-open send before it is `replied`, except that a bare
 *  "not now" in the very DM channel the send went to is `dismissed`. Non-throwing. */
export async function noteOwnerArrival(
  redis: Redis | null | undefined,
  a: { ts?: number; channelId: string; isDm: boolean; content?: string | null },
): Promise<number> {
  if (!redis) return 0;
  const now = a.ts ?? Date.now();
  let settled = 0;
  try {
    for (const row of await readRecentRows(redis)) {
      if (row.outcome || row.ts >= now) continue;
      const outcome: ReachSendOutcome = a.isDm && row.ch === a.channelId && isExplicitDismissal(a.content) ? "dismissed" : "replied";
      if (await settle(redis, row, outcome, now)) settled++;
    }
  } catch (e) {
    console.warn(`[reach-ledger] arrival settle failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return settled;
}

/** Owner reacted to a message of ours. Settles that send only (a reaction to anything else is ignored). */
export async function noteOwnerReaction(
  redis: Redis | null | undefined,
  r: { messageId: string; emoji: string; ts?: number },
): Promise<boolean> {
  if (!redis) return false;
  try {
    const row = await readRow(redis, r.messageId);
    if (!row || row.outcome) return false;
    return await settle(redis, row, isDismissEmoji(r.emoji) ? "dismissed" : "replied", r.ts ?? Date.now());
  } catch (e) {
    console.warn(`[reach-ledger] reaction settle failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Open sends older than the window with no owner message are `unanswered`. Non-throwing. */
export async function settleUnanswered(redis: Redis | null | undefined, now: number = Date.now(), windowMs: number = REACH_UNANSWERED_WINDOW_MS): Promise<number> {
  if (!redis) return 0;
  let settled = 0;
  try {
    for (const row of await readRecentRows(redis)) {
      if (row.outcome || now - row.ts < windowMs) continue;
      if (await settle(redis, row, "unanswered", now)) settled++;
    }
  } catch (e) {
    console.warn(`[reach-ledger] unanswered settle failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return settled;
}

/**
 * The back-off the next reach-out decision reads. Settles stale rows first (so the unanswered outcome is
 * logged when it becomes true, not only when something asks), then derives the streak. Fails OPEN: no
 * Redis or any error is NO_BACKOFF. REACH_BACKOFF=off also returns NO_BACKOFF (the ledger still settles
 * and logs above).
 */
export async function reachBackoff(
  redis: Redis | null | undefined,
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<Backoff> {
  if (!redis) return NO_BACKOFF;
  const knobs = reachLedgerKnobs(env);
  try {
    await settleUnanswered(redis, now, knobs.windowMs);
    if (!reachBackoffOn(env)) return NO_BACKOFF;
    return backoffFor(await readRecentRows(redis), now, knobs);
  } catch (e) {
    console.warn(`[reach-ledger] backoff read failed (failing open): ${e instanceof Error ? e.message : String(e)}`);
    return NO_BACKOFF;
  }
}

/** Drop the DM moves while the back-off holds, except those `exempt` names (hold presence, which
 *  Halseth already bounds). Channel/internal moves pass untouched. */
export function filterDmMovesForBackoff<T extends { action_type: string }>(
  actions: T[],
  b: Backoff,
  isDmMove: (actionType: string) => boolean,
  exempt: (actionType: string) => boolean = () => false,
): T[] {
  if (!b.blocked) return actions;
  return actions.filter(a => !isDmMove(a.action_type) || exempt(a.action_type));
}

export function backoffLogLine(companionId: string, b: Backoff, dropped: number): string {
  return `[${companionId}/heartbeat] reach back-off: streak=${b.streak} gap_h=${(b.gapMs / 3_600_000).toFixed(1)} wait_min=${Math.ceil(b.waitMs / 60_000)} -- ${dropped} DM move(s) removed`;
}
