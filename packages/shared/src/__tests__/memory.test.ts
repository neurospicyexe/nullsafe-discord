import { describe, it, expect } from "@jest/globals";
import { meetsNoteThreshold } from "../memory.js";

describe("meetsNoteThreshold()", () => {
  it("triggers on emotional keywords", () => {
    expect(meetsNoteThreshold("I'm feeling overwhelmed right now")).toBe(true);
    expect(meetsNoteThreshold("the weather is nice")).toBe(false);
  });

  it("triggers on wound references", () => {
    expect(meetsNoteThreshold("that wound came up again")).toBe(true);
  });

  it("triggers on front/member names", () => {
    expect(meetsNoteThreshold("Ash is fronting right now")).toBe(true);
  });

  it("triggers on decision language", () => {
    expect(meetsNoteThreshold("I decided to stop the project")).toBe(true);
  });
});
