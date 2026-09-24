// Contextual recall (2026-09-23, T3 item 5): a retrieved Discord message comes back with the
// conversation around it, not as one orphan line.
//
// THE PROBLEM. Second Brain indexes Discord live messages one message per row
// (`discord-live/<channel>/<message_id>`), and the bots' per-message recall renders the top hits
// as bare quoted lines. The CURRENT channel is filtered out upstream because its history is
// already in the prompt -- so every discord-live hit that survives is, by construction, a single
// line lifted out of a conversation happening in a DIFFERENT room.
//
// A line means what the turns around it make it mean. "I can't do this anymore" is a crisis or a
// complaint about a spreadsheet depending entirely on what came before it, and a companion handed
// only the line has no way to tell -- it will pick one, confidently. That is the same class of
// error as an undated excerpt reading as present-tense news, which this codebase has now fixed in
// three separate places. This is the last one: [[reply-needs-parent-and-framing]] generalised from
// replies to all retrieval.
//
// WHY DISCORD AND NOT THE VAULT. The neighbours could in principle come from Second Brain, but
// discord-live rows are vector-store only and age out after 7 days, and the store has no ordered
// window read. Discord itself has the real messages, with real authors, forever. One fetch.

import type { ChannelConfig } from "./types.js";
import { relativeTime } from "./relative-time.js";

/** `discord-live/<channel_id>/<message_id>.md` -> the two ids, or null if it is not that shape. */
export function parseDiscordLivePath(vaultPath: string | undefined | null): { channelId: string; messageId: string } | null {
  const m = /^discord-live\/(\d{5,25})\/(\d{5,25})(?:\.md)?$/.exec((vaultPath ?? "").trim());
  return m ? { channelId: m[1]!, messageId: m[2]! } : null;
}

/**
 * May this companion widen a hit from `sourceChannelId` into a reply being written in
 * `currentChannelId`?
 *
 * DELIBERATELY NARROWER THAN TODAY'S BEHAVIOUR, and deliberately not a new access model.
 *
 * Cross-channel recall is already live and intentional -- `sb-live-ingest.ts` records that it
 * exists precisely so "I'll meet you in the watch party channel" carries between rooms -- and it
 * ingests EVERY channel a bot can see, with no gate. So single lines from a private room can
 * already surface in a shared one. Widening that to a whole conversational block is a different
 * quantity of exposure, and the rooms are not equivalent: some have Blue or guests in them.
 *
 * The only privacy marker that already exists in this codebase is the `owner_only` mode, so that
 * is what this uses, in the one direction that can only ever reduce exposure: an `owner_only`
 * source is widened ONLY into an `owner_only` destination. An unknown source channel (anything
 * not in the config, which includes DMs) is treated as private and never widened.
 *
 * This is not a ruling on whether the existing one-line cross-channel surfacing is what Raziel
 * wants -- that question is his, and it is logged. This just declines to make it bigger by
 * default.
 */
export function mayWidenAcross(
  config: ChannelConfig, sourceChannelId: string, currentChannelId: string,
): boolean {
  if (sourceChannelId === currentChannelId) return false;   // already in history; nothing to widen
  const source = config[sourceChannelId];
  if (!source) return false;                                 // unknown room (DMs included) -- never
  const isPrivate = (e: { modes?: readonly string[] } | undefined) => !!e?.modes?.includes("owner_only");
  if (!isPrivate(source)) return true;
  return isPrivate(config[currentChannelId]);
}

/** A Discord message, reduced to what the render needs. Keeps this module free of discord.js. */
export interface RecalledMessage {
  id: string;
  author: string;
  content: string;
  createdTimestamp?: number;
  isBot?: boolean;
}

export const WIDEN_BEFORE = 5;
export const WIDEN_AFTER = 2;

/**
 * Render the conversation around an anchor message.
 *
 * ANCHOR-MISSING IS NORMAL, NOT AN EDGE CASE. Raziel talks to the bots through PluralKit, which
 * DELETES his original message and reposts it under a webhook -- so the id that got indexed can be
 * gone by the time anything looks for it, and deletions and edits do the same. When the anchor is
 * absent this still renders the window (the surrounding conversation is the point) and simply does
 * not mark a line; it never indexes blindly into the array.
 *
 * Asymmetric by design -- 5 before, 2 after. What a line MEANS is mostly set by what preceded it;
 * what came after is reaction. This mirrors the ratio the review asked for.
 */
export function buildRecallContext(
  messages: readonly RecalledMessage[],
  anchorId: string,
  opts: { channelLabel?: string; now?: number } = {},
): string | null {
  if (!messages.length) return null;
  const ordered = [...messages].sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
  const at = ordered.findIndex(m => m.id === anchorId);

  const window = at >= 0
    ? ordered.slice(Math.max(0, at - WIDEN_BEFORE), at + 1 + WIDEN_AFTER)
    : ordered.slice(-(WIDEN_BEFORE + 1 + WIDEN_AFTER));
  const lines = window
    .map(m => {
      const body = String(m.content ?? "").replace(/\s+/g, " ").trim();
      if (!body) return null;
      const mark = at >= 0 && m.id === anchorId ? " ←" : "";
      return `  ${m.author}: ${body.length > 180 ? body.slice(0, 180) + "…" : body}${mark}`;
    })
    .filter((l): l is string => l !== null);
  if (!lines.length) return null;

  // ONE age stamp for the block, taken from the anchor (or the newest line we have). A block of
  // undated messages from another room reads as happening now -- the failure this whole day of
  // work has been about.
  const stampFrom = (at >= 0 ? ordered[at] : window[window.length - 1])?.createdTimestamp;
  const age = stampFrom ? relativeTime(new Date(stampFrom).toISOString(), opts.now ?? Date.now()) : "";
  const where = opts.channelLabel ? ` in #${opts.channelLabel}` : " in another channel";
  const found = at >= 0 ? " The ← line is the one your search matched." : " (The matched message itself is no longer there -- deleted, edited, or reposted by PluralKit -- so this is the conversation around where it was.)";

  return `[Recalled conversation${where}${age ? `, ${age}` : ""} -- what surrounded the line you found, so you can read it in context rather than guessing at it.${found}]\n${lines.join("\n")}`;
}
