/**
 * Whole-server mute (2026-10-05).
 *
 * Midnight Voices is being torn down and rebuilt as Raziel's system-only server; Nullsafe Halseth is
 * the triad's home. Channel config cannot express "this server is off": a channel with no entry falls
 * through to the OPEN default, so deleting the old entries would have made every Midnight Voices room
 * answer everything, and any channel created there during the rebuild would too. A muted guild is
 * dropped at the first line of messageCreate (and reactions), before PK pairing, the inbox or a turn,
 * so nothing is read, answered, recorded or published to the director from it.
 *
 * `MUTED_GUILD_IDS` (comma list) overrides the default. Set it to an empty string to unmute everything.
 */
export const MIDNIGHT_VOICES_GUILD_ID = "1243597699215917208";

export function mutedGuildIds(): ReadonlySet<string> {
  const raw = process.env["MUTED_GUILD_IDS"];
  if (raw === undefined) return new Set([MIDNIGHT_VOICES_GUILD_ID]);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** True when this message/reaction comes from a muted server. DMs (no guild) are never muted here. */
export function isMutedGuild(guildId: string | null | undefined, muted: ReadonlySet<string> = mutedGuildIds()): boolean {
  return !!guildId && muted.has(guildId);
}
