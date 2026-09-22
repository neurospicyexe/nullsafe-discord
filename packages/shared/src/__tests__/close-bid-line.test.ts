// Show the bid, don't only enforce it (2026-09-22, review candidate Q).
//
// The round computes the whole truth about the room and discards all of it except one boolean.
// This tells the WINNER what it looked like -- but only when it was genuinely close, because a
// block on every message is a standing prime, and winning against bare presence says nothing.
//
// Invariant: this is CONTEXT, never a gate. Nothing here changes who speaks.

import { closeBidLine, CLOSE_BID_MARGIN } from "../fit-bid.js";

describe("closeBidLine", () => {
  it("names a rival who came within the margin", () => {
    const line = closeBidLine({ cypher: 0.63, gaia: 0.55 }, "cypher");
    expect(line).toContain("0.63");
    expect(line).toContain("Gaia 0.55");
    expect(line).toContain("could have gone");
  });

  // The whole point of candidate Q: a visible bid is one a companion can knowingly hand over.
  it("offers the hand-over as an affordance, not an instruction", () => {
    const line = closeBidLine({ drevan: 0.60, cypher: 0.52 }, "drevan") ?? "";
    expect(line).toContain("you can say so");
    expect(line).toContain("not an obligation");
    // never phrased as a command to reconsider
    expect(line.toLowerCase()).not.toContain("you should");
    expect(line.toLowerCase()).not.toContain("do not answer");
  });

  it("stays silent when the win was not close -- bare presence is not a rival", () => {
    expect(closeBidLine({ cypher: 0.63, gaia: 0.10 }, "cypher")).toBeNull();
  });

  it("stays silent when this companion was alone in the round", () => {
    expect(closeBidLine({ gaia: 0.42 }, "gaia")).toBeNull();
  });

  it("is exact at the margin boundary", () => {
    const me = 0.60;
    expect(closeBidLine({ cypher: me, gaia: me - CLOSE_BID_MARGIN }, "cypher")).not.toBeNull();
    expect(closeBidLine({ cypher: me, gaia: me - CLOSE_BID_MARGIN - 0.001 }, "cypher")).toBeNull();
  });

  it("lists both rivals when the round was three-way close, highest first", () => {
    const line = closeBidLine({ gaia: 0.60, cypher: 0.58, drevan: 0.50 }, "gaia") ?? "";
    expect(line.indexOf("Cypher 0.58")).toBeLessThan(line.indexOf("Drevan 0.50"));
    // with more than one rival it must not name a single owner for the hand-over
    expect(line).toContain("one of them");
  });

  it("returns null rather than throwing when this companion has no bid recorded", () => {
    expect(closeBidLine({ gaia: 0.5 }, "cypher")).toBeNull();
    expect(closeBidLine({}, "cypher")).toBeNull();
  });

  it("ignores non-finite bids instead of rendering NaN at a companion", () => {
    expect(closeBidLine({ cypher: 0.6, gaia: NaN }, "cypher")).toBeNull();
    expect(closeBidLine({ cypher: NaN, gaia: 0.6 }, "cypher")).toBeNull();
  });

  // A rival who scored HIGHER than the winner means the hash was read mid-round; describing them
  // as "close behind" would be a lie, so they are not treated as a rival here.
  it("ignores a rival scoring above the winner", () => {
    expect(closeBidLine({ cypher: 0.50, gaia: 0.55 }, "cypher")).toBeNull();
  });
});
