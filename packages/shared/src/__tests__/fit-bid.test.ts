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
