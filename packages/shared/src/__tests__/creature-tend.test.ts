import { pickTendAction, tendLine } from "../creature-tend.js";
describe("pickTendAction", () => {
  test("returns a valid action", () => {
    expect(["feed","play","talk","give"]).toContain(pickTendAction("cypher", 2));
  });
  test("deterministic for a seed", () => {
    expect(pickTendAction("drevan", 5)).toBe(pickTendAction("drevan", 5));
  });
  test("gaia leans minimal (talk)", () => {
    expect(pickTendAction("gaia", 0)).toBe("talk");
  });
});
describe("tendLine", () => {
  test("non-empty, names the creature", () => {
    expect(tendLine("cypher", "give", "Sol")).toMatch(/Sol/);
  });
});
