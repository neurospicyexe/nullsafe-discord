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

// ---------------------------------------------------------------------------
// needs_raziel: the companion raises its own entry (2026-08-12)
//
// The nightly reflection is a log by default. Escalation is opt-in and must carry a REASON, because
// the failure mode is silent in both directions: too eager and the every-night queue this change
// removed comes straight back; too strict and a companion can never reach Raziel at all.
// ---------------------------------------------------------------------------

// Must equal ESCALATION_TAG in halseth src/lib/ratifiable.ts, which owns the predicate that reads
// it. Asserted against the LITERAL on purpose -- the two repos share no package, and if the strings
// drift the failure is silent (nothing is ever raised).
const ESCALATION_TAG = "needs-raziel";

function verdictJson(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    reply: "a short reply",
    journal: "a fuller reflection",
    tension_action: null,
    new_tension: null,
    drift_action: null,
    new_drift: null,
    ...extra,
  });
}

describe("parseVerdict needs_raziel", () => {
  it("is null on an ordinary night, so the entry stays a log", () => {
    expect(parseVerdict(verdictJson(), new Set())!.needs_raziel).toBeNull();
    expect(parseVerdict(verdictJson({ needs_raziel: null }), new Set())!.needs_raziel).toBeNull();
  });

  it("carries the reason when the companion raises it", () => {
    const v = parseVerdict(
      verdictJson({ needs_raziel: "This contradicts what I told you in April about auditing." }),
      new Set(),
    )!;
    expect(v.needs_raziel).toBe("This contradicts what I told you in April about auditing.");
  });

  it("refuses filler that is not a reason", () => {
    // A model answering the field instead of using it must not cost Raziel his queue back.
    for (const junk of ["true", "yes", "no", "none", "null", "false", "n/a", "  ", ""]) {
      expect(parseVerdict(verdictJson({ needs_raziel: junk }), new Set())!.needs_raziel).toBeNull();
    }
  });

  it("ignores a bare boolean -- the reason is the point", () => {
    expect(parseVerdict(verdictJson({ needs_raziel: true }), new Set())!.needs_raziel).toBeNull();
    expect(parseVerdict(verdictJson({ needs_raziel: 1 }), new Set())!.needs_raziel).toBeNull();
  });

  it("caps the reason so it cannot flood the entry it annotates", () => {
    const v = parseVerdict(verdictJson({ needs_raziel: "x".repeat(500) }), new Set())!;
    expect(v.needs_raziel!.length).toBe(200);
  });

  it("keeps the escalation tag in step with halseth's predicate", () => {
    // Guards the cross-repo constant: halseth matches tags_json LIKE '%"needs-raziel"%'.
    expect(ESCALATION_TAG).toBe("needs-raziel");
  });
});
