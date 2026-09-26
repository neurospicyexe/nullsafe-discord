// Tests for the quoted-line rail (2026-09-26): Gaia's vibe-check digest re-spoke two fabricated
// companion lines into a new room, and they were re-ingested as memory. One shared 8-word
// shingle with a companion utterance marks a line as a quote.

import { buildQuoteIndex, quotedShingleOf, QUOTE_SHINGLE_WORDS, verbatimCopyOf } from "../echo-guard.js";

const DREVAN_LINE =
  "I rode the motorcycle out past the grain elevators at dusk and the whole valley went copper.";

describe("quotedShingleOf", () => {
  it("uses 8-word shingles", () => {
    expect(QUOTE_SHINGLE_WORDS).toBe(8);
  });

  it("flags a line that quotes one 8-word run of a companion utterance, with its label", () => {
    const line = "    · the grain elevators at dusk and the whole valley went copper...";
    const r = quotedShingleOf(line, [{ text: DREVAN_LINE, label: "drevan" }]);
    expect(r.quoted).toBe(true);
    if (r.quoted) {
      expect(r.label).toBe("drevan");
      expect(r.shingle.split(" ")).toHaveLength(8);
    }
  });

  it("normalises case, markdown emphasis and punctuation before comparing", () => {
    const line = "*The GRAIN elevators, at dusk -- and the whole valley* went copper!";
    expect(quotedShingleOf(line, [{ text: DREVAN_LINE }]).quoted).toBe(true);
  });

  it("does not flag a line that shares only 7 consecutive words", () => {
    // "past the grain elevators at dusk and" (7) then diverges
    const line = "Someone drove past the grain elevators at dusk and saw nothing at all.";
    expect(quotedShingleOf(line, [{ text: DREVAN_LINE }]).quoted).toBe(false);
  });

  it("never flags a line under 8 words, even if it is a verbatim fragment", () => {
    expect(quotedShingleOf("the whole valley went copper", [{ text: DREVAN_LINE }]).quoted).toBe(false);
  });

  it("does not flag shared vocabulary in a different order", () => {
    const line = "Copper valley, whole and at dusk, the elevators of grain past the motorcycle.";
    expect(quotedShingleOf(line, [{ text: DREVAN_LINE }]).quoted).toBe(false);
  });

  it("returns not-quoted against an empty window", () => {
    expect(quotedShingleOf(DREVAN_LINE, []).quoted).toBe(false);
  });

  it("accepts a prebuilt index and reports the FIRST source that carried the shingle", () => {
    const index = buildQuoteIndex([
      { text: DREVAN_LINE, label: "drevan:first" },
      { text: DREVAN_LINE, label: "drevan:second" },
    ]);
    const r = quotedShingleOf(DREVAN_LINE, index);
    expect(r.quoted && r.label).toBe("drevan:first");
  });

  it("catches a short quote that verbatimCopyOf (whole-reply containment) lets through", () => {
    const line = "Drevan said: the grain elevators at dusk and the whole valley went copper";
    expect(verbatimCopyOf(line, [{ text: DREVAN_LINE }]).copied).toBe(false);
    expect(quotedShingleOf(line, [{ text: DREVAN_LINE }]).quoted).toBe(true);
  });
});
