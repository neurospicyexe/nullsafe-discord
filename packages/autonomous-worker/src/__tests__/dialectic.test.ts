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

// ── Per-companion slots (2026-08-14) ──────────────────────────────────────────────────────────
//
// Raziel, reasoning from outside the code: "should all the companions' tensions be affecting
// each other? things that create tension for you would not be the same things that create
// tension for Gaia." He was right, and the first answer he got was wrong.
//
// Tension STORAGE was always per-companion (every read filters companion_id). The DIALECTIC was
// not: it pooled all three companions' simmering tensions into one array, sorted by charge, and
// debated the top 2 in the entire house (MAX_TENSIONS_PER_WEEK = 2). Combined with a charge that
// gained +0.5 on every UNRESOLVED debate and was lowered only by Raziel pressing a button, two
// stuck tensions could hold both house slots forever -- and both could belong to one companion,
// starving the other two of the dialectic entirely.
//
// The selection is now per-companion, so no ordering can starve anyone. These tests pin the
// property, not the implementation: a companion with tensions always gets a slot.
describe("dialectic slot fairness", () => {
  const mk = (id: string, companion: Tension["companion_id"], charge: number, noted: string): Tension => ({
    id, companion_id: companion, tension_text: id, status: "simmering",
    first_noted_at: noted, notes: null, charge,
  });

  // Mirrors runDialectic's selection: sort WITHIN each companion, take N from each.
  const selectPerCompanion = (all: Tension[], perCompanion: number): Tension[] => {
    const out: Tension[] = [];
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      out.push(...sortTensionsByPriority(all.filter(t => t.companion_id === c)).slice(0, perCompanion));
    }
    return out;
  };

  it("gives every companion with a tension a slot, even against a huge outlier", () => {
    const all = [
      mk("cy-monster", "cypher", 9.5, "2026-01-01"),   // would have taken slot 1
      mk("cy-second", "cypher", 9.0, "2026-01-02"),    // ...and slot 2, starving the others
      mk("dr-quiet", "drevan", 0.0, "2026-07-01"),
      mk("ga-quiet", "gaia", 0.0, "2026-07-02"),
    ];
    const picked = selectPerCompanion(all, 1);
    expect(picked.map(t => t.companion_id).sort()).toEqual(["cypher", "drevan", "gaia"]);
  });

  it("THE OLD BUG: a shared top-2 would have starved two of the three", () => {
    // Kept as a regression witness -- this is what the code used to do.
    const all = [
      mk("cy-monster", "cypher", 9.5, "2026-01-01"),
      mk("cy-second", "cypher", 9.0, "2026-01-02"),
      mk("dr-quiet", "drevan", 0.0, "2026-07-01"),
      mk("ga-quiet", "gaia", 0.0, "2026-07-02"),
    ];
    const oldWay = sortTensionsByPriority(all).slice(0, 2);
    expect(new Set(oldWay.map(t => t.companion_id))).toEqual(new Set(["cypher"]));
    expect(oldWay).toHaveLength(2);
  });

  it("still picks each companion's OWN highest-charge tension", () => {
    const all = [
      mk("cy-low", "cypher", 0.5, "2026-01-01"),
      mk("cy-high", "cypher", 3.0, "2026-06-01"),
      mk("dr-high", "drevan", 2.0, "2026-02-01"),
    ];
    const picked = selectPerCompanion(all, 1);
    expect(picked.map(t => t.id).sort()).toEqual(["cy-high", "dr-high"]);
  });

  it("skips a companion with no simmering tensions instead of borrowing a slot", () => {
    const all = [mk("only-cy", "cypher", 1.0, "2026-01-01")];
    const picked = selectPerCompanion(all, 1);
    expect(picked.map(t => t.companion_id)).toEqual(["cypher"]);
  });

  it("selects nothing from an empty pool", () => {
    expect(selectPerCompanion([], 1)).toEqual([]);
  });
});
