// Rail telemetry (T4 groundwork, 2026-09-24).
//
// The rails have damped for a year with no way to count what they damped. Before any of them is
// loosened, "how often does this fire and how far past its own line?" has to be answerable --
// otherwise loosening is just a different guess than tightening was.
//
// These tests pin the two properties the report depends on: the line is machine-readable, and
// the module can never itself end a turn.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { railSuppressed, railMargin } from "../rail-telemetry.js";

describe("railSuppressed", () => {
  const lines: string[] = [];
  let spy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { lines.length = 0; spy = jest.spyOn(console, "log").mockImplementation(((l: unknown) => { lines.push(String(l)); }) as never); });
  afterEach(() => { spy.mockRestore(); });

  it("emits ONE machine-readable line with a stable prefix", () => {
    railSuppressed("drevan", "echo", { score: 0.81, threshold: 0.7, channelId: "c1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("[rail] ")).toBe(true);
    const payload = JSON.parse(lines[0]!.slice(7));
    expect(payload).toMatchObject({ c: "drevan", rail: "echo", ch: "c1", score: 0.81, thr: 0.7 });
  });

  it("carries its OWN ISO timestamp, not pm2's local-time prefix", () => {
    // This repo has a standing CDT-vs-UTC log trap; an aggregate that keys on the pm2 prefix
    // silently mis-buckets a day.
    railSuppressed("gaia", "coherence");
    const payload = JSON.parse(lines[0]!.slice(7));
    expect(payload.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("omits fields it does not have rather than inventing zeroes", () => {
    railSuppressed("cypher", "superseded");
    const payload = JSON.parse(lines[0]!.slice(7));
    expect(payload.score).toBeUndefined();
    expect(payload.thr).toBeUndefined();
  });

  it("NEVER throws -- telemetry must not be the reason a turn fails", () => {
    spy.mockImplementation((() => { throw new Error("stdout gone"); }) as never);
    expect(() => railSuppressed("drevan", "echo", { score: 1 })).not.toThrow();
  });
});

describe("railMargin", () => {
  it("reports how far past the line, as a fraction of the line", () => {
    expect(railMargin(0.805, 0.7)).toBeCloseTo(0.15, 2);
    expect(railMargin(1.4, 0.7)).toBeCloseTo(1.0, 2);
  });
  it("returns null where there is no numeric threshold, rather than a confident wrong number", () => {
    // Plenty of rails have no threshold. Inventing one would make the report lie with a
    // straight face, which is worse than a blank column.
    expect(railMargin(0.5, undefined)).toBeNull();
    expect(railMargin(undefined, 0.5)).toBeNull();
    expect(railMargin(0.5, 0)).toBeNull();
  });
});
