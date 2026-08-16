// Tests for the reaction tier (2026-08-15 floor rework): earned, rare, deterministic.

import { describe, it, expect } from "@jest/globals";
import {
  describeReactor,
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

describe("describeReactor -- naming who reacted (reading side, 2026-08-16)", () => {
  it("names a sibling bot by companion name in its username", () => {
    expect(describeReactor({ id: "1", bot: true, username: "Drevan" }, "cypher", "owner1", "Raziel")).toBe("drevan");
    expect(describeReactor({ id: "2", bot: true, username: "gaia-bot" }, "cypher", "owner1", "Raziel")).toBe("gaia");
  });

  it("drops an unrecognized bot reactor (fail closed, like the webhook muzzle)", () => {
    expect(describeReactor({ id: "3", bot: true, username: "SomeIntegration" }, "cypher", "owner1", "Raziel")).toBeNull();
  });

  it("never attributes the companion's own name to itself", () => {
    // a bot whose username contains MY name is not a sibling
    expect(describeReactor({ id: "4", bot: true, username: "Cypher" }, "cypher", "owner1", "Raziel")).toBeNull();
  });

  it("names the owner by id, with the display name winning over the username", () => {
    expect(describeReactor({ id: "owner1", bot: false, username: "razse" }, "cypher", "owner1", "Raziel")).toBe("Raziel");
  });

  it("falls back to the username for other humans, and to a neutral word with none", () => {
    expect(describeReactor({ id: "9", bot: false, username: "blue" }, "cypher", "owner1", "Raziel")).toBe("blue");
    expect(describeReactor({ id: "9", bot: false, username: null }, "cypher", "owner1", "Raziel")).toBe("someone");
  });
});
