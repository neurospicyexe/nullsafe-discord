// The bid deadline under burst settle. With settle on, each bot reaches the bid ~BURST_SETTLE_MS
// after the message. A deadline of createdTimestamp + 2500 is then already past: each bot writes its
// bid and reads at once, sees only itself, and all three speak. The deadline must shift by the settle.

import { describe, it, expect } from "@jest/globals";
import { bidDeadlineAt, BID_WINDOW_MS, runBidRound, type BidRedis } from "../fit-bid.js";
import type { CompanionId } from "../types.js";

function fakeRedis(): BidRedis {
  const store = new Map<string, Record<string, string>>();
  return {
    async hset(key: string, field: string, value: string) { (store.get(key) ?? store.set(key, {}).get(key)!)[field] = value; return 1; },
    async hgetall(key: string) { return { ...(store.get(key) ?? {}) }; },
    async pexpire() { return 1; },
  } as unknown as BidRedis;
}

describe("bidDeadlineAt", () => {
  it("settle off is the old deadline exactly", () => {
    expect(bidDeadlineAt(1_000_000)).toBe(1_000_000 + BID_WINDOW_MS);
    expect(bidDeadlineAt(1_000_000, 0)).toBe(1_000_000 + 2500);
  });
  it("shifts by the settle the turn waited", () => {
    expect(bidDeadlineAt(1_000_000, 4000)).toBe(1_000_000 + 4000 + 2500);
  });
});

describe("three bots settling before the bid still converge on ONE speaker", () => {
  const MSG_AT = 1_000_000;
  const SETTLE = 4000;
  // Each bot arrives at the bid SETTLE + its own upstream latency after the message.
  const arrivals: Array<[CompanionId, number, number]> = [
    ["cypher", 150, 0.20], ["gaia", 900, 0.30], ["drevan", 1700, 0.80],
  ];

  /** Event-ordered replay: post at arrival, read at max(arrival, min(deadline, arrival + window)). */
  async function replay(deadlineFor: (created: number) => number) {
    const redis = fakeRedis();
    const events: Array<{ at: number; run: () => Promise<void> }> = [];
    const outs: Array<{ me: CompanionId; iSpeak: boolean }> = [];
    for (const [me, lat, score] of arrivals) {
      const arrivalAt = MSG_AT + SETTLE + lat;
      events.push({ at: arrivalAt, run: async () => { await redis.hset("ns:bid:burst", me, score.toFixed(4)); } });
      const deadlineAt = deadlineFor(MSG_AT);
      const readAt = Math.max(arrivalAt, Math.min(deadlineAt, arrivalAt + BID_WINDOW_MS));
      events.push({ at: readAt, run: async () => {
        const o = await runBidRound(redis, "burst", me, score, { deadlineAt, sleep: async () => {}, now: () => readAt });
        outs.push({ me, iSpeak: o.iSpeak });
      } });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) await e.run();
    return outs;
  }

  it("REPRODUCES the trap: the unshifted deadline is already past, so each bot reads instantly and cypher 'wins' alone", async () => {
    const outs = await replay((created) => created + BID_WINDOW_MS);
    expect(outs.filter(o => o.iSpeak).map(o => o.me)).toContain("cypher");
    expect(outs.filter(o => o.iSpeak).length).toBeGreaterThan(1);   // more than one winner
  });

  it("the shifted deadline: exactly one speaker, and it is the best fit", async () => {
    const outs = await replay((created) => bidDeadlineAt(created, SETTLE));
    expect(outs.filter(o => o.iSpeak).map(o => o.me)).toEqual(["drevan"]);
  });
});
