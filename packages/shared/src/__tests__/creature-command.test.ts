import { parsePetCommand, formatPetReply, resolveCreature } from "../creature-command.js";
import { buildCommandTriggers } from "../command-triggers.js";

describe("parsePetCommand", () => {
  test("parses name + action + note", () => {
    const r = parsePetCommand("Sol feed a shiny bottlecap");
    expect(r).toEqual({ name: "Sol", action: "feed", note: "a shiny bottlecap" });
  });
  test("handles multi-word names (action keyword splits)", () => {
    const r = parsePetCommand("Mr Whiskers play");
    expect(r).toEqual({ name: "Mr Whiskers", action: "play", note: null });
  });
  test("rejects a missing action", () => {
    expect(parsePetCommand("Sol")).toHaveProperty("error");
    expect(parsePetCommand("Sol cuddle")).toHaveProperty("error");
  });
  test("rejects an action with no name before it", () => {
    expect(parsePetCommand("feed")).toHaveProperty("error");
  });
});

describe("formatPetReply", () => {
  test("literal ack carries trust", () => {
    expect(formatPetReply("Sol", "feed", 0.14)).toBe("feed Sol (trust 0.14)");
  });
  test("give reads naturally", () => {
    expect(formatPetReply("Sol", "give", 0.2)).toBe("gave something to Sol (trust 0.20)");
  });
  test("omits trust when unknown", () => {
    expect(formatPetReply("Sol", "talk", null)).toBe("talk Sol");
  });
});

describe("resolveCreature", () => {
  const creatures = [
    { id: "1", name: "Sol", species: "corvid", trust: 0.1 },
    { id: "2", name: "Luna", species: "cat", trust: 0.5 },
    { id: "3", name: "Sunny", species: "dog", trust: 0.3 },
  ];
  test("exact match wins (case-insensitive)", () => {
    const r = resolveCreature(creatures, "sol");
    expect("creature" in r && r.creature.id).toBe("1");
  });
  test("unique substring resolves", () => {
    const r = resolveCreature(creatures, "lun");
    expect("creature" in r && r.creature.id).toBe("2");
  });
  test("no match errors with known names", () => {
    const r = resolveCreature(creatures, "Rex");
    expect("error" in r && r.error).toMatch(/no creature named/);
  });
});

describe("pet command trigger (command-triggers)", () => {
  const cy = buildCommandTriggers(["cy", "cypher"]);
  const drev = buildCommandTriggers(["drevan", "drev", "dre"]);
  test("cy: pet Sol feed matches with arg", () => {
    expect("cy: pet Sol feed".match(cy.pet)?.[1]).toBe("Sol feed");
  });
  test("dre pet Sol play (loose separator)", () => {
    expect("dre pet Sol play".match(drev.pet)?.[1]).toBe("Sol play");
  });
  test("bare pet misses the trigger but hits the guard", () => {
    expect("cy: pet".match(cy.pet)).toBeNull();
    expect(cy.guard.test("cy: pet")).toBe(true);
  });
});
