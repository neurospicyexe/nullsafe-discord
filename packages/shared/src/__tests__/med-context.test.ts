// P-2 (no answer is never "not taken") and P-1 (no dosing advice) in the rendered DM context.
// Fake labels and fake times only: real medication names and dose times never enter a tracked file.

import { describe, it, expect } from "@jest/globals";
import { renderMedStateBlock, MED_DOSING_RULE, MED_NO_RAISE_RULE, type MedStateDose } from "../med-context.js";

const dose = (over: Partial<MedStateDose>): MedStateDose => ({
  slot_key: "night", label: "med-b", local_time: "21:40", local_date: "2026-09-28", day: "today",
  answered_local: null, answered_to: null, ...over,
});

/** Phrasings that would read silence as information. None may ever appear. */
const NOT_TAKEN = [/not taken/i, /didn'?t take/i, /did not take/i, /\bmissed\b/i, /\bskipped\b/i, /\bforgot\b/i];

function assertNeverNotTaken(block: string): void {
  // The only place these words may appear is inside the rule that forbids them.
  const outsideRule = block.replace(/"No answer" means only[^\n]*/g, "").split(MED_DOSING_RULE).join("");
  for (const re of NOT_TAKEN) expect(outsideRule).not.toMatch(re);
}

describe("renderMedStateBlock", () => {
  it("a dose with no answer says there is no answer, never that it was not taken", () => {
    const b = renderMedStateBlock([dose({})], "drevan");
    expect(b).toContain("• med-b (today's 21:40): you have no answer from him for this one.");
    assertNeverNotTaken(b);
  });

  it("an answered dose says who he told and when, in local time", () => {
    const b = renderMedStateBlock([
      dose({ answered_local: "21:51", answered_to: "drevan" }),
      dose({ slot_key: "morning", label: "med-a", local_time: "07:10", answered_local: "07:22", answered_to: "cypher" }),
    ], "drevan");
    expect(b).toContain("• med-b (today's 21:40): he told you he took it at 21:51.");
    expect(b).toContain("• med-a (today's 07:10): he told Cypher he took it at 07:22.");
    assertNeverNotTaken(b);
  });

  it("yesterday's night dose is labelled as yesterday's", () => {
    const b = renderMedStateBlock([dose({ day: "yesterday", local_date: "2026-09-27" })], "cypher");
    expect(b).toContain("• med-b (yesterday's 21:40): you have no answer from him for this one.");
  });

  it("states the absence rule and the dosing rule whenever doses are listed", () => {
    const b = renderMedStateBlock([dose({})], "drevan");
    expect(b).toContain("It NEVER means he did not take it");
    expect(b).toContain(MED_DOSING_RULE);
    expect(MED_DOSING_RULE).toMatch(/catch-up/);
    expect(MED_DOSING_RULE).toMatch(/doubled/);
    expect(MED_DOSING_RULE).toMatch(/skipped/);
    expect(MED_DOSING_RULE).toMatch(/prescriber or pharmacist/);
  });

  it("unreadable state says so, carries the dosing rule, and never guesses", () => {
    const b = renderMedStateBlock(null, "drevan");
    expect(b).toContain("cannot see today's med state");
    expect(b).toContain("do not guess either way");
    expect(b).toContain(MED_DOSING_RULE);
    assertNeverNotTaken(b);
  });

  it("nothing due yet still carries the dosing rule", () => {
    const b = renderMedStateBlock([], "drevan");
    expect(b).toContain("No doses have come due yet today.");
    expect(b).toContain(MED_DOSING_RULE);
  });

  it("tells the companion never to raise a dose he has not asked about (no third ask), in every shape", () => {
    for (const b of [renderMedStateBlock([dose({})], "gaia"), renderMedStateBlock([], "drevan"), renderMedStateBlock(null, "cypher")]) {
      expect(b).toContain(MED_NO_RAISE_RULE);
    }
    expect(MED_NO_RAISE_RULE).toContain("Do not bring up a dose he has not asked about");
  });

  it("marks itself private to the DM", () => {
    expect(renderMedStateBlock([dose({})], "drevan")).toContain("private to this DM, never to be mentioned in any server channel");
  });
});
