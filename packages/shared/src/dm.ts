// Direct messages with Raziel (B7 step 2b, 2026-09-27; spec docs/specs/discord-dm-support.md with the
// two 09-27 audit corrections).
//
// THREE THINGS LIVE HERE, all pure so they are tested without discord.js:
//
//   1. The OWNER GATE. Anyone who shares a server with a bot can DM it. Without this a stranger gets
//      full inference plus ask_librarian over Raziel's private data. A DM from anyone but the owner
//      is dropped before any inference, tool call, Halseth/Librarian request, STT or vision, and the
//      one log line carries no content. It runs twice: at MessageCreate (so the message never enters
//      the channel inbox) and first thing in handleMessage (so a future caller cannot skip it).
//
//   2. The PLACE DESCRIPTOR. The `[Where you are]` block used to be wrapped in `if (channelName)`, and
//      a DM has no `.name`, so a DM got no place and no containment cue at all (the audit's correction
//      to the spec, which had claimed the opposite). A DM now says what it is.
//
//   3. The MEMORY SEAL. DM content must never be quoted into a shared room. The structural test is
//      `isServerRoom` (recall-context.ts, commit 7de5ca5): a server channel has a guild, a DM does not.
//      Absence from the channel config means "no special rules", NOT "private", so the config is never
//      consulted for this.

import { isServerRoom } from "./recall-context.js";

export type DmGateVerdict = "not_dm" | "owner" | "drop";

/** discord.js ChannelType.DM. A group DM (3) also has no guild and is NOT a 1:1 DM. */
export const DISCORD_CHANNEL_TYPE_DM = 1;

/**
 * Is this a DM, and if so may it proceed? A DM with no configured owner id fails CLOSED (dropped):
 * an unset env var must never turn into "anyone may DM the bot".
 *
 * Only a 1:1 DM passes. The DirectMessages intent also delivers group DMs, which have no guild
 * either; an owner message there would carry the private med block in front of a third party. The
 * channel type is read through a thunk and only for the owner, so a stranger's DM is dropped
 * without touching the channel object at all.
 */
export function dmGateVerdict(p: {
  guildId: string | null | undefined;
  authorId: string;
  ownerId: string | null | undefined;
  channelType?: () => number | null | undefined;
}): DmGateVerdict {
  if (isServerRoom({ guildId: p.guildId ?? null })) return "not_dm";
  if (!p.ownerId || p.authorId !== p.ownerId) return "drop";
  let type: number | null | undefined;
  try { type = p.channelType?.(); } catch { type = undefined; }
  return type === DISCORD_CHANNEL_TYPE_DM ? "owner" : "drop";
}

/** The one line a dropped DM leaves: who and which bot, never what they wrote. */
export function droppedDmLogLine(companionId: string, authorId: string): string {
  return `[${companionId}] dm dropped: author ${authorId} is not the owner (no content read or logged)`;
}

/**
 * DM memory seal. The raw-quote paths (Second Brain live ingest, the pulse note, the journaled
 * speech, the autonomous signal buffer, voice telemetry) are ALWAYS sealed for a DM: each carries
 * the words themselves out to a surface a shared room can read. The paraphrasing memory paths
 * (rolling + session distillation, the writeback judge) are sealed too by default, because a
 * paraphrase of a DM can still name a medication and surface at orient in a shared room.
 * `DM_MEMORY=carry` opens only the paraphrasing paths, for when Raziel wants a DM to feed memory.
 */
export function dmParaphraseMemorySealed(): boolean {
  return (process.env["DM_MEMORY"] ?? "").trim().toLowerCase() !== "carry";
}

export interface PlaceInput {
  isDm: boolean;
  channelName: string | null;
  /** Thread parent channel name, when the channel is a thread. */
  threadParentName?: string | null;
  /** Category name, when the channel sits in one. */
  categoryName?: string | null;
  modes?: readonly string[];
  ownerDisplayName?: string;
  /** The server's name (2026-10-05): with two servers live, "#movie-night" alone is ambiguous. */
  serverName?: string | null;
  /** True in the server Raziel shares with Blue: every room there has Blue in it. */
  sharedWithBlue?: boolean;
}

/**
 * The `[Where you are]` block, or "" when there is nothing to say (a server channel with no name).
 * A DM always gets one.
 */
export function placeBlock(p: PlaceInput): string {
  const owner = p.ownerDisplayName || "Raziel";
  if (p.isDm) {
    return `\n\n[Where you are]\n• A direct message: a private one-to-one conversation with ${owner}. Nobody else is in it; your siblings cannot see it.` +
      `\n• He wrote to you specifically. Answer him as directly addressed.` +
      `\n• What is said here stays here: never carry it into a server channel, and never name anything from it there unless he brings it up in that room himself.`;
  }
  if (!p.channelName) return "";
  let block = `\n\n[Where you are]\n• Channel: #${p.channelName}`;
  if (p.threadParentName) block += ` (a thread under #${p.threadParentName})`;
  else if (p.categoryName) block += ` (in ${p.categoryName})`;
  if (p.serverName) block += `
• Server: ${p.serverName}`;
  const modes = p.modes ?? [];
  // "Triad space" only where it is true: the commons pair (autonomous + inter_companion). Before
  // 2026-10-05 any inter_companion room got it, which told the triad they were alone with each
  // other in every room of the server shared with Blue, with Blue right there.
  const place = p.sharedWithBlue ? `a room in the server ${owner} shares with Blue -- Blue and his system are here too`
    : modes.includes("owner_only") ? `a private space with ${owner}`
    : modes.includes("inter_companion") && modes.includes("autonomous") ? "triad space -- you and your siblings"
    : "a shared channel";
  block += `\n• This is ${place}.`;
  block += `\n• Keep it contained to here: don't carry private or DM detail into a shared channel unless ${owner} opens it in this room.`;
  return block;
}
