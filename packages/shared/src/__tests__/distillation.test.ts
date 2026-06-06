import { deriveStateHint, hasSomaValue } from "../distillation.js";

// These two helpers encode the SOMA-handling logic that was inlined identically in all three
// bots' onChannelInactive (bots/<name>/src/index.ts). The bots differ ONLY in their SOMA field
// names (Cypher acuity/presence/warmth, Drevan heat/reach/weight, Gaia stillness/density/perimeter),
// so the logic must stay generic over keys. Pinned here against drift.

describe("deriveStateHint — builds the handoff state_hint from a SOMA object", () => {
  it("returns undefined when soma is absent (matches `ext.soma ? ... : undefined`)", () => {
    expect(deriveStateHint(undefined)).toBeUndefined();
  });

  it("joins non-empty fields as 'key: value', preserving order, dropping falsy values", () => {
    expect(deriveStateHint({ acuity: "sharp", presence: "", warmth: "warm" })).toBe("acuity: sharp, warmth: warm");
  });

  it("is generic over field names (Drevan schema)", () => {
    expect(deriveStateHint({ heat: "steady", reach: "landed", weight: "light" })).toBe("heat: steady, reach: landed, weight: light");
  });

  it("returns empty string for an all-falsy soma (preserves original join behavior)", () => {
    expect(deriveStateHint({ stillness: "", density: "" })).toBe("");
  });
});

describe("hasSomaValue — gate for whether to queue a state update", () => {
  it("false when soma is absent", () => {
    expect(hasSomaValue(undefined)).toBe(false);
  });

  it("false when every field is falsy", () => {
    expect(hasSomaValue({ acuity: "", presence: "" })).toBe(false);
  });

  it("true when at least one field has a value", () => {
    expect(hasSomaValue({ acuity: "", presence: "steady" })).toBe(true);
  });
});
