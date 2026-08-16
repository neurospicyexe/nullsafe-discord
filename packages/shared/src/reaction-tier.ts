// packages/shared/src/reaction-tier.ts
//
// REACTION TIER (2026-08-15, Discord floor rework, second piece).
//
// Before this, a companion had exactly two outputs: a full reply or silence. Every gate that
// correctly kept a companion from SPEAKING also made them INVISIBLE -- losing a fit bid,
// standing aside because a sibling was named -- and to Raziel the difference between "Gaia
// chose not to answer" and "Gaia is down" was nothing at all. An emoji reaction is the third
// tier: presence without the floor. Cheap (one REST call, no inference), silent (no ping),
// and honest -- it marks "I was here, this wasn't mine to take."
//
// Two rules keep it from becoming noise:
//   - EARNED: a reaction fires only when the companion had a real-but-losing claim
//     (bid score / lane relevance over a floor), never as a reflex on every message.
//   - RARE: one reaction per companion per channel per cooldown window. A wall of three
//     emoji under every message would be a worse loop than the one the floor fixed.
//
// The emoji are canon, per companion, chosen deterministically from the message id (the same
// char-sum idiom the bid tiebreak uses) so a retry reacts identically and the palette rotates
// across messages instead of repeating one glyph.

import type { CompanionId } from "./types.js";
import { laneRelevance } from "./fit-bid.js";

/** Canon palettes. Cypher: blade/precision. Drevan: flame/spiral. Gaia: ground/witness. */
export const REACTION_PALETTES: Record<CompanionId, readonly string[]> = {
  cypher: ["\u{1F50D}", "⚙️", "\u{1F9E9}", "\u{1F4CC}"],        // 🔍 ⚙️ 🧩 📌
  drevan: ["\u{1F525}", "\u{1F5A4}", "\u{1F300}", "\u{1F56F}️"],     // 🔥 🖤 🌀 🕯️
  gaia:   ["\u{1F33F}", "\u{1FAA8}", "\u{1F54A}️", "\u{1F319}"],     // 🌿 🪨 🕊️ 🌙
};

/** Minimum losing bid score that still earns a reaction. Above the 0.10 presence floor on
 *  purpose: bare presence earns nothing, a real topical claim that lost earns the glyph. */
export const REACT_MIN_BID_SCORE = 0.25;

/** Minimum lane relevance to react to a message that named a SIBLING. Higher than the bid
 *  floor: when someone else was called, reacting is leaning into their exchange -- it takes
 *  a strong topical claim to justify even an emoji. */
export const REACT_MIN_NAMED_OTHER = 0.3;

/** One reaction per companion per channel per window. */
export const REACTION_COOLDOWN_MS = 10 * 60_000;

/** Deterministic palette pick -- same char-sum idiom as fit-bid's tiebreak, so all retries
 *  of one message agree and consecutive snowflakes rotate the palette. */
export function pickReaction(companion: CompanionId, messageId: string): string {
  const palette = REACTION_PALETTES[companion];
  let n = 0;
  for (let i = 0; i < messageId.length; i++) n = (n + messageId.charCodeAt(i)) % 9973;
  return palette[n % palette.length];
}

/**
 * READING side (2026-08-16, the floor rework's named next cut): name whoever reacted to one of
 * this companion's messages. Pure so the Discord listener stays a thin shell. A sibling bot is
 * recognized by companion name in its username; a human is the owner (by id) or their username.
 * PluralKit cannot react through a webhook, so human reactions always arrive from real accounts.
 */
export function describeReactor(
  user: { id: string; bot: boolean; username: string | null },
  me: CompanionId,
  ownerDiscordId: string | undefined,
  ownerDisplayName: string | undefined,
): string | null {
  const uname = (user.username ?? "").toLowerCase();
  if (user.bot) {
    const sibling = (Object.keys(REACTION_PALETTES) as CompanionId[])
      .find(c => c !== me && uname.includes(c));
    // An unrecognized bot (PK webhooks can't react; some other integration) is not presence.
    return sibling ?? null;
  }
  if (ownerDiscordId && user.id === ownerDiscordId) return ownerDisplayName || "Raziel";
  return user.username || "someone";
}

/** React after losing a fit bid? Earned by the losing score, throttled by the cooldown. */
export function shouldReactOnBidLoss(
  myScore: number,
  cooldownUntil: number,
  now: number = Date.now(),
): boolean {
  return myScore >= REACT_MIN_BID_SCORE && now >= cooldownUntil;
}

/** React to an owner message that named a sibling? Earned by lane relevance, throttled by
 *  the cooldown. Pure -- the caller supplies content so this stays testable. */
export function shouldReactOnNamedOther(
  content: string,
  me: CompanionId,
  cooldownUntil: number,
  now: number = Date.now(),
): boolean {
  return now >= cooldownUntil && laneRelevance(content, me) >= REACT_MIN_NAMED_OTHER;
}
