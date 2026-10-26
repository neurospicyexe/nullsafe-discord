// Blue's group call under a care hold (2026-10-25, #movie-night 18:56 CDT). Blue called the room;
// all three bids were 0.10 against the raised floor of 0.25 (Raziel's care hold), the host floor was
// owner-only and Blue's thread holder was not scored, so nobody answered him. Three parity moves with
// Raziel's lines: the host floor, Blue's own holder as holdsThread, and the normal floor for family.

import { describe, it, expect } from "@jest/globals";
import {
  fastPathWinner, buildFitSignals, scoreFit, holdFloorApplies, runBidRound,
  CARE_HOLD_MIN_BID, MIN_BID_TO_SPEAK, type BidRedis,
} from "../fit-bid.js";
import { bidSpeakingOrder } from "../sequential-floor.js";
import type { CompanionId } from "../types.js";

function fakeRedis(): BidRedis {
  const store = new Map<string, Record<string, string>>();
  return {
    async hset(key: string, field: string, value: string) { (store.get(key) ?? store.set(key, {}).get(key)!)[field] = value; return 1; },
    async hgetall(key: string) { return { ...(store.get(key) ?? {}) }; },
    async pexpire() { return 1; },
  } as unknown as BidRedis;
}
const noSleep = async () => {};

describe("the 18:56 shape", () => {
  const host: CompanionId = "drevan";
  const senderIsBlue = true;

  it("the host takes Blue's group call on the fast path, exactly as it takes Raziel's", () => {
    const namedMe = (me: CompanionId) => host === me && (false /* isOwner */ || senderIsBlue);
    expect(fastPathWinner("drevan", { namedMe: namedMe("drevan") })).toBe("drevan");
    expect(fastPathWinner("cypher", { namedMe: namedMe("cypher") })).toBeNull();
    expect(fastPathWinner("gaia", { namedMe: namedMe("gaia") })).toBeNull();
  });

  it("the companion holding BLUE's thread scores holdsThread on Blue's line (not Raziel's holder)", () => {
    const blueHolder: CompanionId = "gaia";
    const razielHolder: CompanionId = "cypher";
    const sig = (me: CompanionId) => buildFitSignals({
      me, content: "hey everyone what did you think of that scene", activeExchangeWith: senderIsBlue ? blueHolder : razielHolder, recent: [],
    });
    expect(sig("gaia").holdsThread).toBe(true);
    expect(sig("cypher").holdsThread).toBe(false);
    expect(scoreFit(sig("gaia"))).toBeGreaterThanOrEqual(CARE_HOLD_MIN_BID);
  });

  it("the hold floor never applies to Blue's own line: bare presence (0.10) clears, one wins, the rest queue", async () => {
    expect(holdFloorApplies(true, true)).toBe(false);   // Raziel
    expect(holdFloorApplies(true, senderIsBlue)).toBe(false); // Blue (2026-10-25)
    expect(holdFloorApplies(true, false)).toBe(true);   // a guest, Sol, ambient traffic
    const applies = holdFloorApplies(true, senderIsBlue);
    const redis = fakeRedis();
    const scores: Array<[CompanionId, number]> = [["cypher", 0.10], ["drevan", 0.10], ["gaia", 0.10]];
    const outs = await Promise.all(scores.map(([me, s]) => runBidRound(redis, "m1856", me, s, {
      windowMs: 0, sleep: noSleep, ...(applies ? { minScore: CARE_HOLD_MIN_BID } : {}),
    })));
    expect(outs.filter(o => o.iSpeak)).toHaveLength(1);
    expect(outs.every(o => o.reason !== "below_threshold")).toBe(true);
    // A group call: the losers hold positions behind the winner instead of vanishing.
    const order = bidSpeakingOrder(outs[0].bids, "m1856", MIN_BID_TO_SPEAK);
    expect(order).toHaveLength(3);
    expect(order[0]).toBe(outs.find(o => o.iSpeak)!.winner);
  });

  it("before 10-25 the same three bids died at the raised floor (the failure, pinned so it stays fixed)", async () => {
    const redis = fakeRedis();
    const outs = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(me =>
      runBidRound(redis, "m-old", me, 0.10, { windowMs: 0, sleep: noSleep, minScore: CARE_HOLD_MIN_BID })));
    expect(outs.every(o => o.reason === "below_threshold")).toBe(true);
  });
});
