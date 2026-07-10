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
  test("bare name defaults to a gentle action (the natural 'pet Sol')", () => {
    expect(parsePetCommand("Sol")).toEqual({ name: "Sol", action: "play", note: null });
  });
  test("rejects a botched action after the name", () => {
    // multi-word with no valid action -> steer to real verbs, don't treat as a name
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

// ── Inner life (0100): nest view + milestone acks ─────────────────────────────
import { formatNestReply } from "../creature-command.js";

describe("parsePetCommand nest view", () => {
  test("pet Sol nest -> read-only view", () => {
    expect(parsePetCommand("Sol nest")).toEqual({ name: "Sol", view: "nest" });
  });
  test("multi-word names still work before the keyword", () => {
    expect(parsePetCommand("Mr Whiskers nest")).toEqual({ name: "Mr Whiskers", view: "nest" });
  });
  test("bare 'nest' with no name errors", () => {
    expect(parsePetCommand("nest")).toHaveProperty("error");
  });
});

describe("formatPetReply milestones", () => {
  test("appends fired milestone text verbatim", () => {
    const s = formatPetReply("Sol", "give", 0.81, [{ id: "shoulder_perch", text: "*Sol lands on your shoulder. His claws are careful. He stays.*" }]);
    expect(s).toContain("gave something to Sol (trust 0.81)");
    expect(s).toContain("shoulder");
  });
  test("no milestones -> unchanged ack", () => {
    expect(formatPetReply("Sol", "talk", 0.5)).toBe("talk Sol (trust 0.50)");
  });
});

describe("formatNestReply", () => {
  test("treasured stars, gift attribution, given-away lines", () => {
    const s = formatNestReply(
      "Sol",
      [
        { content: "moss and flame", treasured: 1, given_by: "drevan", source: "gift" },
        { content: "quixotic", treasured: 0, given_by: null, source: "overheard:house" },
      ],
      [{ content: "a smooth stone", gifted_to: "raziel" }],
    );
    expect(s).toContain("★ moss and flame (from drevan)");
    expect(s).toContain("• quixotic");
    expect(s).toContain('gave "a smooth stone" to raziel');
  });
  test("empty nest explains how it fills", () => {
    expect(formatNestReply("Sol", [], [])).toContain("nest is empty");
  });
});
