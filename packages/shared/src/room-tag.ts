// room-tag.ts -- human-readable room provenance for memories written from Discord (2026-10-05).
//
// Raziel's report: the triad now lives in two servers (home "Nullsafe Halseth" and the one shared with
// Blue), and every memory they wrote carried only `channel:<snowflake>`. Recalled later -- on Claude.ai,
// or in another room -- nothing said WHERE it happened, so they confused where memories came from.
//
// The fix is a second transport tag alongside the id: `room:<server>/#<channel>` (a thread is
// `room:<server>/#<parent>/<thread>`). It goes in `tags`, never in note_text (halseth
// webmind/journal-lanes.ts), and halseth's renderers (src/mind/room-label.ts) turn it into
// `(#movie-night, Nullsafe Halseth)` at read time.
//
// DMs get NO room tag, structurally: a channel with no guild returns null. A DM's provenance must never
// be rendered into a shared room, and the simplest way to guarantee that is to never write it.
//
// Names come from the discord.js objects at write time, so a renamed channel keeps the name it had when
// the memory was made -- which is the name the memory was made under.

/** Per-part cap. A room tag is a label, not a description. */
export const ROOM_PART_MAX = 60;

/**
 * Make one name part safe to sit inside a tag: control characters (newlines included), quotes and
 * backslashes become spaces, whitespace collapses, length caps. Quotes/backslashes are dropped because
 * the tag lands in a JSON array that halseth matches with LIKE; an escaped quote there is a needless trap.
 */
export function sanitizeRoomPart(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_PART_MAX)
    .trim();
}

/** The minimal discord.js shape this needs. Structural, so tests need no client. */
export interface RoomChannelLike {
  name?: unknown;
  isThread?: () => boolean;
  parent?: { name?: unknown } | null;
}
export interface RoomGuildLike {
  name?: unknown;
}

/**
 * `room:<server>/#<channel>` or `room:<server>/#<parent>/<thread>`, or null when there is no guild (a DM)
 * or no usable channel name. The server part has `/#` folded to `/` so the reader's split on the FIRST
 * `/#` always lands on the server/channel boundary.
 */
export function roomTagFor(
  guild: RoomGuildLike | null | undefined,
  channel: RoomChannelLike | null | undefined,
): string | null {
  if (!guild || !channel) return null;                       // no guild = DM: never tagged
  const server = sanitizeRoomPart(guild.name).replace(/\/#/g, "/");
  const name = sanitizeRoomPart(channel.name);
  if (!server || !name) return null;
  let isThread = false;
  try { isThread = typeof channel.isThread === "function" && channel.isThread(); } catch { isThread = false; }
  if (isThread) {
    const parent = sanitizeRoomPart(channel.parent?.name).replace(/\//g, " ");
    if (parent) return `room:${server}/#${parent}/${name}`;
  }
  return `room:${server}/#${name.replace(/\//g, " ")}`;
}

/** Convenience for a discord.js Message: `message.guild` + `message.channel`. Never throws. */
export function roomTagForMessage(message: { guild?: RoomGuildLike | null; channel?: unknown }): string | null {
  try {
    return roomTagFor(message.guild ?? null, (message.channel ?? null) as RoomChannelLike | null);
  } catch {
    return null;
  }
}
