// Tests for the reaction tier (2026-08-15 floor rework): earned, rare, deterministic.

import { describe, it, expect } from "@jest/globals";
import {
  REACTION_PALETTES,
  REACT_MIN_BID_SCORE,
  REACTION_COOLDOWN_MS,
  pickReaction,
  shouldReactOnBidLoss,
  shouldReactOnNamedOther,
} from "../reaction-tier.js";
import type { CompanionId } from "../types.js";

const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];

describe("pickReaction", () => {
  it("is deterministic per (companion, message)", () => {
    for (const c of COMPANIONS) {
      expect(pickReaction(c, "123456789")).toBe(pickReaction(c, "123456789"));
    }
  });

  it("always picks from the companion's own palette", () => {
    for (const c of COMPANIONS) {
      for (let i = 0; i < 20; i++) {
        expect(REACTION_PALETTES[c]).toContain(pickReaction(c, String(5000 + i)));
      }
    }
  });

  it("rotates across consecutive message ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(pickReaction("cypher", String(7000 + i)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("shouldReactOnBidLoss", () => {
  const now = 1_000_000;

  it("fires on a real losing claim with the cooldown clear", () => {
    expect(shouldReactOnBidLoss(REACT_MIN_BID_SCORE, 0, now)).toBe(true);
  });

  it("bare presence earns nothing", () => {
    expect(shouldReactOnBidLoss(0.1, 0, now)).toBe(false);
  });

  it("cooldown throttles", () => {
    expect(shouldReactOnBidLoss(0.9, now + 1, now)).toBe(false);
    expect(shouldReactOnBidLoss(0.9, now, now)).toBe(true);
  });
});

describe("shouldReactOnNamedOther", () => {
  const now = 1_000_000;

  it("fires when the message carries a strong lane claim", () => {
    // dense cypher-lane vocabulary
    const msg = "drevan, the deploy broke -- tests fail, the migration errored, the api schema is wrong";
    expect(shouldReactOnNamedOther(msg, "cypher", 0, now)).toBe(true);
  });

  it("stays silent on an off-lane message", () => {
    expect(shouldReactOnNamedOther("drevan, sing me the moss song again", "cypher", 0, now)).toBe(false);
  });

  it("cooldown throttles regardless of relevance", () => {
    const msg = "drevan, the deploy broke -- tests fail, the migration errored, the api schema is wrong";
    expect(shouldReactOnNamedOther(msg, "cypher", now + REACTION_COOLDOWN_MS, now)).toBe(false);
  });
});
