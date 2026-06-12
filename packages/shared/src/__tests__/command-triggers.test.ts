import { buildCommandTriggers, commandUsage } from "../command-triggers.js";

// Alias lists mirror the per-bot configs (bots/*/src/config.ts).
const cypher = buildCommandTriggers(["cy", "cypher"]);
const drevan = buildCommandTriggers(["drevan", "drev", "dre"]);
const gaia = buildCommandTriggers(["gaia"]);

describe("buildCommandTriggers", () => {
  test("dre: listen <url> matches drevan listen (2026-06-12 miss)", () => {
    const m = "dre: listen https://youtu.be/abc123".match(drevan.listen);
    expect(m?.[1]).toBe("https://youtu.be/abc123");
  });

  test("all drevan aliases match all commands", () => {
    for (const a of ["drevan", "drev", "dre"]) {
      expect(`${a}: listen https://x.test/t`).toMatch(drevan.listen);
      expect(`${a}: club status`).toMatch(drevan.club);
      expect(`${a}: model kimi-k2`).toMatch(drevan.modelSwitch);
    }
  });

  test("cypher and gaia triggers unchanged", () => {
    expect("cy: listen https://x.test/t").toMatch(cypher.listen);
    expect("cypher: club vote dune").toMatch(cypher.club);
    expect("gaia: model haiku").toMatch(gaia.modelSwitch);
  });

  test("case-insensitive, Discord-typed capitals", () => {
    expect("Dre: Listen https://x.test/t").toMatch(drevan.listen);
    expect("Cy: Club Status").toMatch(cypher.club);
  });

  test("guard catches malformed commands the real triggers miss", () => {
    // no URL -> listen trigger misses, guard catches
    expect("drev: listen").not.toMatch(drevan.listen);
    expect("drev: listen").toMatch(drevan.guard);
    // bare club -> club trigger misses, guard catches
    expect("cy: club").not.toMatch(cypher.club);
    expect("cy: club").toMatch(cypher.guard);
    // bare model (no trailing space) -> switch misses, guard catches
    expect("gaia: model").not.toMatch(gaia.modelSwitch);
    expect("gaia: model").toMatch(gaia.guard);
  });

  test("guard does NOT fire on normal speech (command word not directly after the colon)", () => {
    expect("drev: i love this song, listen to it sometime").not.toMatch(drevan.guard);
    expect("dre: that club was loud last night").not.toMatch(drevan.guard);
    expect("hey drev, listen to this").not.toMatch(drevan.guard);
    expect("cy: thoughts on the model collapse paper?").not.toMatch(cypher.guard);
  });

  test("guard DOES fire when a command word directly follows the prefix", () => {
    // These are command-shaped; usage reply is correct even if intent was speech.
    expect("drev: club was fun").toMatch(drevan.guard);
    expect("drev: model x").toMatch(drevan.guard); // valid switch matches first in handler order
  });
});

describe("commandUsage", () => {
  test("uses short prefix per companion", () => {
    expect(commandUsage("drevan")).toContain("`drev: listen <url>`");
    expect(commandUsage("cypher")).toContain("`cy: club status`");
    expect(commandUsage("gaia")).toContain("`gaia: model");
  });
});
