// Tests for the sequential floor (2026-08-15 floor rework): deterministic speaking order
// for multi-address messages, and the follow-up entitlement lifecycle.

import { describe, it, expect } from "@jest/globals";
import {
  namedOrderInMessage,
  bidSpeakingOrder,
  FollowUpLedger,
  FOLLOW_UP_TTL_MS,
  type FollowUpEntitlement,
} from "../sequential-floor.js";
import { MIN_BID_TO_SPEAK } from "../fit-bid.js";
import type { CompanionId } from "../types.js";

describe("namedOrderInMessage", () => {
  it("orders by first occurrence in the text, not by companion id", () => {
    expect(namedOrderInMessage("Drev and Cy, what do you think?", ["cypher", "drevan"]))
      .toEqual(["drevan", "cypher"]);
    expect(namedOrderInMessage("Cypher then Drevan please", ["cypher", "drevan"]))
      .toEqual(["cypher", "drevan"]);
  });

  it("aliases count as the name's position", () => {
    // "cy" appears before "gaia"
    expect(namedOrderInMessage("cy and gaia -- weigh in", ["gaia", "cypher"]))
      .toEqual(["cypher", "gaia"]);
  });

  it("is deterministic for three companions", () => {
    const order = namedOrderInMessage("Gaia, Drevan, Cypher: go", ["cypher", "drevan", "gaia"]);
    expect(order).toEqual(["gaia", "drevan", "cypher"]);
  });
});

describe("bidSpeakingOrder", () => {
  it("orders by score descending", () => {
    const order = bidSpeakingOrder({ cypher: 0.5, drevan: 0.8, gaia: 0.3 }, "12345", MIN_BID_TO_SPEAK);
    expect(order).toEqual(["drevan", "cypher", "gaia"]);
  });

  it("drops bidders below the minimum", () => {
    const order = bidSpeakingOrder({ cypher: 0.5, drevan: 0.05 }, "12345", MIN_BID_TO_SPEAK);
    expect(order).toEqual(["cypher"]);
  });

  it("breaks ties deterministically -- same order from every process", () => {
    const bids = { cypher: 0.4, drevan: 0.4, gaia: 0.4 };
    const a = bidSpeakingOrder({ ...bids }, "9876543210", MIN_BID_TO_SPEAK);
    const b = bidSpeakingOrder({ ...bids }, "9876543210", MIN_BID_TO_SPEAK);
    expect(a).toEqual(b);
    expect(new Set(a)).toEqual(new Set(["cypher", "drevan", "gaia"]));
  });

  it("tie order rotates across message ids instead of always favouring one name", () => {
    const bids = { cypher: 0.4, drevan: 0.4, gaia: 0.4 };
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      firsts.add(bidSpeakingOrder({ ...bids }, String(1000000 + i), MIN_BID_TO_SPEAK)[0]);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("returns empty for an empty round", () => {
    expect(bidSpeakingOrder({}, "1", MIN_BID_TO_SPEAK)).toEqual([]);
  });
});

describe("FollowUpLedger", () => {
  const base: FollowUpEntitlement = {
    originMessageId: "origin-1",
    channelId: "chan-1",
    expectedPrior: "drevan" as CompanionId,
    position: 1,
    expiresAt: Date.now() + FOLLOW_UP_TTL_MS,
  };

  it("releases on the predecessor's reply that references the origin", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base });
    const hit = ledger.match("chan-1", "drevan", "origin-1");
    expect(hit).not.toBeNull();
    expect(hit!.originMessageId).toBe("origin-1");
    // consumed: a second identical message does not release twice
    expect(ledger.match("chan-1", "drevan", "origin-1")).toBeNull();
  });

  it("does not release for the wrong companion", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base });
    expect(ledger.match("chan-1", "gaia", "origin-1")).toBeNull();
    // still pending for the right one
    expect(ledger.match("chan-1", "drevan", "origin-1")).not.toBeNull();
  });

  it("does not release on a reply referencing a different message", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base });
    expect(ledger.match("chan-1", "drevan", "other-message")).toBeNull();
  });

  it("does not release in a different channel", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base });
    expect(ledger.match("chan-2", "drevan", "origin-1")).toBeNull();
  });

  it("expires: a stale entitlement never fires and is dropped", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base, expiresAt: Date.now() - 1 });
    expect(ledger.match("chan-1", "drevan", "origin-1")).toBeNull();
    // dropped, not lingering
    expect(ledger.match("chan-1", "drevan", "origin-1")).toBeNull();
  });

  it("a newer grant in the same channel supersedes the older wait", () => {
    const ledger = new FollowUpLedger();
    ledger.grant({ ...base });
    ledger.grant({ ...base, originMessageId: "origin-2", expectedPrior: "gaia" as CompanionId });
    expect(ledger.match("chan-1", "drevan", "origin-1")).toBeNull();
    expect(ledger.match("chan-1", "gaia", "origin-2")).not.toBeNull();
  });
});
