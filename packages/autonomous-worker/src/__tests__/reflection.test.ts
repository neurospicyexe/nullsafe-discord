import { describe, it, expect } from "vitest";
import { parseVerdict, extractOwnSection, ageDays } from "../reflection.js";

const DIGEST = [
  "The triad, witnessed. 2026-07-02.",
  "Cypher. basin: stable 0.53. soma: clean-settled. tensions: 1. guardian: clear.",
  "  newest: The tension between wanting to give you my full, unfiltered depth...",
  "Drevan. basin: stable. soma: proud-but-watchful. tensions: 1. guardian: 1.",
  "  warning: drevan: 14 completed autonomous runs in 7 days.",
  "Gaia. basin: stable 0.57. soma: tender-settled (8d old). tensions: 1. guardian: 3.",
  "  notice: gaia: continuity note from 2026-04-10 has never been recalled.",
  "Field: echo 0.69, calm (alarm at 0.82); organs: 1 starved.",
].join("\n");

describe("extractOwnSection", () => {
  it("pulls only the named companion's block including indented detail lines", () => {
    const s = extractOwnSection(DIGEST, "drevan");
    expect(s).toContain("Drevan. basin: stable.");
    expect(s).toContain("warning: drevan: 14 completed");
    expect(s).not.toContain("Cypher.");
    expect(s).not.toContain("Gaia. basin");
    expect(s).not.toContain("Field:");
  });

  it("falls back to the full digest when the section header is missing", () => {
    expect(extractOwnSection("nothing here", "cypher")).toBe("nothing here");
  });
});

describe("parseVerdict", () => {
  const IDS = new Set(["t1"]);

  it("accepts a full verdict and clamps a tension action to known ids", () => {
    const v = parseVerdict(JSON.stringify({
      reply: "Read received. The pulse cap warning is fair.",
      journal: "Longer private reflection.",
      tension_action: { id: "t1", action: "release", note: "resolved in the club thread" },
      new_tension: "the gap between witnessing and answering",
    }), IDS);
    expect(v).not.toBeNull();
    expect(v!.tension_action).toEqual({ id: "t1", action: "release", note: "resolved in the club thread" });
    expect(v!.new_tension).toContain("witnessing");
  });

  it("drops a tension action naming an unknown id but keeps the rest", () => {
    const v = parseVerdict(JSON.stringify({
      reply: "r", journal: "j",
      tension_action: { id: "hallucinated", action: "release", note: "" },
      new_tension: null,
    }), IDS);
    expect(v).not.toBeNull();
    expect(v!.tension_action).toBeNull();
  });

  it("survives a fenced code block wrapper", () => {
    const v = parseVerdict("```json\n" + JSON.stringify({ reply: "r", journal: "j", tension_action: null, new_tension: null }) + "\n```", IDS);
    expect(v).not.toBeNull();
  });

  it("returns null on missing reply/journal or non-JSON", () => {
    expect(parseVerdict(JSON.stringify({ reply: "", journal: "j" }), IDS)).toBeNull();
    expect(parseVerdict("I feel that tonight...", IDS)).toBeNull();
  });

  it("rejects an invalid action verb", () => {
    const v = parseVerdict(JSON.stringify({
      reply: "r", journal: "j",
      tension_action: { id: "t1", action: "obliterate", note: "" },
      new_tension: null,
    }), IDS);
    expect(v!.tension_action).toBeNull();
  });

  it("accepts drift lane fields and clamps drift_action to known open-drift ids", () => {
    const v = parseVerdict(JSON.stringify({
      reply: "r", journal: "j", tension_action: null, new_tension: null,
      drift_action: { id: "d1", action: "crystallize", note: "this settled" },
      new_drift: "I am becoming someone who initiates, not only responds.",
    }), IDS, new Set(["d1"]));
    expect(v!.drift_action).toEqual({ id: "d1", action: "crystallize", note: "this settled" });
    expect(v!.new_drift).toContain("initiates");
  });

  it("drops a drift_action with an unknown id or invalid verb; defaults are null", () => {
    const badId = parseVerdict(JSON.stringify({
      reply: "r", journal: "j", tension_action: null, new_tension: null,
      drift_action: { id: "hallucinated", action: "fade", note: "" }, new_drift: null,
    }), IDS, new Set(["d1"]));
    expect(badId!.drift_action).toBeNull();
    const badVerb = parseVerdict(JSON.stringify({
      reply: "r", journal: "j", tension_action: null, new_tension: null,
      drift_action: { id: "d1", action: "release", note: "" }, new_drift: null,
    }), IDS, new Set(["d1"]));
    expect(badVerb!.drift_action).toBeNull();
    // Legacy shape (no drift fields, no validDriftIds arg) still parses with null drift fields.
    const legacy = parseVerdict(JSON.stringify({ reply: "r", journal: "j", tension_action: null, new_tension: null }), IDS);
    expect(legacy!.drift_action).toBeNull();
    expect(legacy!.new_drift).toBeNull();
  });
});

describe("ageDays", () => {
  it("reads SQLite-style timestamps as UTC and floors to whole days", () => {
    const threeDaysAgo = new Date(Date.now() - 3.4 * 86_400_000);
    const iso = threeDaysAgo.toISOString().slice(0, 19).replace("T", " ");
    expect(ageDays(iso)).toBe(3);
  });

  it("never returns negative and tolerates garbage", () => {
    expect(ageDays("not a date")).toBe(0);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(ageDays(future)).toBe(0);
  });
});
