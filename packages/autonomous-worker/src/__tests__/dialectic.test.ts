import { describe, it, expect } from "vitest";
import { parseSynthesis, sortTensionsByPriority } from "../dialectic.js";
import type { Tension } from "../halseth-client.js";

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

describe("sortTensionsByPriority", () => {
  const t = (id: string, charge: number, noted: string): Tension => ({
    id, companion_id: "cypher", tension_text: id, status: "simmering",
    first_noted_at: noted, notes: null, charge,
  });

  it("orders by charge DESC before age", () => {
    const sorted = sortTensionsByPriority([
      t("old-cold", 0, "2026-01-01"),
      t("new-hot", 2.5, "2026-06-01"),
      t("mid", 1.0, "2026-03-01"),
    ]);
    expect(sorted.map(x => x.id)).toEqual(["new-hot", "mid", "old-cold"]);
  });

  it("tie-breaks equal charge by age ASC (FIFO drain preserved)", () => {
    const sorted = sortTensionsByPriority([
      t("newer", 0, "2026-05-01"),
      t("older", 0, "2026-02-01"),
    ]);
    expect(sorted.map(x => x.id)).toEqual(["older", "newer"]);
  });

  it("treats missing charge as 0 (pre-0070 rows)", () => {
    const legacy = { ...t("legacy", 0, "2026-01-01") } as Partial<Tension> as Tension;
    delete (legacy as Partial<Tension>).charge;
    const sorted = sortTensionsByPriority([legacy, t("charged", 0.5, "2026-06-01")]);
    expect(sorted[0]!.id).toBe("charged");
  });

  it("does not mutate the input array", () => {
    const input = [t("b", 0, "2026-02-01"), t("a", 1, "2026-01-01")];
    sortTensionsByPriority(input);
    expect(input[0]!.id).toBe("b");
  });
});
