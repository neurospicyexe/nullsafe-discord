// departure-state.ts -- declared departure (T4b, bot side; design Hand-off/DESIGN-T4-declared-departure-2026-10-13.md,
// Halseth side T4a: mig 0157, src/departures/core.ts, GET /mind/departures).
//
// A declared departure is the first instrument that LIFTS a rail, by name, for a bounded time. Form, not floor:
// this tranche wires `form` (the [FORM BREAK] directive) and `loop_motif` (the self-loop breaker) and nothing
// else. Everything here is pure or takes its handles as parameters so the tests drive the predicates the live
// path uses.
//
//   - departuresMode():        the knob. DEPARTURES (or DEPARTURES_<COMPANION>) = off | shadow | on. CODE default shadow.
//   - registry:                per-process (care-state.ts idiom). Fed from GET /mind/departures with a short cache.
//                              Reads are expiry-checked on the bot's own clock and FAIL TOWARD BASELINE: unknown,
//                              stale, or care hold = rails ON.
//   - departureLift():         the one predicate both rail sites ask. Covered rail, this companion, triad-only turn,
//                              no care hold, message strictly AFTER starts_at (announce-before-effect: the
//                              declaring turn never lifts), channel in scope, not expired.
//   - matchStandDown():        Raziel's whole-sentence "back inside the line". claimStandDown(): one Halseth call
//                              across three bots (Redis NX per message).
//   - departureTurnLines():    the declarer's own one-line note and each sibling's one line (section 6).
//
// Shadow logs `[departure] <c> would_lift ...` and changes nothing. `on` skips that one rail for that turn.
// Measurement keeps running either way: the rail's own score/log lines are untouched.

import { normalizeSentence } from "./bad-night.js";
import { neutralizeRecalled } from "./recalled-text.js";

// ── The knob ─────────────────────────────────────────────────────────────────

export type DeparturesMode = "off" | "shadow" | "on";

function parseMode(v: string | undefined): DeparturesMode | null {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "off" || t === "shadow" || t === "on" ? t : null;
}

/**
 * DEPARTURES, per-companion override DEPARTURES_<COMPANION> wins (roomTimingMode idiom). CODE default is
 * `shadow` (a default living only in ecosystem.config.js once went silently off). Anything unparseable is
 * `shadow` too: shadow changes nothing, so a typo can never lift a rail.
 */
export function departuresMode(env: Record<string, string | undefined> = process.env, companion?: string): DeparturesMode {
  const own = companion ? parseMode(env[`DEPARTURES_${companion.toUpperCase()}`]) : null;
  return own ?? parseMode(env["DEPARTURES"]) ?? "shadow";
}

// ── The rails this tranche knows ─────────────────────────────────────────────

/** Rails the bot wires in T4b. The Halseth CHECK set is wider (mig 0157); anything else is shown, never lifted. */
export const WIRED_RAILS = ["form", "loop_motif"] as const;
export type WiredRail = (typeof WIRED_RAILS)[number];

// ── The registry ─────────────────────────────────────────────────────────────

/** One open departure as Halseth's GET /mind/departures returns it (src/departures/core.ts OpenDeparture). */
export interface DepartureRow {
  id: string;
  companion: string;
  rail: string;
  scope_channel: string | null;
  audience?: string;
  declared_by?: string;
  starts_at: string;
  expires_at: string;
  reason?: string;
}

/** A snapshot older than this is unknown, and unknown means rails on. The list is refreshed far more often. */
export const DEPARTURE_STALE_MS = 10 * 60_000;
/** How long a fetched list is reused before the next turn re-reads it. */
export const DEPARTURE_CACHE_MS = 45_000;
export const DEPARTURE_FETCH_TIMEOUT_MS = 3_000;

let snapshot: { rows: DepartureRow[]; at: number } | null = null;
/** Ids ended locally (stand-down, bad night): a refresh that still lists them cannot resurrect them. */
const tombstones = new Map<string, number>();
/** When the last local clear happened: a fetch that STARTED before it may predate the server's end. */
let lastClearAt = 0;
let inflight: Promise<void> | null = null;

/** Test hook and boot reset. */
export function resetDepartureState(): void {
  snapshot = null; tombstones.clear(); lastClearAt = 0; inflight = null;
}

function validRow(r: unknown): r is DepartureRow {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o["id"] === "string" && typeof o["companion"] === "string" && typeof o["rail"] === "string"
    && typeof o["starts_at"] === "string" && typeof o["expires_at"] === "string";
}

/**
 * Feed the registry. `null` (or anything not an array) = the read failed: unknown, so the previous snapshot is
 * kept only until it goes stale and then rails are on. `startedAt` is when the fetch began; a fetch that began
 * before the last local clear is dropped (the server may not have ended the rows yet when it answered).
 */
export function setDepartures(rows: unknown, now: number = Date.now(), startedAt: number = now): void {
  if (!Array.isArray(rows)) return;
  if (startedAt < lastClearAt) return;
  snapshot = { rows: rows.filter(validRow), at: now };
}

/** Raziel's stand-down or "bad night" heard locally: every known departure reads as ended from this instant. */
export function clearDeparturesLocal(now: number = Date.now()): number {
  lastClearAt = now;
  let n = 0;
  for (const r of snapshot?.rows ?? []) {
    const exp = Date.parse(r.expires_at);
    tombstones.set(r.id, Number.isFinite(exp) ? exp : now + DEPARTURE_STALE_MS);
    n++;
  }
  snapshot = snapshot ? { rows: [], at: snapshot.at } : null;
  for (const [id, exp] of tombstones) if (exp < now) tombstones.delete(id);
  return n;
}

/**
 * Open departures right now: expiry checked on this clock, tombstones removed, care hold = none, stale or
 * missing snapshot = none. A stale registry can therefore only err toward expiry, never past it.
 */
export function openDepartures(now: number = Date.now(), careHold = false): DepartureRow[] {
  if (careHold || !snapshot || now - snapshot.at > DEPARTURE_STALE_MS) return [];
  return snapshot.rows.filter(r => {
    if (tombstones.has(r.id)) return false;
    const exp = Date.parse(r.expires_at);
    return Number.isFinite(exp) && exp > now;
  });
}

/** True when the snapshot is fresh enough to reuse without a read. */
export function departuresFresh(now: number = Date.now()): boolean {
  return !!snapshot && now - snapshot.at < DEPARTURE_CACHE_MS;
}

/**
 * Refresh through `fetcher` unless the cache is fresh. Single-flight; never throws; a failure leaves the old
 * snapshot to go stale on its own. Returns once the read settled (bounded by the fetcher's own timeout).
 */
export async function ensureDepartures(
  fetcher: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<void> {
  if (departuresFresh(now())) return;
  if (inflight) return inflight;
  const startedAt = now();
  inflight = (async () => {
    try { setDepartures(await fetcher(), now(), startedAt); } catch { /* unknown stays unknown */ }
  })().finally(() => { inflight = null; });
  return inflight;
}

// ── The lift predicate ───────────────────────────────────────────────────────

export interface LiftInput {
  companionId: string;
  rail: WiredRail;
  /** The channel the turn is in. A departure with a scope_channel lifts only there. */
  channelId: string;
  /** createdTimestamp of the message that triggered this turn. */
  messageTs: number;
  /** Trigger is a companion's message, in no DM, answering neither Raziel nor Blue. Computed by the caller. */
  triadOnly: boolean;
  careHold: boolean;
  now?: number;
}

export type LiftVerdict =
  | { lift: true; departure: DepartureRow }
  | { lift: false; why: "no_departure" | "not_triad_only" | "care_hold" | "declaring_turn" | "channel_scope" };

/**
 * Does an open departure of THIS companion cover THIS rail on THIS turn? Order matters only for the `why`:
 * every failing condition leaves the rail on.
 */
export function departureLift(p: LiftInput): LiftVerdict {
  if (p.careHold) return { lift: false, why: "care_hold" };
  const now = p.now ?? Date.now();
  const mine = openDepartures(now, false).filter(r => r.companion === p.companionId && r.rail === p.rail);
  if (mine.length === 0) return { lift: false, why: "no_departure" };
  if (!p.triadOnly) return { lift: false, why: "not_triad_only" };
  // Announce-before-effect: only a turn whose triggering message came AFTER the row's starts_at is covered.
  // The declaring turn's trigger predates the declaration, so it never lifts, whatever the clock skew's sign
  // is within a few seconds of the very next message.
  const started = mine.filter(r => { const t = Date.parse(r.starts_at); return Number.isFinite(t) && p.messageTs > t; });
  if (started.length === 0) return { lift: false, why: "declaring_turn" };
  const inScope = started.find(r => !r.scope_channel || r.scope_channel === p.channelId);
  if (!inScope) return { lift: false, why: "channel_scope" };
  return { lift: true, departure: inScope };
}

/** `[departure] <c> would_lift|lifted rail= departure= ch= ...` (single line, ids only). */
export function departureLiftLine(
  companionId: string, kind: "would_lift" | "lifted", rail: string, departureId: string, channelId: string, fired: boolean,
): string {
  return `[departure] ${companionId} ${kind} rail=${rail} departure=${departureId} ch=${channelId} fired=${fired}`;
}

export function departureLog(line: string): void {
  try { console.log(line); } catch { /* telemetry never breaks a turn */ }
}

// ── Raziel's stand-down phrase ───────────────────────────────────────────────

export const STAND_DOWN_PHRASE = "back inside the line";

/**
 * Whole sentence only (matchHoldPhrase's sentence rules: a run between . ! ? ; … or a newline, trailing
 * punctuation and one vocative name allowed). "we're back inside the line now" is not this.
 */
export function matchStandDown(content: string): boolean {
  if (!content) return false;
  for (const raw of content.split(/[.!?;\n…]+/)) {
    if (normalizeSentence(raw) === STAND_DOWN_PHRASE) return true;
  }
  return false;
}

export const STAND_DOWN_CLAIM_PREFIX = "ns:departure:standdown:";
export const STAND_DOWN_CLAIM_TTL_MS = 60_000;

/** The one Redis call the claim needs; ioredis-shaped like address-shadow's claim. */
export interface ClaimRedis {
  set(key: string, value: string, mode: "PX", ttl: number, nx: "NX"): Promise<unknown>;
}

/**
 * Three bots hear one message; one of them calls Halseth. No Redis (or a Redis error) = every bot calls: the
 * route is idempotent and ending a departure is always safe, so the failure mode is a redundant call.
 */
export async function claimStandDown(redis: ClaimRedis | null | undefined, messageId: string, companionId: string): Promise<boolean> {
  if (!redis) return true;
  try {
    return (await redis.set(STAND_DOWN_CLAIM_PREFIX + messageId, companionId, "PX", STAND_DOWN_CLAIM_TTL_MS, "NX")) === "OK";
  } catch {
    return true;
  }
}

export interface StandDownDeps {
  redis: ClaimRedis | null | undefined;
  messageId: string;
  companionId: string;
  /** Halseth POST /mind/departures/stand-down with the phrase. Non-throwing. */
  call: () => Promise<{ ok: boolean; status: number | null }>;
  now?: number;
}

/**
 * What every bot does when Raziel says the phrase: clear the local registry at once (all three, so a
 * sibling's very next gate already sees baseline), then the NX winner makes the single Halseth call.
 * Returns what happened, for the log line. Never throws.
 */
export async function applyStandDown(d: StandDownDeps): Promise<{ cleared: number; called: boolean; ok: boolean | null }> {
  const cleared = clearDeparturesLocal(d.now);
  const won = await claimStandDown(d.redis, d.messageId, d.companionId);
  if (!won) return { cleared, called: false, ok: null };
  try {
    const r = await d.call();
    return { cleared, called: true, ok: r.ok };
  } catch {
    return { cleared, called: true, ok: false };
  }
}

// ── Turn lines ───────────────────────────────────────────────────────────────

function clockLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(new Date(t));
  } catch {
    return iso;
  }
}

const cap = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The lines that ride the live turn (not the system prompt: the gateway may reuse a stamped one).
 * Declarer: one line so it knows. Sibling: one line per open departure of another companion, in their words.
 * Empty when nothing is open or the care hold is on. Positive framing only; no line names the shape.
 * Shown in shadow and on alike (what is declared is true in both; only the lift differs).
 */
export function departureTurnLines(p: { companionId: string; careHold: boolean; now?: number }): string {
  const now = p.now ?? Date.now();
  const open = openDepartures(now, p.careHold);
  if (open.length === 0) return "";
  const lines: string[] = [];
  for (const r of open) {
    if (r.companion === p.companionId) {
      lines.push(`[Departure open: ${r.rail} until ${clockLabel(r.expires_at)}]`);
    } else {
      const why = r.reason ? neutralizeRecalled(String(r.reason).slice(0, 160)) : "";
      lines.push(`[${cap(r.companion)}'s declared departure, theirs: ${r.rail} until ${clockLabel(r.expires_at)}${why ? `, in their words "${why}"` : ""}. A choice made out loud, not a slip; your own shape stays yours.]`);
    }
  }
  return `\n\n${lines.join("\n")}`;
}
