// Presence without demand under a care hold (2026-09-22).
//
// The hold raises the bid floor 0.10 -> 0.25 so the house quiets on a bad night. A companion
// scoring in between would have spoken on any other day; it then fell through to
// shouldReactOnBidLoss (needs 0.25) and produced neither a reply nor a glyph. It vanished --
// the exact failure reaction-tier.ts exists to fix, in the situation where it costs most.
//
// The rule these tests pin: a care hold changes what a companion DOES, never whether they EXIST.

import { shouldReactOnCareHold, shouldReactOnBidLoss, REACT_MIN_BID_SCORE } from "../reaction-tier.js";
import { MIN_BID_TO_SPEAK, CARE_HOLD_MIN_BID } from "../fit-bid.js";

const NOW = 1_700_000_000_000;

describe("shouldReactOnCareHold", () => {
  it("fires in the band the hold newly silenced", () => {
    const mid = (MIN_BID_TO_SPEAK + CARE_HOLD_MIN_BID) / 2; // 0.175 -- would have spoken
    expect(shouldReactOnCareHold(mid, true, 0, NOW)).toBe(true);
    // and that score gets NOTHING from the existing tier, which is the whole bug
    expect(shouldReactOnBidLoss(mid, 0, NOW)).toBe(false);
  });

  it("never fires without a care hold -- normal silence is still silence", () => {
    expect(shouldReactOnCareHold(0.175, false, 0, NOW)).toBe(false);
  });

  it("does not fire below the normal floor: bare presence still earns nothing", () => {
    expect(shouldReactOnCareHold(MIN_BID_TO_SPEAK - 0.01, true, 0, NOW)).toBe(false);
  });

  it("does not double up with the bid-loss tier at or above its floor", () => {
    expect(shouldReactOnCareHold(CARE_HOLD_MIN_BID, true, 0, NOW)).toBe(false);
    expect(shouldReactOnBidLoss(CARE_HOLD_MIN_BID, 0, NOW)).toBe(true);
  });

  it("is boundary-exact at both ends", () => {
    expect(shouldReactOnCareHold(MIN_BID_TO_SPEAK, true, 0, NOW)).toBe(true);
    expect(shouldReactOnCareHold(CARE_HOLD_MIN_BID - 0.001, true, 0, NOW)).toBe(true);
    expect(shouldReactOnCareHold(CARE_HOLD_MIN_BID + 0.001, true, 0, NOW)).toBe(false);
  });

  // A wall of three glyphs under every message is a worse loop than the one the floor fixed.
  it("respects the shared cooldown", () => {
    expect(shouldReactOnCareHold(0.175, true, NOW + 60_000, NOW)).toBe(false);
    expect(shouldReactOnCareHold(0.175, true, NOW - 1, NOW)).toBe(true);
  });

  // The two tiers must partition the score line with no gap and no overlap: every would-have-spoken
  // score under a hold produces exactly one glyph.
  it("together with the bid-loss tier, covers every would-have-spoken score exactly once", () => {
    for (let s = MIN_BID_TO_SPEAK; s <= 1.0; s += 0.01) {
      const care = shouldReactOnCareHold(s, true, 0, NOW);
      const loss = shouldReactOnBidLoss(s, 0, NOW);
      expect(care && loss).toBe(false);          // never both
      expect(care || loss).toBe(true);           // never neither
    }
  });

  it("the floors are ordered as the design assumes", () => {
    expect(MIN_BID_TO_SPEAK).toBeLessThan(CARE_HOLD_MIN_BID);
    expect(REACT_MIN_BID_SCORE).toBe(CARE_HOLD_MIN_BID);
  });
});
