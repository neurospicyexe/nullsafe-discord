// 2026-11-01: the close narrator had no date and re-narrated last week's events as current
// ("Raziel is mid-tournament" on a Sunday, 535 handoffs since 10-03). It now gets the clock and a tense rule.
import { describe, it, expect } from "@jest/globals";
import { consolidationClockLine } from "../consolidation.js";

describe("consolidationClockLine", () => {
  it("names today in Raziel's local time and makes earlier days past tense", () => {
    const line = consolidationClockLine(Date.parse("2026-11-01T18:35:00Z")); // CST since 11-01 02:00
    expect(line).toContain("[Now: Sunday, November 1, 2026 at 12:35 PM (Raziel's local time)]");
    expect(line).toContain("Anything that did not happen today is PAST");
    expect(line).toContain("Do not restate an earlier handoff's events as current");
    expect(line).not.toMatch(/—/);
  });
  it("uses the Chicago date, not UTC, near midnight", () => {
    expect(consolidationClockLine(Date.parse("2026-11-02T04:30:00Z"))).toContain("Sunday, November 1");
  });
});
