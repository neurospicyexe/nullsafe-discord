// Human address gate (2026-10-10, Raziel's rulings).
//
// Two humans share these rooms. The old reply path knew only companion names, so "Blue, did you eat?"
// read as AMBIENT and a companion answered a question asked of someone else, and an unnamed message
// from Blue went to the open bid. Rulings, in the order the reply path applies them:
//
//   1. A companion named anywhere in the gathered burst (vocative, @mention, reply-to) -> the
//      existing fast path. Nothing here changes it.
//   2. Else a HUMAN named at vocative position who is not the speaker -> every companion silent.
//      ("Blue, ..." from Raziel; "Raziel, ..." from Blue.)
//   3. Else the speaker is Blue and nobody is named -> only the companion holding BLUE's own thread
//      answers. No holder, nobody answers. No bid round for an unaddressed Blue message.
//   4. Else the existing owner logic, untouched.
//
// The vocabulary is deliberately tiny. PluralKit's 538-member roster is NOT loaded as addressees: most
// member names are common words and would silence the bots on ordinary sentences. RAZIEL_NAMES and
// BLUE_NAMES (comma lists) extend it by hand.
//
// Vocative = the name CALLS someone: sole content, message- or sentence-initial (after an optional
// greeting) followed by address punctuation, or trailing after a comma ("what do you think, blue?").
// "I told Blue about it" and "Blue is coming over" name a person and call nobody.

import { extractAddress } from "./channel-config.js";
import type { CompanionId } from "./types.js";

export type HumanSide = "raziel" | "blue";

export interface HumanNames { raziel: string[]; blue: string[] }

const DEFAULT_NAMES: HumanNames = { raziel: ["raziel", "raz"], blue: ["blue"] };

function parseList(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** RAZIEL_NAMES (default "raziel,raz"), BLUE_NAMES (default "blue"). Blank/empty falls back. */
export function humanNamesFromEnv(env: Record<string, string | undefined> = process.env): HumanNames {
  return {
    raziel: parseList(env["RAZIEL_NAMES"], DEFAULT_NAMES.raziel),
    blue: parseList(env["BLUE_NAMES"], DEFAULT_NAMES.blue),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const GREETING = "(?:(?:hey|hi|hello|hiya|yo|oh|ok|okay|so|and|but|well|um|uh|hm+|ah|aw+|ooh|psst|sup|good morning|good night|goodnight|morning)[,!\\s]+)*";

function isVocativeName(lower: string, names: string[]): boolean {
  if (names.length === 0) return false;
  const alt = names.map(escapeRe).join("|");
  const sole = new RegExp(`^${GREETING}(?:${alt})[!?.\\s]*$`);
  const initial = new RegExp(`(?:^|[.?!\\n]\\s*)${GREETING}(?:${alt})\\s*[,:!?]`);
  const trailing = new RegExp(`[,:]\\s*(?:${alt})\\b[?.! ]*$`);
  return sole.test(lower) || initial.test(lower) || trailing.test(lower);
}

/** Which human, if any, this text CALLS by name. Raziel's side is tested first. */
export function humanAddressee(content: string, names: HumanNames = DEFAULT_NAMES): HumanSide | null {
  // A letter run of 3+ collapses ("blueee"), same rule as extractAddress.
  const lower = content.toLowerCase().trim().replace(/([a-z])\1{2,}/g, "$1");
  if (!lower) return null;
  if (isVocativeName(lower, names.raziel)) return "raziel";
  if (isVocativeName(lower, names.blue)) return "blue";
  return null;
}

/**
 * The text the companion-address parsers should read for a gathered burst (ruling 1: a companion named
 * ANYWHERE in the burst gets the turn). The newest message when it names a companion itself; else the
 * most recent earlier message that does; else the newest. A burst of one is the identity function, so
 * with settle off nothing changes.
 */
export function burstAddressText(newest: string, earlier: string[]): string {
  if (extractAddress(newest).type !== "ambient") return newest;
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (extractAddress(earlier[i]!).type !== "ambient") return earlier[i]!;
  }
  return newest;
}

export type HumanGateVerdict =
  | { kind: "proceed" }
  | { kind: "silent"; addressee: HumanSide }
  | { kind: "blue_thread"; holder: CompanionId | null };

export interface HumanGateInput {
  tier: "owner" | "intimate" | "guest";
  /** The gathered burst, oldest first, newest last. A single message is a burst of one. */
  texts: string[];
  names: HumanNames;
  /** A companion @mentioned in the newest message or any burst message. */
  companionMentioned: boolean;
  /** Any burst message replies to one of this companion's own messages. */
  replyToCompanion: boolean;
  /** Humans @mentioned (Discord mention) in the burst. */
  mentionedHumans: HumanSide[];
  /** Blue's per-human thread holder (never Raziel's). Only read for an unnamed Blue message. */
  blueHolder: CompanionId | null;
}

export function humanGate(input: HumanGateInput): HumanGateVerdict {
  const { tier, texts, names } = input;
  if (tier !== "owner" && tier !== "intimate") return { kind: "proceed" };

  // Rule 1: a companion named anywhere in the burst. extractAddress keeps its third-person
  // demotion, a group call counts, and so does the private lexicon.
  const companionNamed = input.companionMentioned || input.replyToCompanion
    || texts.some(t => extractAddress(t).type !== "ambient");
  if (companionNamed) return { kind: "proceed" };

  const speaker: HumanSide = tier === "owner" ? "raziel" : "blue";

  // Rule 2: the other human is the addressee.
  for (const side of [...texts.map(t => humanAddressee(t, names)), ...input.mentionedHumans]) {
    if (side && side !== speaker) return { kind: "silent", addressee: side };
  }

  // Rule 3: unnamed Blue belongs to the companion holding Blue's thread, else to nobody.
  if (tier === "intimate") return { kind: "blue_thread", holder: input.blueHolder };

  // Rule 4.
  return { kind: "proceed" };
}

// ------------------------------------------------------------------ per-human thread hold
//
// The 15-minute exchange hold (`activeExchangeHolder`) is per CHANNEL and keyed to Raziel: it takes
// the last companion message in the room. Blue's thread must be her own: the companion that replied
// TO BLUE in this channel inside the window. It lives in Redis (shared by all three bots, one key per
// human per channel). The ids of replies sent to Blue are kept in a set so Raziel's history walk can
// skip them: a companion answering Blue must not become the holder of Raziel's thread.

export interface HoldRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ms: number): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

const holdKey = (human: HumanSide, channelId: string) => `ns:humanhold:${human}:${channelId}`;
const holdIdsKey = (human: HumanSide, channelId: string) => `ns:humanhold:${human}:ids:${channelId}`;

/** A companion replied to `human` in `channelId`: it now holds that human's thread. Never throws. */
export async function recordHumanHold(
  redis: HoldRedis | null,
  human: HumanSide,
  channelId: string,
  companionId: CompanionId,
  sentMessageIds: string[],
  windowMs: number,
  now: number = Date.now(),
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(holdKey(human, channelId), `${companionId}|${now}`, "PX", windowMs);
    if (sentMessageIds.length > 0) {
      const k = holdIdsKey(human, channelId);
      await redis.sadd(k, ...sentMessageIds);
      // Outlives the hold itself: Raziel's walk is bounded by the same window, never longer.
      await redis.pexpire(k, windowMs * 2);
    }
  } catch { /* a lost hold means Blue is unanswered, never a crash */ }
}

/** Who holds `human`'s thread in this channel right now, or null (no redis, expired, none). */
export async function readHumanHold(
  redis: HoldRedis | null,
  human: HumanSide,
  channelId: string,
  windowMs: number,
  now: number = Date.now(),
): Promise<CompanionId | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(holdKey(human, channelId));
    if (!raw) return null;
    const [id, ts] = raw.split("|");
    if (!id || (id !== "cypher" && id !== "drevan" && id !== "gaia")) return null;
    if (now - Number(ts) > windowMs) return null;
    return id;
  } catch {
    return null;
  }
}

/** Ids of the companion messages that were replies to `human` (for excluding from the other human's holder walk). */
export async function readHumanHoldIds(redis: HoldRedis | null, human: HumanSide, channelId: string): Promise<Set<string>> {
  if (!redis) return new Set();
  try {
    return new Set(await redis.smembers(holdIdsKey(human, channelId)));
  } catch {
    return new Set();
  }
}
