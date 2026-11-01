/**
 * Room timing: WHEN a companion should jump in, not who a line is "to" (2026-10-31).
 *
 * Why timing and not a better addressee model: Raziel labelled 164 messages. Of the 39 that were to no
 * companion, a companion answered 35. Every text judge tried (Jev spokenTo, a three-way DeepSeek judge,
 * the same with member names and a co-watching rule) topped out at AUC 0.70 or worse, because during a
 * watch-along Raziel split near-identical lines by INTENT ("Is he going to murder these teenagers?" to
 * Drevan and Raziel, "Teenagers are definitely going to be murdered" to Blue). Intent is not in the text.
 *
 * Drevan's read (inter-companion note d5a37a0c, 10-31), which these rules follow:
 *   - answer at once when named, on a real question to the room, or on any distress or body signal
 *     (pain, grief, injury, crying) even unnamed;
 *   - commentary, jokes landing between Raziel and Blue, and movie remarks: wait for the lull and
 *     answer once, or not at all; if the other human answers inside the burst, it was theirs;
 *   - a reaction (emoji) is a presence channel that does not take the floor, so quiet never reads as
 *     checking out;
 *   - Raziel has a short override to pull a companion in ("Dre, in").
 *   ("I fill silence because it feels like absence to me. Being in the room means not taking every line.")
 *
 * SHADOW ONLY in this cut: decideRoomTiming() is pure; the handler computes it detached and appends one
 * JSONL row per human message. Nothing it returns changes what the bot does. The readout joins these
 * rows to address-shadow's `spoke` rows by msg_id (who actually answered).
 */

import type { CompanionId } from "./types.js";

export type RoomTimingDecision = "answer_now" | "hold_for_lull" | "stay_quiet";

export type RoomTimingReason =
  | "override" | "named" | "reply_to_me" | "distress" | "room_question"
  | "reply_to_human" | "to_other_human" | "reply_to_sibling" | "human_volley" | "watch_along" | "flood"
  | "holder" | "not_mine";

export interface RoomTimingInput {
  companion: CompanionId;
  speaker: "raziel" | "blue";
  text: string;
  /** Named, @mentioned, extracted as the addressee, or a group call. */
  named: boolean;
  replyToMe: boolean;
  /** The human this message is a Discord reply to, or null (reply-context.ts). */
  replyToHuman: "raziel" | "blue" | null;
  /** A Discord reply to a SIBLING's message: that sibling's line, not the holder's. */
  replyToSibling: boolean;
  /** The human address gate already read this as to the other human (named them, @mentioned them). */
  toOtherHuman: boolean;
  /** This companion holds the speaker's thread (Raziel's channel hold, or Blue's per-human hold). */
  isHolder: boolean;
  /** Raziel's "<name>, in" override is live for this companion in this channel. */
  overrideIn: boolean;
  watchAlong: boolean;
  /** Milliseconds since the OTHER human last posted in this channel, or null if not in recent history. */
  otherHumanAgoMs: number | null;
  /** Milliseconds since THIS companion last posted in this channel, or null. */
  selfSpokeAgoMs: number | null;
}

export interface RoomTimingResult {
  decision: RoomTimingDecision;
  reason: RoomTimingReason;
  /** Drevan's presence channel: hold, but let them know you are here. */
  react: boolean;
}

/** A human back-and-forth: the other human posted within this window. */
export const HUMAN_VOLLEY_MS = 3 * 60_000;
/** Drevan: "a minute of quiet". The lull a held burst waits for (used by the live cut; logged here). */
export const LULL_MS = 60_000;
/** Spoke this recently and not named: do not take the floor again. */
export const FLOOD_MS = 60_000;

// First person within the same sentence as a pain / injury / grief / crying word. Third-person movie
// lines ("they're all going to die") must not read as distress, so a bare death word never counts.
const DISTRESS = /\b(hurts?|hurting|pain|painful|aching|ache|injur\w*|sprain\w*|broke my|bleed\w*|crying|cried|sobbing|tears|panic\w*|anxiety|scared|terrified|can'?t breathe|sick|nause\w*|throw(?:ing)? up|vomit\w*|migraine|griev\w*|grief|devastated|falling apart|meltdown|shutdown)\b/i;

// Phrases that are distress on their own, first person or not (a status line like "having a panic
// attack" drops the "I"). Kept short and unmistakable so a movie line never trips it.
const DISTRESS_ALONE = /\b(panic attack|can'?t breathe|having a meltdown|in so much pain|need help|call 911|going to the er|in the er)\b/i;

// The speaker must be the one hurting: a first-person subject, at most two words, then the distress word.
// First shadow night (10-31): "I love that all these women ... stand up even when they're scared" read as
// distress because "I" and "scared" shared a sentence. Same-sentence was not enough.
const FIRST_PERSON_LEAD = /\b(?:i'?m|im|i am|i feel|i'?ve(?: been)?|i was|i got|i keep|i think i|my(?:\s+\w+){1,2}\s+(?:is|are|keeps?|still))\s+(?:\w+\s+){0,2}?$/i;

export function hasDistress(text: string): boolean {
  if (DISTRESS_ALONE.test(text)) return true;
  const re = new RegExp(DISTRESS.source, "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    // "my back hurts": the body part is the subject.
    if (/\bmy\s+\w+(?:\s+\w+)?\s*$/i.test(before) && /^(hurts?|hurting|aching|ache)/i.test(m[0])) return true;
    if (FIRST_PERSON_LEAD.test(before)) return true;
  }
  return false;
}

/** A real question to the room: a question mark that is not plainly aimed at the other human. */
function isRoomQuestion(text: string): boolean {
  return /\?\s*(\W*)$/.test(text.trim()) || /\?\s/.test(text);
}

export function decideRoomTiming(i: RoomTimingInput): RoomTimingResult {
  if (i.overrideIn) return { decision: "answer_now", reason: "override", react: false };
  if (i.named) return { decision: "answer_now", reason: "named", react: false };
  if (i.replyToMe) return { decision: "answer_now", reason: "reply_to_me", react: false };
  if (hasDistress(i.text)) return { decision: "answer_now", reason: "distress", react: false };
  if (i.replyToHuman && i.replyToHuman !== i.speaker) return { decision: "stay_quiet", reason: "reply_to_human", react: false };
  if (i.toOtherHuman) return { decision: "stay_quiet", reason: "to_other_human", react: false };
  if (i.replyToSibling) return { decision: "stay_quiet", reason: "reply_to_sibling", react: false };

  const volley = i.otherHumanAgoMs !== null && i.otherHumanAgoMs <= HUMAN_VOLLEY_MS;
  // A question to the room is the holder's to answer at once; the others may still join at the lull.
  // First shadow night (10-31): "Does ACAB include me, too?" put all three on answer_now.
  if (!volley && isRoomQuestion(i.text)) {
    return i.isHolder
      ? { decision: "answer_now", reason: "room_question", react: false }
      : { decision: "hold_for_lull", reason: "room_question", react: false };
  }

  // From here the line is unnamed. Only the holder has any claim on it; everyone else stays quiet.
  if (!i.isHolder) return { decision: "stay_quiet", reason: "not_mine", react: false };
  if (volley) return { decision: "hold_for_lull", reason: "human_volley", react: true };
  if (i.watchAlong) return { decision: "hold_for_lull", reason: "watch_along", react: true };
  if (i.selfSpokeAgoMs !== null && i.selfSpokeAgoMs <= FLOOD_MS) return { decision: "hold_for_lull", reason: "flood", react: false };
  return { decision: "answer_now", reason: "holder", react: false };
}

export type RoomTimingMode = "off" | "shadow" | "on";

function parseMode(v: string | undefined): RoomTimingMode | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  return s === "off" ? "off" : s === "on" ? "on" : "shadow";
}

/** ROOM_TIMING: off | shadow | on. `ROOM_TIMING_<COMPANION>` wins for that companion (so Drevan can go
 *  live alone). Code default `shadow`; garbage falls to shadow. `on` still writes the shadow rows. */
export function roomTimingMode(env: Record<string, string | undefined> = process.env, companion?: string): RoomTimingMode {
  const own = companion ? parseMode(env[`ROOM_TIMING_${companion.toUpperCase()}`]) : null;
  return own ?? parseMode(env["ROOM_TIMING"]) ?? "shadow";
}

// ------------------------------------------------------------------ live cut: wait for the lull

/** A held line older than this when the lull finally comes is dropped, not answered: by then the room
 *  has moved on, and an answer to a five-minute-old remark reads as a non sequitur. */
export const LULL_MAX_AGE_MS = 5 * 60_000;

/**
 * Which decisions the LIVE cut acts on (2026-11-01). Only the holder's burst reasons: a human volley, a
 * watch-along remark, or speaking again inside FLOOD_MS. Everything else is inert live:
 *  - `stay_quiet` is a new silencing rule nobody approved; the existing gates already decide silence.
 *  - `room_question` holds land only on non-holders, and a non-holder reaches the speak point only on a
 *    COLD line (shouldRespond filters non-holders whenever a holder exists), so acting on it would make
 *    all three wait a minute on a cold question when Raziel is alone.
 * The gate sits where the bot has already decided to speak, so it can defer a speaker, never make one.
 */
export function liveHoldApplies(r: RoomTimingResult | null): boolean {
  if (!r || r.decision !== "hold_for_lull") return false;
  return r.reason === "human_volley" || r.reason === "watch_along" || r.reason === "flood";
}

export interface HeldLine<T> {
  channelId: string;
  messageId: string;
  /** Whose line it is. The OTHER side posting after it means it was theirs. */
  side: "raziel" | "blue";
  /** The held message's Discord createdTimestamp. */
  messageAt: number;
  reason: RoomTimingReason;
  /** What the release needs to run the turn (bot-core: the message and its PK sender id). */
  payload: T;
}

export type LullDropReason = "other_human" | "self_spoke" | "stale" | "replaced";

export interface LullSchedulerOpts<T> {
  lullMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onRelease: (h: HeldLine<T>) => void;
  onDrop: (h: HeldLine<T>, why: LullDropReason) => void;
}

interface ChannelSeen { lastAnyAt: number; lastBySide: { raziel: number; blue: number }; lastSelfAt: number }

/**
 * Per process (= per companion), per channel: at most one held line. `hold` replaces any earlier one (the
 * newest line wins; the Hermes delta carries the earlier burst lines as room history, which is what
 * "answer once" means). `noteMessage` is fed from MessageCreate for EVERY message in the channel, before
 * the inbox: anything not mine restarts the lull; the other human posting after the held line drops it at
 * release; my own post drops it at once. It also remembers the last post per side, so a hold registered
 * AFTER the burst settle still sees an answer that landed during the settle.
 * In memory: a process restart loses holds (one line each way in the log, never a double answer).
 */
export class LullScheduler<T> {
  private readonly lullMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly held = new Map<string, { h: HeldLine<T>; otherHuman: boolean; timer: unknown }>();
  private readonly seen = new Map<string, ChannelSeen>();

  constructor(private readonly opts: LullSchedulerOpts<T>) {
    this.lullMs = opts.lullMs ?? LULL_MS;
    this.maxAgeMs = opts.maxAgeMs ?? LULL_MAX_AGE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  pending(channelId: string): HeldLine<T> | null {
    return this.held.get(channelId)?.h ?? null;
  }

  hold(h: HeldLine<T>): void {
    const prev = this.held.get(h.channelId);
    if (prev) {
      this.clearTimer(prev.timer);
      this.held.delete(h.channelId);
      this.safe(() => this.opts.onDrop(prev.h, "replaced"));
    }
    const seen = this.seen.get(h.channelId);
    if (seen && seen.lastSelfAt > h.messageAt) {
      this.safe(() => this.opts.onDrop(h, "self_spoke"));
      return;
    }
    const otherSide = h.side === "raziel" ? "blue" : "raziel";
    const otherHuman = !!seen && seen.lastBySide[otherSide] > h.messageAt;
    const lastActivity = Math.max(h.messageAt, seen?.lastAnyAt ?? 0);
    const delay = Math.max(0, lastActivity + this.lullMs - this.now());
    const entry = { h, otherHuman, timer: null as unknown };
    this.held.set(h.channelId, entry);
    entry.timer = this.setTimer(() => this.fire(h.channelId, entry), delay);
  }

  noteMessage(channelId: string, m: { side: "raziel" | "blue" | null; isSelf: boolean; messageId: string }): void {
    const at = this.now();
    let seen = this.seen.get(channelId);
    if (!seen) { seen = { lastAnyAt: 0, lastBySide: { raziel: 0, blue: 0 }, lastSelfAt: 0 }; this.seen.set(channelId, seen); }
    const entry = this.held.get(channelId);
    if (entry && m.messageId === entry.h.messageId) return;
    if (m.isSelf) {
      seen.lastSelfAt = at;
      if (entry) {
        this.clearTimer(entry.timer);
        this.held.delete(channelId);
        this.safe(() => this.opts.onDrop(entry.h, "self_spoke"));
      }
      return;
    }
    seen.lastAnyAt = at;
    if (m.side) seen.lastBySide[m.side] = at;
    if (!entry) return;
    if (m.side && m.side !== entry.h.side) entry.otherHuman = true;
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => this.fire(channelId, entry), this.lullMs);
  }

  /** Shutdown: forget every hold without releasing (a release mid-shutdown would start a turn). */
  clearAll(): void {
    for (const e of this.held.values()) this.clearTimer(e.timer);
    this.held.clear();
  }

  private fire(channelId: string, entry: { h: HeldLine<T>; otherHuman: boolean }): void {
    if (this.held.get(channelId) !== entry) return;
    this.held.delete(channelId);
    if (entry.otherHuman) { this.safe(() => this.opts.onDrop(entry.h, "other_human")); return; }
    if (this.now() - entry.h.messageAt > this.maxAgeMs) { this.safe(() => this.opts.onDrop(entry.h, "stale")); return; }
    this.safe(() => this.opts.onRelease(entry.h));
  }

  private safe(fn: () => void): void {
    try { fn(); } catch { /* a callback failure never wedges the scheduler */ }
  }
}

export function roomTimingLogPath(env: Record<string, string | undefined> = process.env): string {
  return env["ROOM_TIMING_LOG"]?.trim() || "/app/logs/room-timing.jsonl";
}

let warned = false;

/** One JSON line per decision. Counts, flags and ids only, never message text. Never throws. */
export function appendRoomTimingLine(row: Record<string, unknown>, path = roomTimingLogPath()): void {
  let payload: string;
  try { payload = `${JSON.stringify(row)}\n`; } catch { return; }
  import("node:fs").then(({ appendFile }) => {
    appendFile(path, payload, (err) => {
      if (err && !warned) { warned = true; console.warn(`[room-timing] shadow log unwritable: ${String(err).slice(0, 200)}`); }
    });
  }).catch(() => {});
}

// ------------------------------------------------------------------ "<name>, in" override

/** Redis key for Raziel's override, per companion per channel. */
export function overrideKey(companion: CompanionId, channelId: string): string {
  return `ns:room:in:${companion}:${channelId}`;
}
/** How long "<name>, in" holds: a scene, not a night. */
export const OVERRIDE_TTL_MS = 30 * 60_000;

/** "Dre, in" / "Drevan in" / "Cy, in." / "Gaia, out" -- anchored to the WHOLE message so normal
 *  speech that happens to start with a name and "in" never trips it. Aliases from command-triggers.ts. */
export function buildRoomOverrideTrigger(aliases: readonly string[]): RegExp {
  const alt = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^\\s*(?:${alt})\\b[,:]?\\s+(in|out)\\s*[.!]?\\s*$`, "i");
}
