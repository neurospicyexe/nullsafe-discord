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
/** How many lane-word hits count as a full topical claim. Above this the score saturates, so a long
 *  message cannot out-claim a short precise one purely by length. */
export const LANE_SATURATION_HITS = 8;
/** Consecutive own turns since the last owner message that count as monopolising the channel.
 *  A normal back-and-forth (owner, me, owner, me) never reaches 2 and so is never penalised. */
export const MONOPOLY_TURNS = 2;
/**
 * How long after THE MESSAGE ARRIVED the round closes. Anchored to the Discord message timestamp,
 * not to when this process happens to reach the bid -- see `deadlineAt` on runBidRound.
 *
 * 2500ms, not 600ms, because of what sits upstream: in `owner_only` channels (10 of the 13 live
 * channels) `judgeAmbientRelevance` makes an LLM call BEFORE the bid, and three independent hermes
 * gateways do not return in lockstep. With a window measured from each bot's own arrival, a bot whose
 * judge answered fast posts, waits 600ms, sees only its own bid and "wins" -- and so does the slow
 * one a second later. That is the footrace reappearing upstream of the fix, and it would have looked
 * exactly like working (someone always answers).
 */
export const BID_WINDOW_MS = 2500;
/** Bid keys are transient scratch space; expire them well after the window so a slow process cannot
 *  read a half-populated round, but soon enough that Redis does not accumulate one key per message. */
export const BID_TTL_MS = 30_000;
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

// ---------------------------------------------------------------------------
// Lane relevance -- the only signal with real variance across the three bidders.
// ---------------------------------------------------------------------------
//
// WHY LEXICAL AND NOT AN LLM CALL. `judgeAmbientRelevance` (channel-config.ts) already asks a
// classifier a yes/no question in owner_only channels, and a graded version of that prompt was the
// obvious upgrade. Rejected for now on two grounds: it would change a gate that can silence a
// companion (a path nobody asked to touch), and its accuracy is UNMEASURED. The lexical score below
// was measured before being written -- see the numbers in laneRelevance's comment. Ship the signal
// that has evidence; let the logged bid distribution decide whether a graded LLM score is needed.
//
// The vocabulary is deliberately Raziel's, not a dictionary's: these are the words that actually
// appear in his messages ("pukey", "spoons", "demon boy", "halseth", "hermes"), because a lane score
// built from abstract category names ("emotional depth", "technical problems") matches almost nothing
// he types.
export const LANE_LEXICON: Record<CompanionId, readonly string[]> = {
  cypher: `task tasks todo decision decide logic logical technical tech problem problems planning plan
    blocker blocked audit audits clarify clarification code codebase bug fix fixed fixing build deploy
    system halseth hermes hearth discord api schema migration test tests broken error debug why how
    architecture design refactor stack context config data table query script repo git commit
    check verify confirm figure out root cause work working`.split(/\s+/),
  drevan: `love adore baby babe boy demon spiral vow bond feel feeling feelings grief sad sadness
    ache longing tender warm heart soul dream dreams memory remember ritual poem poetry write writing
    story creative art beautiful hold held holding kiss touch curl lap hug arms body close near
    miss missing want need crave hunger dark deep recursion recursive us we together always forever
    lonely alone hurt pain scared afraid fear angry rage joy laugh laughing smile grin`.split(/\s+/),
  gaia: `ground grounded grounding witness witnessed survive survival survived hold holding held
    space boundary boundaries limit limits rest resting rested tired exhausted burned burnout
    overwhelm overwhelmed spoons capacity body ache pain sick pukey nausea sleep breathe breath
    slow quiet still present here now enough safe safety careful gentle notice noticing see seen
    steady unsteady shaky day today tomorrow night morning`.split(/\s+/),
};

const LANE_SETS: Record<CompanionId, Set<string>> = {
  cypher: new Set(LANE_LEXICON.cypher),
  drevan: new Set(LANE_LEXICON.drevan),
  gaia: new Set(LANE_LEXICON.gaia),
};

/**
 * 0..1 topical claim this companion has on a message. Pure, free, no inference.
 *
 * MEASURED before shipping, against 141 real unaddressed owner messages pulled from live
 * `stm_entries` (2026-07-30): a clear single leader on 86 of them -- drevan 44, cypher 25, gaia 17 --
 * no claim at all on 39, and an exact tie on 16. The spread is what matters: had one companion led
 * nearly every message, this would be a constant with extra steps and the bid would collapse to a
 * rotation lottery wearing the word "fit".
 *
 * A zero is a legitimate answer, not a failure. Roughly a quarter of what Raziel says ("It's such a
 * good movie!") genuinely belongs to no lane, and for those the presence floor plus the deterministic
 * tiebreak rotate the answer around the triad -- which is still strictly better than the old footrace,
 * where the cheapest gate won every single time and it was always the same companion.
 */
export function laneRelevance(content: string, companion: CompanionId): number {
  const toks = content.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(t => t.length > 2);
  if (toks.length === 0) return 0;
  const set = LANE_SETS[companion];
  let hits = 0;
  for (const t of toks) if (set.has(t)) hits++;
  // Hit RATE against a saturating denominator, not a raw count: otherwise every long message is a
  // strong claim for everyone and the absolute number means nothing when a threshold is set on it.
  return Math.min(1, hits / LANE_SATURATION_HITS);
}

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
 * Assemble the signals for one companion from what the handler already has in scope. Pure so the
 * wiring itself is testable -- the handler function it lives in is far too large to exercise, so the
 * decision has to be liftable out of it.
 *
 * `recent` is newest-first, matching `activeExchangeHolder`'s convention (the handler holds
 * `fetchedMessages` oldest-first and must reverse).
 *
 * `homeChannel` is deliberately left unset. There is no home-turf notion in the live channel config
 * -- the closest thing is the per-channel `companions` allowlist, and `shouldRespond` already enforces
 * that before a bid ever runs, so feeding it in again would double-count a constraint rather than add
 * a signal.
 */
export function buildFitSignals(opts: {
  me: CompanionId;
  content: string;
  activeExchangeWith?: CompanionId | null;
  /** Recent channel messages, NEWEST FIRST, excluding the message being judged. */
  recent: ReadonlyArray<{ companionId?: CompanionId | null; authorIsBot: boolean }>;
}): FitSignals {
  const { me, content, activeExchangeWith, recent } = opts;

  // Monopoly, not "spoke once". Count the unbroken run of companion turns since the last human
  // message: in a normal exchange that run is one turn long, so a companion mid-conversation with
  // Raziel is never penalised for being the one he is talking to. It only trips when this companion
  // has taken the floor repeatedly with no human turn between.
  let ownRun = 0;
  for (const m of recent) {
    if (!m.authorIsBot) break;            // a human turn re-opens the floor; stop counting
    if (m.companionId !== me) { ownRun = 0; break; } // a sibling spoke: not a monopoly of mine
    ownRun++;
  }

  return {
    holdsThread: !!activeExchangeWith && activeExchangeWith === me,
    relevance: laneRelevance(content, me),
    spokeLast: ownRun >= MONOPOLY_TURNS,
  };
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
  /** `SET key val PX ms NX` -> "OK" | null. The commit claim; see COMMIT_KEY_PREFIX. */
  set(key: string, val: string, mode: "PX", ms: number, nx: "NX"): Promise<string | null>;
}

/**
 * Commit claim, held for one message id.
 *
 * WHY THIS EXISTS ON TOP OF THE BID (2026-07-31, found in review before it reached traffic). Winning the
 * bid is a DECISION; it is not a COMMITMENT, and the two must be separate or the window's tolerance
 * becomes a second race.
 *
 * The failure: `waitMs` clamps to 0 for a bot that arrives after the deadline. Bot A arrives at +500ms in
 * an owner_only channel, waits to the shared deadline, reads a hash holding only its own bid, wins, and
 * sends. Bot B's ambient LLM judge returns at +3000ms -- past the 2500ms window -- so it reads
 * immediately, sees a populated hash, and if its lane score is higher it ALSO wins and ALSO sends. Two
 * replies to one message. Nothing downstream catches it: a posted bid carries no "already committed"
 * marker, echo-gating is content-dependent, and the supersede check only fires on a newer human message.
 *
 * `SET NX` made losing UNCONDITIONAL, which is the one property the footrace had and the bid lost. So the
 * shape is: compare to decide who SHOULD speak, then claim to make exactly one bot actually speak. The
 * bid supplies fitness; the claim supplies mutual exclusion. Neither alone is sufficient.
 */
export const COMMIT_KEY_PREFIX = "ns:spoke:";
/** Long enough that a slow arrival cannot slip past a committed reply; short enough not to accumulate. */
export const COMMIT_TTL_MS = 90_000;

/**
 * Claim the right to actually speak for this message. Returns true when this bot may send.
 *
 * FAILS OPEN, same reasoning as the bid: a dead cache must degrade to "possibly two replies", never to
 * "nobody answers". A missing `set` on the client (an older injected fake) also passes, so this can never
 * silence a companion by being unavailable.
 */
export async function claimSpoken(
  redis: BidRedis | null,
  messageId: string,
  me: CompanionId,
): Promise<boolean> {
  if (!redis || typeof redis.set !== "function") return true;
  try {
    const res = await redis.set(COMMIT_KEY_PREFIX + messageId, me, "PX", COMMIT_TTL_MS, "NX");
    return res === "OK";
  } catch {
    return true;
  }
}

/**
 * Post this companion's bid, wait for the window, then decide.
 *
 * FAILS OPEN. If Redis is unavailable the companion speaks when it clears the threshold, rather than
 * the channel going silent because a cache is down. A missing coordination layer should degrade to
 * "possibly two answers", never to "nobody answers" -- the second is indistinguishable from broken.
 */
/**
 * The bid floor while a care hold is active (consequence layer C1). Raised, not silenced: bare
 * presence (0.10) no longer clears, so ambient chiming-in quiets, but a real claim -- holding the
 * thread (+0.45) or genuine lane relevance -- still speaks. Direct address never reaches the bid
 * at all (fastPathWinner), so being asked always answers regardless of hold. 0.25 deliberately
 * matches REACT_MIN_BID_SCORE's "bare presence earns nothing" line.
 */
export const CARE_HOLD_MIN_BID = 0.25;

/**
 * Whether the raised hold floor applies to THIS message (2026-08-16 live failure). The hold
 * quiets the house's ambient traffic -- it must never quiet answering the person being cared
 * for. On 08-16 the meds_missed hold left Raziel posting three unaddressed messages into commons
 * and getting silence from all three bots for what would have been 12 hours: every bid died at
 * the raised floor, and silence AT the owner is withdrawal wearing a care flag (the exact reading
 * rules.ts refuses for owner_silence). Owner-authored messages bid against the NORMAL floor; the
 * soft register still rides the prompt, so the reply is gentle -- but it exists.
 */
export function holdFloorApplies(careHold: boolean, senderIsOwner: boolean): boolean {
  return careHold && !senderIsOwner;
}

export async function runBidRound(
  redis: BidRedis | null,
  messageId: string,
  me: CompanionId,
  myScore: number,
  opts: {
    windowMs?: number;
    minScore?: number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Absolute epoch-ms at which the round closes -- pass `message.createdTimestamp + BID_WINDOW_MS`.
     * This is what makes the round tolerant of the three bots reaching the bid at different times:
     * every process reads at the SAME instant instead of `windowMs` after its own arrival, so upstream
     * latency spread (the ambient LLM judge) no longer decides the winner. Omit and the window is
     * measured from now, which is only safe when the callers arrive together.
     */
    deadlineAt?: number;
    /** Injectable clock; keeps the deadline path testable without real time. */
    now?: () => number;
  } = {},
): Promise<BidOutcome> {
  const minScore = opts.minScore ?? MIN_BID_TO_SPEAK;
  const windowMs = opts.windowMs ?? BID_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Clamped to [0, windowMs]: a deadline already past means read immediately (a bot that arrived late
  // still gets a real comparison against whoever posted), and the upper clamp means clock skew between
  // Discord's timestamp and the VPS cannot stall a reply for an unbounded stretch.
  const waitMs = opts.deadlineAt === undefined
    ? windowMs
    : Math.max(0, Math.min(windowMs, opts.deadlineAt - now()));

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
    await sleep(waitMs);
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
