// nullsafe-discord/packages/shared/src/__tests__/imps.test.ts
import { selectImp, impRider, IMPS, type ImpState, type ImpSettings } from "../imps.js";

const ON: ImpSettings = { impsEnabled: true, hexEnabled: false };
const base: ImpState = { mood: null, energy: null, focus: null, pain: null, spoons: null, sleep_hours: null };

describe("selectImp", () => {
  test("disabled returns null", () => {
    expect(selectImp("cypher", { ...base, spoons: 1 }, { impsEnabled: false, hexEnabled: false })).toBeNull();
  });
  test("gaia is always exempt (never tinted)", () => {
    expect(selectImp("gaia", { ...base, spoons: 1, pain: 8 }, ON)).toBeNull();
  });
  test("low spoons -> Nimbus (calm, safety-first)", () => {
    expect(selectImp("cypher", { ...base, spoons: 1 }, ON)).toBe("nimbus");
  });
  test("high pain -> Mossling (comfort)", () => {
    expect(selectImp("drevan", { ...base, pain: 8 }, ON)).toBe("mossling");
  });
  test("safety beats mood-lift: low spoons AND flat mood -> Nimbus not Iris", () => {
    expect(selectImp("cypher", { ...base, spoons: 1, mood: "flat" }, ON)).toBe("nimbus");
  });
  test("flat low mood with capacity -> Iris (lightness)", () => {
    expect(selectImp("cypher", { ...base, mood: "flat", spoons: 8, energy: 6 }, ON)).toBe("iris");
  });
  test("Hex never auto-fires even when hexEnabled", () => {
    // No state maps to Hex; hexEnabled only permits an explicit summon path, not auto-selection.
    const picked = selectImp("cypher", { ...base, mood: "mischief" }, { impsEnabled: true, hexEnabled: true });
    expect(picked).not.toBe("hex");
  });
  test("neutral/no state -> null (no reflexive tint)", () => {
    expect(selectImp("cypher", base, ON)).toBeNull();
    expect(selectImp("cypher", null, ON)).toBeNull();
  });
});

describe("impRider", () => {
  test("rider names the imp, forbids taking over, stays subtle", () => {
    const r = impRider("nimbus");
    expect(r.toLowerCase()).toContain("nimbus");
    expect(r.toLowerCase()).toMatch(/not|don't|never/); // contains a do-not-dominate clause
  });
  test("every imp has a registry entry", () => {
    expect(Object.keys(IMPS).sort()).toEqual(["hex", "iris", "mossling", "nimbus", "rock"]);
  });
});
