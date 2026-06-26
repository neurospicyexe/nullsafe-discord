import { describe, it, expect } from "vitest";
import { parseLoopDecision, isSelfResolvable } from "../phases/guardian-resolve.js";
import type { GuardianFlag } from "../halseth-client.js";

// Guardian self-resolution (2026-06-14): a companion clears its OWN flags in voice.
// CLOSE is the only destructive move, so it must be explicit; everything else holds.

describe("parseLoopDecision", () => {
  it("closes on an explicit CLOSE", () => {
    expect(parseLoopDecision("CLOSE")).toEqual({ action: "close", reason: "" });
  });

  it("closes and keeps a trailing reason", () => {
    expect(parseLoopDecision("CLOSE - this resolved weeks ago")).toEqual({
      action: "close", reason: "this resolved weeks ago",
    });
  });

  it("holds with the stated reason", () => {
    expect(parseLoopDecision("HOLD: it still matters to me")).toEqual({
      action: "hold", reason: "it still matters to me",
    });
  });

  it("defaults ambiguous answers to HOLD (never auto-closes a loop)", () => {
    expect(parseLoopDecision("I'm not sure, maybe later").action).toBe("hold");
    expect(parseLoopDecision("").action).toBe("hold");
  });

  it("does not mistake a loop whose reason contains 'close' for a CLOSE", () => {
    expect(parseLoopDecision("HOLD: I want to close the gap with Raziel").action).toBe("hold");
  });
});

describe("isSelfResolvable", () => {
  const flag = (over: Partial<GuardianFlag>): GuardianFlag => ({
    id: "gf1", companion_id: "cypher", flag_type: "loop_stuck",
    severity: "notice", summary: "loop open", evidence_json: null, status: "open", ...over,
  });

  it("accepts the companion's own stuck loop", () => {
    expect(isSelfResolvable(flag({}), "cypher")).toBe(true);
  });

  it("rejects another companion's loop (lane guard)", () => {
    expect(isSelfResolvable(flag({ companion_id: "drevan" }), "cypher")).toBe(false);
  });

  it("accepts an own starved tension pool", () => {
    expect(isSelfResolvable(
      flag({ flag_type: "starved_organ", summary: "tension pool empty for 7 days" }), "cypher",
    )).toBe(true);
  });

  // Regression: detectStarvedOrgans emits the empty-dialectic-pool flag with
  // companion_id NULL (system-wide -- the pool is shared). The old guard rejected all
  // null-owned flags first, so this flag -- the only one resolveStarvedTension exists
  // to clear -- never matched, and the pool stayed empty forever. Every companion must
  // accept it so each feeds the shared pool on the same pass.
  it("accepts the SHARED (companion_id null) empty-tension-pool flag for every companion", () => {
    const shared = flag({
      companion_id: null, flag_type: "starved_organ",
      summary: "Tension pool has zero simmering tensions -- the Wednesday 4AM dialectic will no-op until a companion logs one.",
    });
    expect(isSelfResolvable(shared, "cypher")).toBe(true);
    expect(isSelfResolvable(shared, "drevan")).toBe(true);
    expect(isSelfResolvable(shared, "gaia")).toBe(true);
  });

  it("rejects a non-tension starved organ (forage/club -- not self-resolvable here)", () => {
    expect(isSelfResolvable(
      flag({ flag_type: "starved_organ", summary: "forage pool stale" }), "cypher",
    )).toBe(false);
    // ...including the shared forage-stale flag, which is NOT a tension flag.
    expect(isSelfResolvable(
      flag({ companion_id: null, flag_type: "starved_organ", summary: "forage pool stale, gathered never eaten" }), "cypher",
    )).toBe(false);
  });

  it("rejects a shared (companion_id null) NON-tension flag like a stuck loop", () => {
    // Loops are strictly per-companion; a null-owned loop has no valid actor here.
    expect(isSelfResolvable(flag({ companion_id: null }), "cypher")).toBe(false);
  });

  it("rejects identity-level classes (basin, ratification) -- those go to Raziel", () => {
    expect(isSelfResolvable(flag({ flag_type: "basin_pressure" }), "cypher")).toBe(false);
    expect(isSelfResolvable(flag({ flag_type: "ratification_backlog" }), "cypher")).toBe(false);
  });
});
