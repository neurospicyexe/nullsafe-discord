import { describe, it, expect } from "vitest";
import { decidePulse, parseProgram, runTimestampMs } from "../pulse.js";
import { PULSE_FLOAT_THRESHOLD, PULSE_MIN_GAP_MS, PULSE_EAGER_GAP_MS, PULSE_MAX_RUNS_PER_DAY } from "../config.js";

const NOW = Date.parse("2026-06-09T18:00:00Z");

// autonomy_runs mixes formats in the same row: started_at is D1's unmarked-UTC
// "2026-07-09 08:00:00"; completed_at is ISO with a Z. new Date() reads the former as LOCAL.
// On the CDT VPS that put every past run 5h in the FUTURE, so the pulse gap ran 5h short and
// suppressed runs. Live evidence: "[pulse/cypher] no fire: gap not met (-1h < 20h)".
describe("runTimestampMs", () => {
  it("treats D1 unmarked datetimes as UTC, not local", () => {
    expect(runTimestampMs({ started_at: "2026-07-09 08:00:00" }))
      .toBe(Date.parse("2026-07-09T08:00:00Z"));
  });

  it("parses ISO timestamps unchanged", () => {
    expect(runTimestampMs({ started_at: "2026-07-09T08:00:00.000Z" }))
      .toBe(Date.parse("2026-07-09T08:00:00Z"));
  });

  it("respects an explicit offset", () => {
    expect(runTimestampMs({ started_at: "2026-07-09T08:00:00+02:00" }))
      .toBe(Date.parse("2026-07-09T06:00:00Z"));
  });

  it("falls back to created_at when started_at is absent", () => {
    expect(runTimestampMs({ created_at: "2026-07-09 08:00:00" }))
      .toBe(Date.parse("2026-07-09T08:00:00Z"));
  });

  it("returns null on absent / unparseable input", () => {
    expect(runTimestampMs({})).toBeNull();
    expect(runTimestampMs({ started_at: "not a date" })).toBeNull();
  });

  // The regression, stated as behavior: a past run must never read as future.
  // Cypher's 08:00 UTC cron, seen from the 12:30 UTC pulse check, is 4.5h ago.
  // Parsed as local on the CDT VPS it became 13:00 UTC -- half an hour in the future,
  // which the log rendered as "gap not met (-1h < 20h)".
  it("never yields a future timestamp for a past run (no negative gaps)", () => {
    const nowMs = Date.parse("2026-07-09T12:30:00Z");
    const lastRun = runTimestampMs({ started_at: "2026-07-09 08:00:00" })!;
    expect(nowMs - lastRun).toBe(4.5 * 3600_000);
    expect(nowMs - lastRun).toBeGreaterThan(0);
  });
});

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
