import { describe, it, expect } from "vitest";
import { parsePatternMaterials, orderPatterns } from "../halseth-client.js";

describe("parsePatternMaterials (R18)", () => {
  it("reads Halseth's [{name, first_seen}] shape", () => {
    expect(parsePatternMaterials(JSON.stringify([{ name: "alula", first_seen: "x" }, { name: "the dime", first_seen: "y" }]))).toEqual(["alula", "the dime"]);
  });
  it("tolerates bare strings, junk and nothing", () => {
    expect(parsePatternMaterials(JSON.stringify(["alula", 3, null, { name: "" }, { nope: 1 }]))).toEqual(["alula"]);
    expect(parsePatternMaterials("not json")).toEqual([]);
    expect(parsePatternMaterials(null)).toEqual([]);
    expect(parsePatternMaterials(undefined)).toEqual([]);
  });
});

describe("orderPatterns (R18)", () => {
  const rows = [
    { id: "strong-old", strength: 8, updated_at: "2026-09-01 10:00:00" },
    { id: "strong-older", strength: 7, updated_at: "2026-08-01 10:00:00" },
    { id: "weak-recent", strength: 5, updated_at: "2026-10-22 10:16:23" },
  ];
  it("recent puts a low-strength, just-touched pattern first (the one about to be restated)", () => {
    expect(orderPatterns(rows, "recent").map(r => r.id)).toEqual(["weak-recent", "strong-old", "strong-older"]);
    expect(orderPatterns(rows, "recent").slice(0, 1)[0]!.id).toBe("weak-recent");
  });
  it("strength keeps the server's order and does not mutate the input", () => {
    const copy = [...rows];
    expect(orderPatterns(rows, "strength").map(r => r.id)).toEqual(["strong-old", "strong-older", "weak-recent"]);
    expect(rows).toEqual(copy);
  });
});
