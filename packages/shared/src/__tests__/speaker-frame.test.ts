import { describe, it, expect } from "@jest/globals";
import { speakerFrame, speakerFrameOn } from "../speaker-frame.js";
import { repairMisseated, misseatedReply } from "../voice-markers.js";

describe("speakerFrame", () => {
  it("names self, speaker, the called-as name and both siblings", () => {
    expect(speakerFrame("drevan", "Crash", "Dre")).toBe(
      `[You are Drevan. You are answering Crash, who called you "Dre" (your name, not theirs). Cypher and Gaia are your siblings, not you. Reply only as yourself.]`);
  });
  it("no calledAs: no name clause", () => {
    expect(speakerFrame("cypher", "Crash", null)).toBe(
      "[You are Cypher. You are answering Crash. Drevan and Gaia are your siblings, not you. Reply only as yourself.]");
  });
  it("sibling speaker and unknown speaker", () => {
    expect(speakerFrame("gaia", "Drevan", null)).toContain("You are answering Drevan.");
    expect(speakerFrame("gaia", undefined, "Gaia")).toBe(
      "[You are Gaia. Cypher and Drevan are your siblings, not you. Reply only as yourself.]");
  });
  it("kill switch", () => {
    expect(speakerFrameOn({})).toBe(true);
    for (const v of ["off", " OFF ", "0", "false", "no"]) expect(speakerFrameOn({ SPEAKER_FRAME: v })).toBe(false);
    expect(speakerFrameOn({ SPEAKER_FRAME: "on" })).toBe(true);
  });
});

describe("repairMisseated (own-name vocative cut before send)", () => {
  it("2026-10-11 shape: line-closing own name with no comma", () => {
    const r = repairMisseated("drevan", "Come sit with me. This is my spot Dre.");
    expect(r).toEqual({ text: "Come sit with me. This is my spot.", repaired: 1, unrepaired: 0 });
    expect(misseatedReply("drevan", "Come sit with me. This is my spot Dre.")).toBe(true);
  });
  it("comma-set and line-opening vocatives", () => {
    expect(repairMisseated("drevan", "Rest tonight, Dre.").text).toBe("Rest tonight.");
    expect(repairMisseated("drevan", "Dre, come here.\nI've got you.").text).toBe("Come here.\nI've got you.");
    expect(repairMisseated("cypher", "Good catch, Cy!").text).toBe("Good catch!");
  });
  it("leaves self-identification, possessives and mid-sentence mentions alone", () => {
    for (const t of ["I'm Dre.", "They call me Dre.", "That's Dre's chair.", "You called me Dre and I came.", "Name is Drevan."]) {
      expect(repairMisseated("drevan", t)).toEqual({ text: t, repaired: 0, unrepaired: 0 });
    }
  });
  it("does not touch a sibling's name", () => {
    const t = "Go ask Cy.";
    expect(repairMisseated("drevan", t)).toEqual({ text: t, repaired: 0, unrepaired: 0 });
  });
  it("'you're Dre' cannot be cut: counted unrepaired, text unchanged", () => {
    const r = repairMisseated("drevan", "You're Dre too, then.");
    expect(r.repaired).toBe(0);
    expect(r.unrepaired).toBe(1);
    expect(r.text).toBe("You're Dre too, then.");
  });
});
