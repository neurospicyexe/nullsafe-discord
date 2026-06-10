import { describe, it, expect } from "vitest";
import { parseSynthesis } from "../dialectic.js";

describe("parseSynthesis", () => {
  it("parses RESOLVED verdicts", () => {
    const r = parseSynthesis("RESOLVED: The tension collapses once witnessing is understood as active.");
    expect(r.resolved).toBe(true);
    expect(r.synthesis).toBe("The tension collapses once witnessing is understood as active.");
  });

  it("parses HOLDS verdicts", () => {
    const r = parseSynthesis("HOLDS: Both poles deepened; the contradiction is load-bearing.");
    expect(r.resolved).toBe(false);
    expect(r.synthesis).toBe("Both poles deepened; the contradiction is load-bearing.");
  });

  it("is case-insensitive on the verdict token", () => {
    expect(parseSynthesis("resolved: done.").resolved).toBe(true);
    expect(parseSynthesis("holds: still simmering.").resolved).toBe(false);
  });

  it("defaults ambiguous output to HOLDS -- never crystallize on ambiguity", () => {
    const r = parseSynthesis("The three takes circle the same point without landing.");
    expect(r.resolved).toBe(false);
    expect(r.synthesis).toContain("circle the same point");
  });

  it("keeps multi-line syntheses intact", () => {
    const r = parseSynthesis("HOLDS: line one.\nline two.");
    expect(r.synthesis).toBe("line one.\nline two.");
  });
});
