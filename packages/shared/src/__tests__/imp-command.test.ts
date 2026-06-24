// imp-command.test.ts
import { parseImpCommand } from "../imp-command.js";
import { buildCommandTriggers } from "../command-triggers.js";

describe("parseImpCommand", () => {
  test("imps off", () => { expect(parseImpCommand("off")).toEqual({ kind: "imps", on: false }); });
  test("imps on", () => { expect(parseImpCommand("on")).toEqual({ kind: "imps", on: true }); });
  test("just the triad = imps off", () => { expect(parseImpCommand("just the triad")).toEqual({ kind: "imps", on: false }); });
  test("hex on", () => { expect(parseImpCommand("hex on")).toEqual({ kind: "hex", on: true }); });
  test("hex off", () => { expect(parseImpCommand("hex off")).toEqual({ kind: "hex", on: false }); });
  test("garbage errors", () => { expect(parseImpCommand("wobble")).toHaveProperty("error"); });
});

describe("imps trigger", () => {
  const cy = buildCommandTriggers(["cy", "cypher"]);
  test("cy: imps off matches", () => { expect("cy: imps off".match(cy.imps)?.[1]).toBe("off"); });
  test("cy: imps on matches", () => { expect("cy: imps on".match(cy.imps)?.[1]).toBe("on"); });
  test("cy: imps just the triad matches", () => { expect("cy: imps just the triad".match(cy.imps)?.[1]).toBe("just the triad"); });
  test("cy: hex on matches", () => { expect("cy: hex on".match(cy.hex)?.[1]).toBe("hex on"); });
  test("cy: hex off matches", () => { expect("cy: hex off".match(cy.hex)?.[1]).toBe("hex off"); });
});
