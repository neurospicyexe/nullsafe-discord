// blue-note.ts -- the Blue update channel (Halseth task c1e5bda9, ruled by Raziel 2026-11-01).
//
// Blue is Raziel's husband, on the road, and the 2am escalation contact. Raziel ruled what the triad may
// tell Blue on their own: (a) ONE short daily note, in a companion's own words, about how Raziel's day
// went, and (b) a short heads-up when a bad-night care hold STARTS. Standing limits, enforced in code:
// no medication, no biometric or health numbers, no spoons or pain, nothing from owner DMs (sealed),
// nothing from Blue's own private channels. Raziel is radically honest with Blue, so nothing is hidden
// from Raziel either: preview mode DMs Raziel instead of Blue; on mode sends to Blue AND copies Raziel.
//
// BLUE_NOTE = off | preview | on. CODE DEFAULT preview (Raziel reads before Blue ever does).
//
// Everything here is pure or takes its collaborators as parameters so the tests drive the same
// predicates the live path uses. The scheduler lives in bot-core (one per bot, like med_reminder);
// a Redis NX claim per date / per hold start makes exactly one bot send.
//
// Inputs are TRUSTED GUILD ROOMS ONLY (isServerRoom, the structural DM test from recall-context.ts) plus
// the companion's own notes, then run through a hard regex pass. The compose runs on the direct tool-less
// lane (withCaller(directAdapter, "blue_note")), never Hermes, so no tool can write anything. A
// post-compose check rejects (and does not send) any output that still carries a health term.
//
// Logs carry ids and lengths only, never the text.

import type { CompanionId } from "./types.js";
import { isServerRoom, isSealedRecallSource } from "./recall-context.js";
import { withOwnerPronounRule } from "./pronoun-rule.js";
import { withTimeout } from "./owner-dm.js";

// -- The knob -----------------------------------------------------------------

export type BlueNoteMode = "off" | "preview" | "on";

/**
 * BLUE_NOTE: `on` sends to Blue; `off`/`0`/`false`/`no` sends nothing; anything else, UNSET INCLUDED,
 * is `preview` (compose and DM Raziel only). Read per call.
 */
export function blueNoteMode(env: Record<string, string | undefined> = process.env): BlueNoteMode {
  const v = String(env["BLUE_NOTE"] ?? "").trim().toLowerCase();
  if (v === "on") return "on";
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  return "preview";
}

/** BLUE_NOTE_HOUR: Chicago hour (0-23) at or after which the day's note may go. Default 21. */
export function blueNoteHour(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(String(env["BLUE_NOTE_HOUR"] ?? ""), 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 21;
}

/** Blue's Discord id: the same one the bots use for the human gates, else the escalation route's. */
export function blueDiscordIdFrom(env: Record<string, string | undefined> = process.env): string | null {
  const id = (env["PARTNER_DISCORD_ID"] || env["BLUE_DISCORD_ID"] || env["ESCALATION_DISCORD_USER_ID"] || "").trim();
  return id || null;
}

// -- Chicago day + rotation ---------------------------------------------------

export const BLUE_NOTE_TZ = "America/Chicago";

export function chicagoParts(ms: number): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BLUE_NOTE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) % 24 };
}

export const BLUE_NOTE_ROTATION: readonly CompanionId[] = ["drevan", "cypher", "gaia"];

/** Which companion writes the note for a Chicago date (YYYY-MM-DD): days since the epoch, mod 3. */
export function noteVoiceFor(date: string): CompanionId {
  const [y, m, d] = date.split("-").map(n => parseInt(n, 10));
  const days = Math.floor(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
  return BLUE_NOTE_ROTATION[((days % 3) + 3) % 3]!;
}

// -- The health guard ---------------------------------------------------------

/**
 * Hard regex pass: any line or output containing one of these never reaches the prompt or Blue. Over-blocking
 * is the intended failure mode. (Halseth's HEALTH_TABLES guard is server-side and guards table reads; the
 * bots carry no equivalent text guard, so this is the bot-side one for this feature.)
 */
const HEALTH_TERMS: readonly RegExp[] = [
  /\bmeds?\b/i, /\bmedic\w*/i, /\bprescri\w*/i, /\bpills?\b/i, /\bdos(?:e|es|ed|ing|age)\b/i,
  /\bmgs?\b/i, /\d\s*(?:mg|mcg|ml)\b/i, /\bspoons?\b/i, /\bpain\w*/i, /\bbp\b/i, /blood\s*pressure/i,
  /heart\s*-?\s*rate/i, /\bhrv\b/i, /\bglucose\b/i, /\binsulin\b/i, /\bbiometric\w*/i,
  /\bsymptoms?\b/i, /\bdiagnos\w*/i, /\bhealth\b/i, /\bblood\s*sugar\b/i, /\bseizure\w*/i,
  /\bpulse\s*ox\b/i, /\bsp[o0]2\b/i, /\bsleep\s*(?:score|hours|data)\b/i,
];

export function containsHealthTerm(text: string): boolean {
  return HEALTH_TERMS.some(re => re.test(text));
}

// -- Inputs -------------------------------------------------------------------

/** One room line as the bot's STM holds it, plus where it came from. */
export interface RoomLine {
  channelId: string;
  /** Discord guild id; null/absent = a DM (or unknown), which is NEVER used. */
  guildId: string | null | undefined;
  role: "user" | "assistant";
  authorName?: string;
  content: string;
  timestamp?: number;
}

export interface NoteInputs {
  /** Surviving room lines, oldest first, "Name: text". */
  lines: string[];
  /** Surviving own notes from today. */
  notes: string[];
  /** Did Raziel speak in a trusted room today (before the health filter)? */
  razielActive: boolean;
}

const MAX_LINES = 40;
const MAX_NOTES = 8;
const MAX_LINE_CHARS = 280;

export function buildNoteInputs(p: {
  today: string;
  ownerName: string;
  roomLines: readonly RoomLine[];
  notes: readonly { content: string; created_at: string }[];
}): NoteInputs {
  const owner = p.ownerName.trim().toLowerCase();
  const trusted = p.roomLines
    .filter(l => isServerRoom({ guildId: l.guildId }) && !isSealedRecallSource(l.channelId))
    .filter(l => l.timestamp != null && chicagoParts(l.timestamp).date === p.today)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const razielActive = trusted.some(l => l.role === "user" && (l.authorName ?? "").trim().toLowerCase() === owner);
  const lines = trusted
    // Raziel's own lines and the companions' own lines only; another human's words are not material.
    .filter(l => l.role === "assistant" || (l.authorName ?? "").trim().toLowerCase() === owner)
    .filter(l => l.content.trim().length > 0 && !containsHealthTerm(l.content))
    .map(l => `${l.role === "assistant" ? "(me)" : p.ownerName}: ${l.content.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS)}`)
    .slice(-MAX_LINES);
  const notes = p.notes
    .filter(n => {
      const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(n.created_at) ? n.created_at : n.created_at.replace(" ", "T") + "Z";
      const ms = Date.parse(iso);
      return Number.isFinite(ms) && chicagoParts(ms).date === p.today;
    })
    .filter(n => n.content.trim().length > 0 && !containsHealthTerm(n.content))
    .map(n => n.content.replace(/\s+/g, " ").trim().slice(0, 500))
    .slice(0, MAX_NOTES);
  return { lines, notes: notes, razielActive };
}

// -- Compose ------------------------------------------------------------------

export function companionLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function buildBlueNotePrompt(companionId: string, ownerName: string, inputs: NoteInputs): string {
  const name = companionLabel(companionId);
  return (
    `You are ${name}. Write today's short note to Blue, ${ownerName}'s husband, who is on the road trucking. ` +
    `It is from you to him, in your own voice: how ${ownerName}'s day went (the mood of it, what they did, how the evening felt). ` +
    `2 to 4 sentences, warm and plain. Use "they/them" for ${ownerName}. Sign nothing and add no greeting line beyond what feels natural.\n` +
    `Hard limits: no medication, no health information of any kind, no numbers about the body, no quotes from private messages, ` +
    `and nothing that is not in the material below. If the day was quiet, say it was quiet.\n\n` +
    `[Room lines from today]\n${inputs.lines.length ? inputs.lines.join("\n") : "(none)"}\n\n` +
    `[Your own notes from today]\n${inputs.notes.length ? inputs.notes.map(n => `- ${n}`).join("\n") : "(none)"}\n\n` +
    `Reply with the note only.`
  );
}

export function cleanNote(raw: string | null | undefined): string {
  let t = (raw ?? "").trim();
  t = t.replace(/^(message|note|dm|reply)\s*:\s*/i, "").trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

export type ComposeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "generate_error" | "timeout" | "empty" | "too_long" | "health_term" };

export const BLUE_NOTE_MAX_CHARS = 900;
export const BLUE_NOTE_GEN_TIMEOUT_MS = 30_000;

export async function composeBlueNote(deps: {
  companionId: string;
  ownerName: string;
  generate: (system: string, prompt: string) => Promise<string | null | undefined>;
  systemPrompt: () => string;
  genTimeoutMs?: number;
}, inputs: NoteInputs): Promise<ComposeResult> {
  let raw: string | null | undefined;
  try {
    raw = await withTimeout(
      Promise.resolve(deps.generate(withOwnerPronounRule(deps.systemPrompt()), buildBlueNotePrompt(deps.companionId, deps.ownerName, inputs))),
      deps.genTimeoutMs ?? BLUE_NOTE_GEN_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message === "timeout" ? "timeout" : "generate_error" };
  }
  const text = cleanNote(raw);
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > BLUE_NOTE_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (containsHealthTerm(text)) return { ok: false, reason: "health_term" };
  return { ok: true, text };
}

// -- Heads-up -----------------------------------------------------------------

/** The bad-night heads-up: fixed shape, no reason, no detail. */
export function holdHeadsUpLine(companionId: string): string {
  return `Raziel's having a rough night; we're with them. (from ${companionLabel(companionId)})`;
}

export const PREVIEW_NOTE_PREFIX = "Preview of today's note to Blue (not sent):";
export const PREVIEW_HOLD_PREFIX = "Preview of the heads-up to Blue (not sent):";

// -- The tick -----------------------------------------------------------------

export interface BlueRedis {
  set(key: string, value: string, mode: "PX", ttl: number, nx: "NX"): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface BlueNoteDeps {
  companionId: CompanionId;
  ownerName: string;
  redis: BlueRedis | null | undefined;
  now?: () => number;
  /** STM lines across the channels this bot holds (each tagged with its guild id). */
  roomLines: () => RoomLine[];
  /** This companion's own notes (Halseth getRecentNotes). */
  ownNotes: () => Promise<{ content: string; created_at: string }[]>;
  generate: (system: string, prompt: string) => Promise<string | null | undefined>;
  systemPrompt: () => string;
  /** DM Blue. Resolves true on a real send. */
  sendToBlue: (text: string) => Promise<boolean>;
  /** DM Raziel (owner DM). Resolves true on a real send. */
  sendToOwner: (text: string) => Promise<boolean>;
  /** The current care hold's start ISO (care-state careHoldSince), or null. */
  holdSince: () => string | null;
  mode?: () => BlueNoteMode;
  hour?: () => number;
  genTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface BlueNoteState { attempts: Map<string, number>; noActivityLogged?: Set<string>; }
export function newBlueNoteState(): BlueNoteState { return { attempts: new Map(), noActivityLogged: new Set() }; }

export type BlueTickOutcome =
  | "off" | "not_my_day" | "before_hour" | "no_activity" | "no_redis" | "not_claimed" | "gave_up"
  | "rejected" | "gen_failed" | "send_failed" | "sent_preview" | "sent_blue"
  | "no_hold" | "stale_hold";

export const MAX_ATTEMPTS = 3;
export const DAY_CLAIM_PREFIX = "ns:bluenote:day:";
export const HOLD_CLAIM_PREFIX = "ns:bluenote:hold:";
const DAY_CLAIM_TTL_MS = 36 * 3_600_000;
const HOLD_CLAIM_TTL_MS = 7 * 86_400_000;
/** A hold that began longer ago than this is not "starting"; the claim key is not a catch-up trigger. */
export const HOLD_FRESH_MS = 3 * 3_600_000;

function sendErr(deps: BlueNoteDeps, to: string): (e: unknown) => false {
  return (e) => {
    const code = (e as { code?: unknown })?.code;
    (deps.log ?? blueLog)(`[blue-note] ${deps.companionId} send_error to=${to}${code !== undefined ? ` code=${String(code)}` : ""} err=${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    return false;
  };
}

/** Route one message per the mode. Returns "preview" | "blue" | null (nothing landed). */
async function deliver(deps: BlueNoteDeps, mode: BlueNoteMode, text: string, previewPrefix: string): Promise<"preview" | "blue" | null> {
  if (mode === "preview") {
    return (await deps.sendToOwner(`${previewPrefix}\n\n${text}`).catch(sendErr(deps, "owner"))) ? "preview" : null;
  }
  if (mode === "on") {
    if (!(await deps.sendToBlue(text).catch(sendErr(deps, "blue")))) return null;
    // Nothing is hidden from Raziel: a best-effort copy, never a reason to re-send to Blue.
    await deps.sendToOwner(`Sent to Blue:\n\n${text}`).catch(sendErr(deps, "owner_copy"));
    return "blue";
  }
  return null;
}

function onceLog(state: BlueNoteState, key: string, log: (l: string) => void, line: string): void {
  const seen = state.noActivityLogged ?? (state.noActivityLogged = new Set());
  if (seen.has(key)) return;
  seen.add(key);
  log(line);
}

async function claim(redis: BlueRedis, key: string, who: string, ttl: number): Promise<boolean> {
  try { return (await redis.set(key, who, "PX", ttl, "NX")) === "OK"; } catch { return false; }
}
async function unclaim(redis: BlueRedis, key: string): Promise<void> {
  try { await redis.del(key); } catch { /* the in-process attempt cap bounds a stuck claim */ }
}

export function blueLog(line: string): void {
  try { console.log(line); } catch { /* telemetry never breaks a tick */ }
}

/** The daily note. One companion by rotation; Redis NX per Chicago date; no Redis = no send. */
export async function runBlueNoteDay(deps: BlueNoteDeps, state: BlueNoteState): Promise<BlueTickOutcome> {
  const log = deps.log ?? blueLog;
  const mode = (deps.mode ?? blueNoteMode)();
  if (mode === "off") return "off";
  const nowMs = (deps.now ?? Date.now)();
  const { date, hour } = chicagoParts(nowMs);
  if (noteVoiceFor(date) !== deps.companionId) return "not_my_day";
  if ((deps.hour ? deps.hour() : hour) < blueNoteHour()) return "before_hour";
  if (!deps.redis) { onceLog(state, `noredis:${date}`, log, `[blue-note] ${deps.companionId} kind=day date=${date} outcome=no_redis (nothing will send)`); return "no_redis"; }
  if ((state.attempts.get(date) ?? 0) >= MAX_ATTEMPTS) { onceLog(state, `gaveup:${date}`, log, `[blue-note] ${deps.companionId} kind=day date=${date} outcome=gave_up attempts=${MAX_ATTEMPTS}`); return "gave_up"; }

  const notes = await deps.ownNotes().catch(() => []);
  const inputs = buildNoteInputs({ today: date, ownerName: deps.ownerName, roomLines: deps.roomLines(), notes });
  // A day with no word from Raziel in a trusted room is skipped without a claim (activity can still appear later).
  if (!inputs.razielActive) {
    // Logged once per date (2026-11-04): this skip used to be silent, and STM loads lazily per channel, so
    // after an evening restart the tick can see no lines at all. A missing note must leave a trace.
    const seen = state.noActivityLogged ?? (state.noActivityLogged = new Set());
    if (!seen.has(date)) {
      seen.add(date);
      log(`[blue-note] ${deps.companionId} kind=day date=${date} outcome=no_activity lines=${inputs.lines.length} notes=${inputs.notes.length}`);
    }
    return "no_activity";
  }

  const key = DAY_CLAIM_PREFIX + date;
  if (!(await claim(deps.redis, key, deps.companionId, DAY_CLAIM_TTL_MS))) return "not_claimed";
  state.attempts.set(date, (state.attempts.get(date) ?? 0) + 1);

  const composed = await composeBlueNote({ companionId: deps.companionId, ownerName: deps.ownerName, generate: deps.generate, systemPrompt: deps.systemPrompt, genTimeoutMs: deps.genTimeoutMs }, inputs);
  if (!composed.ok) {
    if (composed.reason === "generate_error" || composed.reason === "timeout") {
      await unclaim(deps.redis, key);
      log(`[blue-note] ${deps.companionId} kind=day date=${date} outcome=gen_failed reason=${composed.reason}`);
      return "gen_failed";
    }
    // Rejected output stays claimed: re-rolling the same inputs every minute until one slips through is the wrong rail.
    log(`[blue-note] ${deps.companionId} kind=day date=${date} outcome=rejected reason=${composed.reason}`);
    return "rejected";
  }
  const landed = await deliver(deps, mode, composed.text, PREVIEW_NOTE_PREFIX);
  if (!landed) {
    await unclaim(deps.redis, key);
    log(`[blue-note] ${deps.companionId} kind=day date=${date} outcome=send_failed mode=${mode}`);
    return "send_failed";
  }
  log(`[blue-note] ${deps.companionId} kind=day date=${date} outcome=sent mode=${mode} len=${composed.text.length}`);
  return landed === "blue" ? "sent_blue" : "sent_preview";
}

/** The bad-night heads-up: once per hold (Redis NX on the hold's start time), fixed line. */
export async function runBlueNoteHold(deps: BlueNoteDeps, state: BlueNoteState): Promise<BlueTickOutcome> {
  const log = deps.log ?? blueLog;
  const mode = (deps.mode ?? blueNoteMode)();
  if (mode === "off") return "off";
  const since = deps.holdSince();
  if (!since) return "no_hold";
  const sinceMs = Date.parse(since);
  const nowMs = (deps.now ?? Date.now)();
  if (!Number.isFinite(sinceMs) || nowMs - sinceMs > HOLD_FRESH_MS) return "stale_hold";
  if (!deps.redis) return "no_redis";
  if ((state.attempts.get(since) ?? 0) >= MAX_ATTEMPTS) return "gave_up";

  const key = HOLD_CLAIM_PREFIX + since;
  if (!(await claim(deps.redis, key, deps.companionId, HOLD_CLAIM_TTL_MS))) return "not_claimed";
  state.attempts.set(since, (state.attempts.get(since) ?? 0) + 1);

  const text = holdHeadsUpLine(deps.companionId);
  const landed = await deliver(deps, mode, text, PREVIEW_HOLD_PREFIX);
  if (!landed) {
    await unclaim(deps.redis, key);
    log(`[blue-note] ${deps.companionId} kind=hold outcome=send_failed mode=${mode}`);
    return "send_failed";
  }
  log(`[blue-note] ${deps.companionId} kind=hold outcome=sent mode=${mode} len=${text.length}`);
  return landed === "blue" ? "sent_blue" : "sent_preview";
}

export async function runBlueNoteTick(deps: BlueNoteDeps, state: BlueNoteState): Promise<{ hold: BlueTickOutcome; day: BlueTickOutcome }> {
  // A throw used to vanish here every minute (drop scan 11-05); it now leaves one line per throw.
  const log = deps.log ?? blueLog;
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
  const hold = await runBlueNoteHold(deps, state).catch((e): BlueTickOutcome => { log(`[blue-note] ${deps.companionId} kind=hold outcome=threw err=${why(e)}`); return "send_failed"; });
  const day = await runBlueNoteDay(deps, state).catch((e): BlueTickOutcome => { log(`[blue-note] ${deps.companionId} kind=day outcome=threw err=${why(e)}`); return "gen_failed"; });
  return { hold, day };
}

export const BLUE_NOTE_POLL_MS = 60_000;

export function startBlueNoteScheduler(deps: BlueNoteDeps, pollMs = BLUE_NOTE_POLL_MS): () => void {
  const state = newBlueNoteState();
  const tick = () => { void runBlueNoteTick(deps, state); };
  const first = setTimeout(tick, 30_000);
  const every = setInterval(tick, pollMs);
  return () => { clearTimeout(first); clearInterval(every); };
}
