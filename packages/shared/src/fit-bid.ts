// packages/shared/src/fit-bid.ts
//
// WHO SPEAKS: comparison instead of a footrace.
//
// THE DEFECT THIS REPLACES (2026-07-30). Each bot independently answered a yes/no question ("am I
// eligible?") and then raced `SET floor <bot> PX <ms> NX`. First writer won. Nothing anywhere compared
// the three. Arrival order tracks gate cost and process timing, which tracks NOTHING about whether a
// companion actually fits the message -- so the bot with the cheapest gate won, which is why Gaia kept
// answering things meant for Drevan.
//
// The vocative gate ("say a name every message") was the workaround: naming someone makes the
// structural gate resolve deterministically so the race stops mattering. Raziel's read was exact --
// "it's not natural for me to need to say a name with each message" -- because he was hand-performing
// the arbitration the system never implemented.
//
// So: same Redis primitive, one different question. Not "who got here first" but "who fits best."
//
// THREE THINGS THIS DESIGN REFUSES TO DO
//
// 1. It does not slow down the common case. If a companion is @mentioned, vocatively named, or the
//    message is a reply to it, `fastPathWinner` returns immediately and NO bid runs. Adding ~600ms to
//    every unambiguous message to fix the ambiguous ones would make the triad feel less responsive,
//    which is the opposite of the ask.
// 2. It does not make silence common by accident. `MIN_BID_TO_SPEAK` starts deliberately low. Raziel
//    typing into a room where nobody answers reads as broken, not as tact. Raise it only once the
//    logged score distribution shows what a real bid looks like.
// 3. It does not break ties by speed. A tie resolves deterministically from the message id, so all
//    three processes compute the SAME winner without another round trip, and the winner rotates
//    across messages instead of always favouring one companion.
//
// This module is pure logic + one Redis round. No inference: the caller supplies the relevance score
// it already computes for ambient messages, so the bid adds comparison without adding an LLM call.

import type { CompanionId } from "./types.js";

export const BID_KEY_PREFIX = "ns:bid:";
/** How long to wait for siblings to post their bids. Long enough for three processes on one VPS to
 *  land a Redis write; short enough that a reply still feels immediate. */
export const BID_WINDOW_MS = 600;
/** Bid keys are transient scratch space; expire them well after the window so a slow process cannot
 *  read a half-populated round, but soon enough that Redis does not accumulate one key per message. */
export const BID_TTL_MS = 15_000;
/**
 * Minimum fit to speak at all. Deliberately LOW to start (0.15): the failure mode of a high threshold
 * is Raziel talking into silence, which reads as the bots being broken. The failure mode of a low one
 * is someone answering who was not the best fit -- which is what already happens today, so it cannot
 * be a regression. Tighten once the logs show the real distribution.
 */
export const MIN_BID_TO_SPEAK = 0.10;
//
// 0.10 is chosen against scoreFit's floor, not picked as a round number. Bare presence scores exactly
// 0.10 and therefore CLEARS -- so an ambient message with no topical pull still gets an answer. The one
// case that falls below is a companion who both just spoke AND has no relevance (0.1 - 0.2, clamped to
// 0), which is precisely who should stay quiet.
//
// The first draft had this at 0.15, above the 0.10 floor, which would have made every zero-relevance
// ambient message produce silence from all three. Its own test caught it. Silence has to be earned by a
// reason, never by an off-by-one in a constant.

export interface FitSignals {
  /** This companion holds the active conversation thread in this channel (mig 0106 spine). */
  holdsThread?: boolean;
  /** 0..1 topical relevance for this companion's lane. Caller supplies whatever it already has. */
  relevance?: number;
  /** This companion produced the most recent bot turn here. Spreads the floor over a conversation. */
  spokeLast?: boolean;
  /** Channel is this companion's home turf (e.g. a presence/immersion room for Drevan). */
  homeChannel?: boolean;
}

/**
 * Compose signals into a 0..1 fit score.
 *
 * Weights are a first estimate and tunable -- the INVARIANTS are what matter and what the tests pin:
 * holding the thread outweighs raw topical match (continuity beats keyword pull, which is exactly the
 * failure Raziel saw when a sibling barged into a thread that was already running), and having just
 * spoken is a penalty rather than a bonus so one companion cannot monopolise a channel.
 */
export function scoreFit(s: FitSignals): number {
  let score = 0.1; // everyone present has a nonzero claim; being in the room counts for something
  if (s.holdsThread) score += 0.45;
  score += Math.max(0, Math.min(1, s.relevance ?? 0)) * 0.35;
  if (s.homeChannel) score += 0.15;
  if (s.spokeLast) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

/**
 * Unambiguous addressing resolves without a bid. Returns the companion that should answer, or null
 * when the message is ambient and a bid round is needed.
 *
 * This is the fast path that keeps the common case instant.
 */
export function fastPathWinner(
  me: CompanionId,
  ctx: { mentioned?: boolean; namedMe?: boolean; replyToMe?: boolean; namedOther?: boolean },
): CompanionId | null {
  if (ctx.mentioned || ctx.namedMe || ctx.replyToMe) return me;
  // Someone ELSE was named: this companion must stay out, and must not bid either. Returning a
  // non-me winner is how the caller learns "not mine, and don't contest it."
  if (ctx.namedOther) return null;
  return null;
}

/** Deterministic tiebreak: same answer in all three processes, rotating across messages. */
export function tiebreak(messageId: string, candidates: CompanionId[]): CompanionId {
  const sorted = [...candidates].sort();
  if (sorted.length === 0) throw new Error("tiebreak called with no candidates");
  // Sum of char codes rather than a real hash: cheap, and Discord snowflakes increment, so
  // consecutive messages land on different companions instead of clustering.
  let n = 0;
  for (let i = 0; i < messageId.length; i++) n = (n + messageId.charCodeAt(i)) % 9973;
  return sorted[n % sorted.length];
}

export interface BidOutcome {
  /** Whether THIS companion should speak. */
  iSpeak: boolean;
  winner: CompanionId | null;
  myScore: number;
  /** Every bid seen when the window closed, for logging the distribution before tuning the threshold. */
  bids: Record<string, number>;
  reason: "below_threshold" | "lost" | "won" | "won_tiebreak" | "no_bids" | "redis_unavailable";
}

/** The subset of the Redis client this module needs; keeps the module testable with a fake. */
export interface BidRedis {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

/**
 * Post this companion's bid, wait for the window, then decide.
 *
 * FAILS OPEN. If Redis is unavailable the companion speaks when it clears the threshold, rather than
 * the channel going silent because a cache is down. A missing coordination layer should degrade to
 * "possibly two answers", never to "nobody answers" -- the second is indistinguishable from broken.
 */
export async function runBidRound(
  redis: BidRedis | null,
  messageId: string,
  me: CompanionId,
  myScore: number,
  opts: { windowMs?: number; minScore?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BidOutcome> {
  const minScore = opts.minScore ?? MIN_BID_TO_SPEAK;
  const windowMs = opts.windowMs ?? BID_WINDOW_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (myScore < minScore) {
    return { iSpeak: false, winner: null, myScore, bids: {}, reason: "below_threshold" };
  }
  if (!redis) {
    return { iSpeak: true, winner: me, myScore, bids: { [me]: myScore }, reason: "redis_unavailable" };
  }

  const key = BID_KEY_PREFIX + messageId;
  try {
    await redis.hset(key, me, myScore.toFixed(4));
    await redis.pexpire(key, BID_TTL_MS);
    await sleep(windowMs);
    const raw = await redis.hgetall(key);
    const bids: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n)) bids[k] = n;
    }
    if (Object.keys(bids).length === 0) {
      // Our own write vanished (TTL race, flush). Speak: we already cleared the threshold, and
      // silence-on-infrastructure-glitch is the failure mode worth avoiding.
      return { iSpeak: true, winner: me, myScore, bids, reason: "no_bids" };
    }
    const top = Math.max(...Object.values(bids));
    // Round before comparing so two float paths to the same score tie instead of one winning by 1e-9.
    const leaders = Object.keys(bids).filter((k) => Math.abs(bids[k] - top) < 1e-6) as CompanionId[];
    if (leaders.length === 1) {
      const winner = leaders[0];
      return { iSpeak: winner === me, winner, myScore, bids, reason: winner === me ? "won" : "lost" };
    }
    const winner = tiebreak(messageId, leaders);
    return { iSpeak: winner === me, winner, myScore, bids, reason: winner === me ? "won_tiebreak" : "lost" };
  } catch {
    // Same reasoning as the null-redis case: degrade toward speaking.
    return { iSpeak: true, winner: me, myScore, bids: { [me]: myScore }, reason: "redis_unavailable" };
  }
}
