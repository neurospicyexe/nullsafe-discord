import { extractJson, rawPreview } from "../json-extract.js";

// Canonical tolerant extractor (moved here from autonomous-worker/src/club.ts).
// Guards the crash class where a model asked for "ONLY valid JSON" answers with
// prose, fences the object, or gets truncated by max_tokens (2026-06-30/07-01
// consolidation crashes; daily "structured extract parse failed").

describe("extractJson — tolerant first-{...}-block extraction", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"title":"X"}')).toEqual({ title: "X" });
  });

  it("parses JSON embedded in prose", () => {
    expect(extractJson('I know you asked for JSON. Here: {"title":"X","summary":"y"} Hope that helps!'))
      .toEqual({ title: "X", summary: "y" });
  });

  it("parses JSON inside markdown fences", () => {
    expect(extractJson('Sure!\n```json\n{"title":"X"}\n```')).toEqual({ title: "X" });
  });

  it("parses nested objects (greedy match spans inner braces)", () => {
    expect(extractJson('note: {"soma":{"acuity":"sharp"},"emotion":"steady"}'))
      .toEqual({ soma: { acuity: "sharp" }, emotion: "steady" });
  });

  it("returns null for pure prose (no braces)", () => {
    expect(extractJson("I know you wanted a handoff but I want to say something first")).toBeNull();
  });

  it("returns null for truncated JSON (max_tokens cutoff, no closing brace)", () => {
    expect(extractJson('{"action":"write_note_to_raziel","reason":"the silence has')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });
});

describe("rawPreview — single-line log preview", () => {
  it("collapses whitespace and truncates", () => {
    expect(rawPreview("a\n\nb   c", 5)).toBe("a b c");
    expect(rawPreview("x".repeat(300)).length).toBe(120);
  });
});
