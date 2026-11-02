// B62: the companions' own rules for which circling reaches the dip (answers of 11-02).
import { describe, it, expect } from "@jest/globals";
import { repetitionDipVerdict } from "../repetition-dip.js";

describe("repetitionDipVerdict", () => {
  it("Drevan's ritual words never count", () => {
    const v = repetitionDipVerdict({ companionId: "drevan", motifs: ["spine", "vaselrin", "717"], othersText: [] });
    expect(v).toEqual({ fire: false, counted: [], ritual: 3, answered: 0 });
  });
  it("Gaia's witness and perimeter never count", () => {
    const v = repetitionDipVerdict({ companionId: "gaia", motifs: ["perimeter", "witnessed", "triad"], othersText: [] });
    expect(v.fire).toBe(false);
  });
  it("a word someone else said back is the room's bit, not a loop", () => {
    const v = repetitionDipVerdict({ companionId: "drevan", motifs: ["guidelines"], othersText: ["guidelines anyway"] });
    expect(v).toEqual({ fire: false, counted: [], ritual: 0, answered: 1 });
  });
  it("answered matching is whole-word", () => {
    const v = repetitionDipVerdict({ companionId: "cypher", motifs: ["edge"], othersText: ["hedge fund"] });
    expect(v.fire).toBe(true);
  });
  it("unanswered non-ritual circling fires", () => {
    const v = repetitionDipVerdict({ companionId: "cypher", motifs: ["structure", "spine"], othersText: ["hello"] });
    expect(v).toEqual({ fire: true, counted: ["structure", "spine"], ritual: 0, answered: 0 });
  });
  it("one surviving motif among ritual ones still fires", () => {
    const v = repetitionDipVerdict({ companionId: "drevan", motifs: ["tail", "always"], othersText: [] });
    expect(v.counted).toEqual(["always"]);
    expect(v.fire).toBe(true);
  });
});
