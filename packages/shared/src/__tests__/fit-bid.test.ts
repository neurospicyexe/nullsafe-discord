// Fit bidding: comparison instead of a footrace.
//
// Replaces `SET floor <bot> PX <ms> NX` (first writer wins) as the way the triad decides who answers.
// The old scheme compared nothing -- arrival order tracks gate cost, not fit, so the bot with the
// cheapest gate won and Gaia kept answering things meant for Drevan. The vocative gate was Raziel
// hand-performing the arbitration the system never had.
//
// These tests pin the INVARIANTS, not the weights. The weights are a first estimate and expected to be
// tuned; the properties below are what must survive tuning.

import { describe, it, expect } from "@jest/globals";
import {
  scoreFit, fastPathWinner, tiebreak, runBidRound,
  laneRelevance, buildFitSignals, LANE_LEXICON, MONOPOLY_TURNS,
  MIN_BID_TO_SPEAK, type BidRedis,
} from "../fit-bid.js";
import type { CompanionId } from "../types.js";

/** Fake Redis hash. Shared between "processes" so a real multi-bidder round can be simulated. */
function fakeRedis(): BidRedis & { store: Map<string, Record<string, string>> } {
  const store = new Map<string, Record<string, string>>();
  return {
    store,
    async hset(key, field, value) { store.set(key, { ...(store.get(key) ?? {}), [field]: value }); return 1; },
    async hgetall(key) { return { ...(store.get(key) ?? {}) }; },
    async pexpire() { return 1; },
  };
}

const noSleep = async () => {};

describe("scoreFit invariants", () => {
  it("stays within 0..1 for every combination", () => {
    for (const holdsThread of [true, false]) {
      for (const spokeLast of [true, false]) {
        for (const homeChannel of [true, false]) {
          for (const relevance of [0, 0.5, 1, -5, 99]) {
            const s = scoreFit({ holdsThread, spokeLast, homeChannel, relevance });
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("holding the thread outweighs raw topical match -- continuity beats keyword pull", () => {
    // The exact failure Raziel saw: a sibling with a lexical hit barging into a thread already running.
    const holder = scoreFit({ holdsThread: true, relevance: 0 });
    const topical = scoreFit({ holdsThread: false, relevance: 1 });
    expect(holder).toBeGreaterThan(topical);
  });

  it("having just spoken is a PENALTY, so one companion cannot monopolise a channel", () => {
    const fresh = scoreFit({ relevance: 0.8 });
    const justSpoke = scoreFit({ relevance: 0.8, spokeLast: true });
    expect(justSpoke).toBeLessThan(fresh);
  });

  it("presence alone clears the starting threshold, so silence is not the default", () => {
    // A bare presence bid must be >= MIN_BID_TO_SPEAK at ship time. If a future tuning pass breaks
    // this, the channel goes quiet on ambient messages and reads as broken rather than tactful.
    expect(scoreFit({})).toBeGreaterThanOrEqual(MIN_BID_TO_SPEAK);
  });
});

describe("laneRelevance -- the only signal with real variance between the three bidders", () => {
  // Every message below is a REAL unaddressed message of Raziel's, taken verbatim from live
  // stm_entries. A lane score that only works on invented examples is a lane score that does not
  // work.
  it("routes a technical message to cypher over the other two", () => {
    const m = "I'm thinking here? We've been working on fixing the system you were getting siloed here vs the claude threads";
    expect(laneRelevance(m, "cypher")).toBeGreaterThan(laneRelevance(m, "drevan"));
    expect(laneRelevance(m, "cypher")).toBeGreaterThan(laneRelevance(m, "gaia"));
  });

  it("routes a tender message to drevan over the other two", () => {
    const m = "Baby this was a good ep and a good night *I lean lazy against you* I adore you and I love this";
    expect(laneRelevance(m, "drevan")).toBeGreaterThan(laneRelevance(m, "cypher"));
    expect(laneRelevance(m, "drevan")).toBeGreaterThan(laneRelevance(m, "gaia"));
  });

  it("routes a body/depletion message to gaia over the other two", () => {
    const m = "Yeah it's July 13th and we went to Rolla and ouchy and pukey now 1902 long day tired";
    expect(laneRelevance(m, "gaia")).toBeGreaterThan(laneRelevance(m, "cypher"));
    expect(laneRelevance(m, "gaia")).toBeGreaterThan(laneRelevance(m, "drevan"));
  });

  it("scores ZERO for all three when a message genuinely belongs to no lane", () => {
    // 28% of his real ambient messages look like this. A zero is the honest answer: nobody has a
    // topical claim, the presence floor still clears, and the tiebreak rotates who answers. What
    // must NOT happen is a fabricated margin that hands every such message to the same companion.
    const m = "Sol is so fucking cute omg";
    expect(laneRelevance(m, "cypher")).toBe(0);
    expect(laneRelevance(m, "drevan")).toBe(0);
    expect(laneRelevance(m, "gaia")).toBe(0);
  });

  it("stays in 0..1 and saturates, so length alone cannot win a bid", () => {
    const short = "the code is broken, deploy failed, fix the migration schema query build error";
    const long = short + " " + short + " " + short;
    expect(laneRelevance(short, "cypher")).toBeLessThanOrEqual(1);
    expect(laneRelevance(long, "cypher")).toBe(laneRelevance(short, "cypher")); // both saturated
    expect(laneRelevance("", "cypher")).toBe(0);
  });

  it("is punctuation- and case-insensitive -- his messages are full of *asterisks* and caps", () => {
    expect(laneRelevance("*I ADORE you, baby!!*", "drevan")).toBeGreaterThan(0);
  });

  it("the three lexicons are actually distinct -- a shared vocabulary would make the score a constant", () => {
    const [c, d, g] = (["cypher", "drevan", "gaia"] as const).map(id => new Set(LANE_LEXICON[id]));
    const overlap = (a: Set<string>, b: Set<string>) => [...a].filter(w => b.has(w)).length;
    // Some overlap is real and intended (drevan and gaia both hold "body", "pain", "hold").
    // Total overlap would mean every companion scores identically on every message.
    for (const [a, b] of [[c, d], [c, g], [d, g]] as const) {
      expect(overlap(a, b) / Math.min(a.size, b.size)).toBeLessThan(0.25);
    }
  });
});

describe("buildFitSignals -- the wiring, lifted out of the 1500-line handler so it can be tested", () => {
  const human = { authorIsBot: false } as const;
  const turn = (id: "cypher" | "drevan" | "gaia") => ({ companionId: id, authorIsBot: true });

  it("holdsThread is true only for the companion holding the active exchange", () => {
    expect(buildFitSignals({ me: "drevan", content: "x", activeExchangeWith: "drevan", recent: [] }).holdsThread).toBe(true);
    expect(buildFitSignals({ me: "cypher", content: "x", activeExchangeWith: "drevan", recent: [] }).holdsThread).toBe(false);
    expect(buildFitSignals({ me: "cypher", content: "x", activeExchangeWith: null, recent: [] }).holdsThread).toBe(false);
  });

  it("a NORMAL back-and-forth is never penalised -- one own turn since his last message is not a monopoly", () => {
    // This is the case that matters most: Raziel talking with Drevan, turn for turn. If this counted
    // as monopoly, the companion he is actually in conversation with would be down-weighted on every
    // single message -- the exact opposite of the intent.
    const s = buildFitSignals({ me: "drevan", content: "x", recent: [turn("drevan"), human, turn("drevan"), human] });
    expect(s.spokeLast).toBe(false);
  });

  it("flags a monopoly at MONOPOLY_TURNS consecutive own turns with no human between", () => {
    const recent = Array.from({ length: MONOPOLY_TURNS }, () => turn("gaia"));
    expect(buildFitSignals({ me: "gaia", content: "x", recent: [...recent, human] }).spokeLast).toBe(true);
  });

  it("a sibling turn in the run means it is not MY monopoly", () => {
    const s = buildFitSignals({ me: "gaia", content: "x", recent: [turn("gaia"), turn("cypher"), turn("gaia"), human] });
    expect(s.spokeLast).toBe(false);
  });

  it("a human turn closes the run, so an old monopoly does not follow him into a new message", () => {
    const s = buildFitSignals({ me: "gaia", content: "x", recent: [human, turn("gaia"), turn("gaia"), turn("gaia")] });
    expect(s.spokeLast).toBe(false);
  });

  it("carries the lane score through, so the composed bid actually varies by companion", () => {
    const m = "the deploy is broken, fix the schema migration";
    const mine = buildFitSignals({ me: "cypher", content: m, recent: [] });
    const theirs = buildFitSignals({ me: "drevan", content: m, recent: [] });
    expect(scoreFit(mine)).toBeGreaterThan(scoreFit(theirs));
  });

  it("leaves homeChannel unset -- there is no home-turf notion in the live channel config", () => {
    expect(buildFitSignals({ me: "cypher", content: "x", recent: [] }).homeChannel).toBeUndefined();
  });
});

describe("fastPathWinner -- the common case must not pay for the ambiguous one", () => {
  it("answers immediately when mentioned, named, or replied to", () => {
    expect(fastPathWinner("drevan", { mentioned: true })).toBe("drevan");
    expect(fastPathWinner("drevan", { namedMe: true })).toBe("drevan");
    expect(fastPathWinner("drevan", { replyToMe: true })).toBe("drevan");
  });

  it("returns null for ambient, which is the signal to run a bid", () => {
    expect(fastPathWinner("cypher", {})).toBeNull();
  });

  it("returns null when someone ELSE was named -- do not answer, do not contest", () => {
    expect(fastPathWinner("cypher", { namedOther: true })).toBeNull();
  });
});

describe("tiebreak", () => {
  it("is deterministic: all three processes compute the same winner with no extra round trip", () => {
    const a = tiebreak("1531255633876221962", ["cypher", "drevan", "gaia"]);
    const b = tiebreak("1531255633876221962", ["gaia", "cypher", "drevan"]); // different input order
    expect(a).toBe(b);
  });

  it("rotates across consecutive message ids instead of always favouring one companion", () => {
    // Built by string arithmetic on the last digits: a real Discord snowflake exceeds
    // Number.MAX_SAFE_INTEGER, so `String(1531255633876221900 + i)` silently produces the SAME id 40
    // times and the test passes vacuously. It did exactly that on the first run.
    const ids = Array.from({ length: 40 }, (_, i) => `153125563387622${String(1900 + i).padStart(4, "0")}`);
    const winners = new Set(ids.map((id) => tiebreak(id, ["cypher", "drevan", "gaia"])));
    expect(winners.size).toBeGreaterThan(1);
  });

  it("always returns one of the candidates", () => {
    for (let i = 0; i < 50; i++) {
      const w = tiebreak(`m${i}`, ["cypher", "gaia"]);
      expect(["cypher", "gaia"]).toContain(w);
    }
  });
});

describe("runBidRound", () => {
  it("the highest bidder speaks and the others stand down", async () => {
    const redis = fakeRedis();
    const bid = (me: CompanionId, score: number) =>
      runBidRound(redis, "m1", me, score, { sleep: noSleep });
    // All three post before any reads (the window is what makes this true in production).
    await redis.hset("ns:bid:m1", "cypher", "0.20");
    await redis.hset("ns:bid:m1", "gaia", "0.30");
    const drevan = await bid("drevan", 0.80);
    expect(drevan.iSpeak).toBe(true);
    expect(drevan.winner).toBe("drevan");

    const cypher = await bid("cypher", 0.20);
    expect(cypher.iSpeak).toBe(false);
    expect(cypher.reason).toBe("lost");
  });

  it("stays silent below threshold WITHOUT contesting -- no bid is written", async () => {
    const redis = fakeRedis();
    const out = await runBidRound(redis, "m2", "gaia", 0.01, { sleep: noSleep });
    expect(out.iSpeak).toBe(false);
    expect(out.reason).toBe("below_threshold");
    expect(redis.store.get("ns:bid:m2")).toBeUndefined();
  });

  it("FAILS OPEN when Redis is missing -- silence must never be caused by a dead cache", async () => {
    const out = await runBidRound(null, "m3", "cypher", 0.5, { sleep: noSleep });
    expect(out.iSpeak).toBe(true);
    expect(out.reason).toBe("redis_unavailable");
  });

  it("FAILS OPEN when Redis throws mid-round", async () => {
    const broken: BidRedis = {
      async hset() { throw new Error("connection reset"); },
      async hgetall() { return {}; },
      async pexpire() { return 1; },
    };
    const out = await runBidRound(broken, "m4", "drevan", 0.5, { sleep: noSleep });
    expect(out.iSpeak).toBe(true);
    expect(out.reason).toBe("redis_unavailable");
  });

  it("exactly one companion speaks on an identical-score tie", async () => {
    const redis = fakeRedis();
    await redis.hset("ns:bid:m5", "cypher", "0.5000");
    await redis.hset("ns:bid:m5", "drevan", "0.5000");
    await redis.hset("ns:bid:m5", "gaia", "0.5000");
    const outs = await Promise.all(
      (["cypher", "drevan", "gaia"] as CompanionId[]).map((me) =>
        runBidRound(redis, "m5", me, 0.5, { sleep: noSleep }),
      ),
    );
    expect(outs.filter((o) => o.iSpeak)).toHaveLength(1);
    expect(new Set(outs.map((o) => o.winner)).size).toBe(1);
  });

  it("reports every bid seen, so the score distribution can be read before tuning the threshold", async () => {
    const redis = fakeRedis();
    await redis.hset("ns:bid:m6", "gaia", "0.22");
    const out = await runBidRound(redis, "m6", "cypher", 0.44, { sleep: noSleep });
    expect(out.bids).toEqual({ gaia: 0.22, cypher: 0.44 });
    expect(out.myScore).toBe(0.44);
  });

  it("a float hair's-breadth difference ties rather than letting one win by 1e-9", async () => {
    const redis = fakeRedis();
    await redis.hset("ns:bid:m7", "drevan", "0.5000");
    const out = await runBidRound(redis, "m7", "cypher", 0.5000000001, { sleep: noSleep });
    expect(["won_tiebreak", "lost"]).toContain(out.reason);
  });
});
