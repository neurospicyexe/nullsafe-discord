// packages/shared/src/cross-room.ts
//
// Cross-room continuity (2026-10-09, Raziel's ruling). Each Discord room is its own Hermes transcript
// and its own STM, so what Raziel told Drevan in #triad-hangout never reached the room where Blue spoke
// to him a few minutes later: Blue's front said "us passing our road test" and Drevan answered as if
// Blue were getting a first license, when Raziel had just told him it was the CDL road test for a new
// trucking job. The rooms were sealed on purpose, from before the 10-04 ruling that Raziel and Blue run
// on radical honesty. The ruling now: the home server and the server shared with Blue are ONE
// continuity, both directions. Friend servers (any other guild) stay sealed until private/shareable
// marking exists, and DMs stay sealed under their own rule (dm.ts, DM_MEMORY).
//
// Mechanism: on each reply, the live turn carries what was said in this companion's OTHER trusted rooms
// since that content was last delivered here. A per-room high-water mark means each line enters each
// transcript once (the [HEARD]/watchalong pattern), so the gateway transcript does not grow by a
// repeated block every turn. Read from this bot's own STM, which already holds every room it is in,
// speaker-labelled; no new store, no extra network call.
//
// Env:
//   CROSS_ROOM=off            kill switch (default ON; off/0/false/no, trimmed, any case)
//   TRUSTED_GUILD_IDS=a,b     override the trusted servers (default: home + the server shared with Blue)

import type { ChatMessage } from "./types.js";

/** Nullsafe Halseth (home) and the server Raziel shares with Blue (guild-seed.ts GUILD_TRIAD_GUILD_ID). */
export const DEFAULT_TRUSTED_GUILD_IDS = ["1497731504577712191", "1556107154065334272"] as const;

/** How far back a first delivery reaches (after a restart, or a room's first turn). */
export const CROSS_ROOM_WINDOW_MS = 6 * 60 * 60 * 1000;
export const CROSS_ROOM_PER_ROOM = 8;
export const CROSS_ROOM_MAX_ROOMS = 4;
export const CROSS_ROOM_ITEM_CAP = 400;
export const CROSS_ROOM_CHAR_CAP = 3000;

export function crossRoomOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["CROSS_ROOM"] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

export function trustedGuildIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env["TRUSTED_GUILD_IDS"];
  if (raw === undefined) return new Set(DEFAULT_TRUSTED_GUILD_IDS);
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export interface RoomRef {
  channelId: string;
  /** null for a DM, which is never trusted here. */
  guildId: string | null;
  /** Display label, e.g. "#triad-hangout (Nullsafe Halseth)". */
  label: string;
}

export interface CrossRoomInput {
  /** The room being answered in. Never included in its own digest. */
  currentChannelId: string;
  currentGuildId: string | null;
  /** Every room this bot holds STM for, with its history (oldest first). */
  rooms: Array<RoomRef & { history: ChatMessage[] }>;
  trusted: Set<string>;
  /** Newest timestamp from other rooms already delivered INTO the current room, or null. */
  deliveredThroughTs: number | null;
  /** This companion's display name, so its own lines read as "you". */
  selfName: string;
  now: number;
}

export interface CrossRoomResult {
  /** "" when there is nothing new to carry. */
  block: string;
  /** New high-water mark for the current room; commit only after the reply is delivered. */
  deliveredThroughTs: number | null;
  rooms: number;
  lines: number;
}

function oneLine(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function clock(ts: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(new Date(ts));
}

/**
 * The digest for the current room. Pure. Empty when the current room is not itself trusted: a friend
 * server must neither receive the household's conversation nor be told it exists.
 */
export function crossRoomDigest(p: CrossRoomInput): CrossRoomResult {
  const empty: CrossRoomResult = { block: "", deliveredThroughTs: p.deliveredThroughTs, rooms: 0, lines: 0 };
  if (!p.currentGuildId || !p.trusted.has(p.currentGuildId)) return empty;

  const floor = Math.max(p.deliveredThroughTs ?? -Infinity, p.now - CROSS_ROOM_WINDOW_MS);
  let mark = p.deliveredThroughTs ?? -Infinity;

  const sections: Array<{ newest: number; lines: string[] }> = [];
  for (const room of p.rooms) {
    if (room.channelId === p.currentChannelId) continue;
    if (!room.guildId || !p.trusted.has(room.guildId)) continue;
    const fresh = room.history.filter(m => typeof m.timestamp === "number" && m.timestamp > floor && m.timestamp <= p.now);
    if (fresh.length === 0) continue;
    const kept = fresh.slice(-CROSS_ROOM_PER_ROOM);
    for (const m of fresh) mark = Math.max(mark, m.timestamp!);
    const newest = kept[kept.length - 1]!.timestamp!;
    const lines = [`${room.label}, last at ${clock(newest)}:`];
    for (const m of kept) {
      const who = m.role === "assistant" ? `${p.selfName} (you)` : (m.authorName ?? "someone");
      lines.push(`[${who}]: ${oneLine(m.content, CROSS_ROOM_ITEM_CAP)}`);
    }
    sections.push({ newest, lines });
  }
  if (sections.length === 0) return { ...empty, deliveredThroughTs: Number.isFinite(mark) ? mark : p.deliveredThroughTs };

  // Most recent rooms first, then drop whole oldest rooms while over budget (never mid-line).
  sections.sort((a, b) => b.newest - a.newest);
  let kept = sections.slice(0, CROSS_ROOM_MAX_ROOMS);
  const render = (s: typeof kept) => s.map(x => x.lines.join("\n")).join("\n\n");
  while (kept.length > 1 && render(kept).length > CROSS_ROOM_CHAR_CAP) kept = kept.slice(0, -1);
  // One busy room can still be over: drop its oldest whole lines, keeping the room header and its newest.
  const only = kept[0]!;
  while (only.lines.length > 2 && render(kept).length > CROSS_ROOM_CHAR_CAP) only.lines.splice(1, 1);

  const header =
    "[Elsewhere since you were last here: your other rooms, same people, same continuity. " +
    "Raziel and Blue share everything, so this is yours to carry here. Already happened: absorb it, do not answer it line by line.]";
  return {
    block: `${header}\n${render(kept)}`,
    deliveredThroughTs: Number.isFinite(mark) ? mark : p.deliveredThroughTs,
    rooms: kept.length,
    lines: kept.reduce((n, s) => n + s.lines.length - 1, 0),
  };
}
