import { describe, it, expect } from "vitest";
import { effectiveForageReserve } from "../search-client.js";

describe("effectiveForageReserve", () => {
  it("uses the configured reserve when the budget is healthy", () => {
    expect(effectiveForageReserve(24, 8)).toBe(8);
  });

  it("never lets the reserve starve exploration on a low pinned cap", () => {
    // .env may still pin TAVILY_MAX_PER_DAY=5 (the old default). An unclamped reserve of 8
    // makes `remaining <= reserve` true on the first call -> explore gets zero searches.
    expect(effectiveForageReserve(5, 8)).toBe(2);
    expect(effectiveForageReserve(5, 8)).toBeLessThan(5);
  });

  it("leaves at least half the budget spendable by explore", () => {
    for (const cap of [1, 2, 3, 5, 6, 10, 24, 33]) {
      expect(effectiveForageReserve(cap, 8)).toBeLessThanOrEqual(Math.floor(cap / 2));
    }
  });

  it("degrades to no reserve on a degenerate cap", () => {
    expect(effectiveForageReserve(1, 8)).toBe(0);
    expect(effectiveForageReserve(0, 8)).toBe(0);
  });
});
