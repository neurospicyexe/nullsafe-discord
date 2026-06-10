import { describe, it, expect } from "vitest";
import { decidePulse, parseProgram } from "../pulse.js";
import { PULSE_FLOAT_THRESHOLD, PULSE_MIN_GAP_MS, PULSE_EAGER_GAP_MS, PULSE_MAX_RUNS_PER_DAY } from "../config.js";

const NOW = Date.parse("2026-06-09T18:00:00Z");

describe("decidePulse", () => {
  it("never fires on self-programmed rest", () => {
    const d = decidePulse({ pace: "rest", lastRunAtMs: null, runsToday: 0, primaryFloat: 0.99, nowMs: NOW });
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("rest");
  });

  it("respects the daily run cap", () => {
    const d = decidePulse({ pace: "eager", lastRunAtMs: null, runsToday: PULSE_MAX_RUNS_PER_DAY, primaryFloat: 0.99, nowMs: NOW });
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("cap");
  });

  it("respects the minimum gap for normal pace", () => {
    const d = decidePulse({
      pace: "normal",
      lastRunAtMs: NOW - PULSE_MIN_GAP_MS + 3600_000, // 1h short of the gap
      runsToday: 1,
      primaryFloat: 0.99,
      nowMs: NOW,
    });
    expect(d.fire).toBe(false);
    expect(d.reason).toContain("gap");
  });

  it("fires on eager pace once the eager gap is met", () => {
    const d = decidePulse({
      pace: "eager",
      lastRunAtMs: NOW - PULSE_EAGER_GAP_MS - 1,
      runsToday: 1,
      primaryFloat: null,
      nowMs: NOW,
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("eager");
  });

  it("fires when the primary float crosses the threshold", () => {
    const d = decidePulse({
      pace: "normal",
      lastRunAtMs: NOW - PULSE_MIN_GAP_MS - 1,
      runsToday: 0,
      primaryFloat: PULSE_FLOAT_THRESHOLD,
      nowMs: NOW,
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toContain("float");
  });

  it("does not fire on null or NaN floats (Number(null)===0 trap)", () => {
    for (const f of [null, NaN]) {
      const d = decidePulse({
        pace: "normal",
        lastRunAtMs: null,
        runsToday: 0,
        primaryFloat: f as number | null,
        nowMs: NOW,
      });
      expect(d.fire).toBe(false);
    }
  });

  it("does not fire below threshold with no eager pace", () => {
    const d = decidePulse({
      pace: "normal",
      lastRunAtMs: null,
      runsToday: 0,
      primaryFloat: PULSE_FLOAT_THRESHOLD - 0.05,
      nowMs: NOW,
    });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no signal");
  });
});

describe("parseProgram", () => {
  it("parses a valid program", () => {
    const p = parseProgram(JSON.stringify({ pace: "eager", focus: "basin geometry", set_at: "2026-06-09T03:00:00Z" }));
    expect(p).toEqual({ pace: "eager", focus: "basin geometry", set_at: "2026-06-09T03:00:00Z" });
  });

  it("returns null for null, garbage, and invalid pace", () => {
    expect(parseProgram(null)).toBeNull();
    expect(parseProgram("not json")).toBeNull();
    expect(parseProgram(JSON.stringify({ pace: "frantic" }))).toBeNull();
  });

  it("normalizes blank focus to null", () => {
    const p = parseProgram(JSON.stringify({ pace: "normal", focus: "   " }));
    expect(p?.focus).toBeNull();
  });
});
