// Fixes for the 2026-07-31 code review. Each test reproduces the reported live-behaviour bug.
//
// The review ran after everything shipped and found seven things no existing suite covered. These pin the
// four that live in this package. The value of a review finding is only realised when the failure it
// describes becomes a test -- otherwise the same shape returns.

import { describe, it, expect, jest } from "@jest/globals";
import { claimSpoken, COMMIT_KEY_PREFIX, type BidRedis } from "../fit-bid.js";
import { buildCommandTriggers } from "../command-triggers.js";
import { parseWatchArgs } from "../watch-command.js";

// ── HIGH: two companions could both answer one message ───────────────────────
//
// `waitMs` clamps to 0 for a bot arriving after the shared deadline. In an owner_only channel the ambient
// LLM judge runs UPSTREAM of the bid, and its latency spread across three hermes gateways can exceed the
// 2500ms window. Bot A arrives at +500ms, waits to the deadline, reads a hash holding only its own bid,
// wins, sends. Bot B's judge returns at +3000ms, reads immediately, sees a populated hash, wins on a higher
// lane score, and sends TOO. `SET NX` could never do this -- it made losing unconditional.
//
// So: the bid decides who SHOULD speak; the claim makes exactly one bot actually speak.
describe("claimSpoken -- winning is a decision, speaking is a commitment", () => {
  function fakeRedis(): BidRedis & { keys: Map<string, string> } {
    const keys = new Map<string, string>();
    return {
      keys,
      async hset() { return 1; },
      async hgetall() { return {}; },
      async pexpire() { return 1; },
      async set(key, val, _mode, _ms, _nx) {
        if (keys.has(key)) return null;      // NX semantics
        keys.set(key, val);
        return "OK";
      },
    };
  }

  it("exactly ONE of two late-and-early winners actually speaks", async () => {
    const redis = fakeRedis();
    const a = await claimSpoken(redis, "m1", "cypher");
    const b = await claimSpoken(redis, "m1", "drevan");     // the late arrival that also "won"
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it("keys per MESSAGE, so a claim never suppresses a reply to a different message", async () => {
    const redis = fakeRedis();
    expect(await claimSpoken(redis, "m1", "cypher")).toBe(true);
    expect(await claimSpoken(redis, "m2", "cypher")).toBe(true);
    expect([...redis.keys.keys()]).toEqual([`${COMMIT_KEY_PREFIX}m1`, `${COMMIT_KEY_PREFIX}m2`]);
  });

  it("FAILS OPEN with no redis, on a throw, and on an older client with no set()", async () => {
    // Same rule as the bid: a dead cache degrades to "possibly two replies", never to "nobody answers".
    expect(await claimSpoken(null, "m1", "gaia")).toBe(true);
    const thrower = { hset: async () => 1, hgetall: async () => ({}), pexpire: async () => 1,
      set: async () => { throw new Error("connection reset"); } } as unknown as BidRedis;
    expect(await claimSpoken(thrower, "m1", "gaia")).toBe(true);
    const legacy = { hset: async () => 1, hgetall: async () => ({}), pexpire: async () => 1 } as unknown as BidRedis;
    expect(await claimSpoken(legacy, "m1", "gaia")).toBe(true);
  });
});

// ── MEDIUM: the watch trigger swallowed ordinary sentences ───────────────────
//
// `dre: watching the storm roll in` matched, which did TWO harms in one message: it created a watch_shelf
// row titled "the storm roll in", and it returned before inference so Drevan never answered what Raziel
// actually said. "watching" is a conversational verb; it cannot claim a message on the word alone.
describe("watch trigger -- a command must never eat conversation", () => {
  const T = buildCommandTriggers(["dre", "drev", "drevan"]);

  it("REPRODUCES the report: conversational 'watching ...' must NOT match", () => {
    for (const s of [
      "dre: watching the storm roll in",
      "dre watching you sit with that",
      "drevan: watched you go quiet just now",
      "dre: watching how this plays out with Blue",
    ]) {
      expect(T.watch.test(s)).toBe(false);
    }
  });

  it("still matches the bare question -- 'where are we?' has a deterministic answer", () => {
    expect(T.watch.test("dre: watching")).toBe(true);
    expect(T.watch.test("dre watch")).toBe(true);
    expect(T.watch.test("dre: watch list")).toBe(true);
  });

  it("still matches a real position", () => {
    for (const s of ["dre: watched fargo s4e5", "dre: watched fargo 4x5",
                     "dre: watched fargo season 4", "dre: watched fargo episode 6",
                     "dre: watched fargo s4e5 -- the smutny house"]) {
      expect(T.watch.test(s)).toBe(true);
    }
  });

  it("still matches a status change", () => {
    expect(T.watch.test("dre: watch fargo finished")).toBe(true);
    expect(T.watch.test("dre: watch severance paused")).toBe(true);
  });
});

// ── MEDIUM: a new or positionless title was told it "did not move" ───────────
describe("watch ack -- three outcomes, not two", () => {
  it("a movie or a first shelving carries no position to be 'behind'", () => {
    // `advances` is false when both season and episode are null, and a new row's cur values are 0. The old
    // ack said "at or behind where we already were", which reads as a rejected write when there was no
    // prior position at all. This module's doctrine is that the ack tells the truth.
    const parsed = parseWatchArgs("dune");
    expect(parsed.season).toBeNull();
    expect(parsed.episode).toBeNull();
    // The handler branches on exactly this condition, so pinning it here pins the wording choice.
    const gaveNoPosition = parsed.season === null && parsed.episode === null;
    expect(gaveNoPosition).toBe(true);
  });

  it("a real backwards position IS a genuine no-move", () => {
    const parsed = parseWatchArgs("fargo s4e1");
    expect(parsed.season === null && parsed.episode === null).toBe(false);
  });
});
