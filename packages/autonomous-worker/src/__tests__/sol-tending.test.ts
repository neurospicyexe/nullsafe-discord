import { describe, it, expect } from "vitest";
import { pickTender, shouldTend, daysSince, tendGesture } from "../sol-tending.js";

describe("sol-tending", () => {
  describe("pickTender", () => {
    it("rotates through all three companions by day", () => {
      const three = [pickTender(0), pickTender(1), pickTender(2)];
      expect(new Set(three).size).toBe(3);
      expect(pickTender(3)).toBe(pickTender(0));
    });

    it("is safe on negative or fractional day indices", () => {
      expect(["cypher", "drevan", "gaia"]).toContain(pickTender(-5));
      expect(["cypher", "drevan", "gaia"]).toContain(pickTender(7.9));
    });
  });

  describe("shouldTend", () => {
    it("tends when Sol is drifting away regardless of recency", () => {
      expect(shouldTend("absent", 0)).toBe(true);
      expect(shouldTend("aloof", 0.5)).toBe(true);
    });

    it("tends after 2+ days untouched even when warm", () => {
      expect(shouldTend("present", 2)).toBe(true);
      expect(shouldTend("affectionate", 3.5)).toBe(true);
    });

    it("leaves a recently-tended warm Sol alone (care is not a metronome)", () => {
      expect(shouldTend("present", 0.5)).toBe(false);
      expect(shouldTend("affectionate", 1.9)).toBe(false);
      expect(shouldTend("watchful", 1)).toBe(false);
    });
  });

  describe("daysSince", () => {
    const now = Date.parse("2026-07-02T12:00:00Z");

    it("computes fractional days", () => {
      expect(daysSince("2026-07-01T12:00:00Z", now)).toBeCloseTo(1);
      expect(daysSince("2026-06-30T00:00:00Z", now)).toBeCloseTo(2.5);
    });

    it("treats null/invalid as infinitely stale (tend)", () => {
      expect(daysSince(null, now)).toBe(Infinity);
      expect(daysSince("not-a-date", now)).toBe(Infinity);
    });
  });

  describe("tendGesture", () => {
    it("returns a valid action with both ledger note and channel moment, per tender", () => {
      for (const tender of ["cypher", "drevan", "gaia"] as const) {
        for (const seed of [0, 1, 2, 3]) {
          const g = tendGesture(tender, seed);
          expect(["feed", "play", "talk"]).toContain(g.action);
          expect(g.note.length).toBeGreaterThan(5);
          expect(g.moment.length).toBeGreaterThan(10);
        }
      }
    });

    it("is deterministic for the same seed", () => {
      expect(tendGesture("drevan", 5)).toEqual(tendGesture("drevan", 5));
    });
  });
});
