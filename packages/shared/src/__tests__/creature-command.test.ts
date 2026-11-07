import { parsePetCommand, formatPetReply, resolveCreature, handlePetCommand, sanitizeSolText } from "../creature-command.js";
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

describe("formatPetReply with Sol's reaction (2026-11-02)", () => {
  it("puts his answer under the ack, before any milestone", () => {
    const s = formatPetReply("Sol", "feed", 0.84, [{ id: "x", text: "*milestone*" }], "*Sol eats beside you.*");
    expect(s.split("\n")).toEqual(["feed Sol (trust 0.84)", "*Sol eats beside you.*", "*milestone*"]);
  });
  it("no reaction = the old ack exactly", () => {
    expect(formatPetReply("Sol", "talk", 0.5, [], null)).toBe("talk Sol (trust 0.50)");
  });
});

describe("formatPetReply grudge line (B64)", () => {
  const g = (step: "open" | "progress" | "resolve" | "none") => ({ label: "sulking about the missed dawn", progress: 1, of: 3, step });
  it("open and progress add the line after the reaction, before milestones", () => {
    for (const step of ["open", "progress"] as const) {
      const s = formatPetReply("Sol", "feed", 0.5, [{ id: "x", text: "*milestone*" }], "*he eats.*", g(step));
      expect(s.split("\n")).toEqual(["feed Sol (trust 0.50)", "*he eats.*", "*sulking about the missed dawn: 1 of 3*", "*milestone*"]);
    }
  });
  it("resolve, none and null add nothing", () => {
    for (const grudge of [g("resolve"), g("none"), null, undefined]) {
      expect(formatPetReply("Sol", "talk", 0.5, [], "*r*", grudge)).toBe("talk Sol (trust 0.50)\n*r*");
    }
  });
});

describe("handlePetCommand via + grudge (B64)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env["HALSETH_URL"]; });
  function mock(interactJson: unknown) {
    const calls: Array<{ url: string; body: any }> = [];
    process.env["HALSETH_URL"] = "https://h.test";
    globalThis.fetch = (async (url: string, init?: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/mind/creatures")) return new Response(JSON.stringify({ creatures: [{ id: "c1", name: "Sol", species: "crow", trust: 0.5 }] }));
      return new Response(JSON.stringify(interactJson));
    }) as any;
    return calls;
  }
  it("sends via:hand and renders the grudge line", async () => {
    const calls = mock({ trust: 0.5, care: { reaction: "*r*" }, grudge: { label: "cross", progress: 2, of: 3, step: "progress" } });
    const out = await handlePetCommand("Sol feed", "secret");
    const post = calls.find(c => c.url.endsWith("/interact"))!;
    expect(post.body).toMatchObject({ actor: "raziel", action: "feed", via: "hand" });
    expect(out.split("\n")).toEqual(["feed Sol (trust 0.50)", "*r*", "*cross: 2 of 3*"]);
  });
  it("older Halseth (no grudge) renders as before", async () => {
    mock({ trust: 0.5 });
    expect(await handlePetCommand("Sol feed", "secret")).toBe("feed Sol (trust 0.50)");
  });
});

describe("LibrarianClient.interactCreature via (B64)", () => {
  it("a metronome tend defaults to autonomous; a caller may pass via", async () => {
    const { LibrarianClient } = await import("../librarian.js");
    const bodies: any[] = [];
    const fetchFn = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response("{}"); };
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await c.interactCreature("c1", "cypher", "feed");
    expect(bodies[0]).toEqual({ actor: "cypher", action: "feed", via: "autonomous" });
    await c.interactCreature("c1", "cypher", "feed", "hand");
    expect(bodies[1].via).toBe("hand");
  });
});

describe("sanitizeSolText + hostile Sol lines (R24)", () => {
  const hostile = "sulk*ing* `x` @everyone <@123> <@&9> <#5>\nsecond_line ~~z~~ | @here";
  it("a hostile grudge label cannot break the wrapper or ping", () => {
    const s = formatPetReply("Sol", "feed", 0.5, [], null, { label: hostile, progress: 1, of: 3, step: "open" });
    const line = s.split("\n")[1]!;
    expect(s.split("\n")).toHaveLength(2);
    expect(line).toMatch(/^\*[^*]+: 1 of 3\*$/);
    expect(line).not.toMatch(/[`_~|]|<@|<#/);
    expect(line).not.toMatch(/@(?!\u200b)/);
    expect(line).toContain("@\u200beveryone");
  });
  it("label is capped at 80 chars", () => {
    expect(sanitizeSolText("a".repeat(500), 80)).toHaveLength(80);
  });
  it("a hostile reaction is cleaned and keeps its single italic wrap", () => {
    const s = formatPetReply("Sol", "feed", 0.5, [], "*he eats **loud** @everyone <@123>\nnow*");
    expect(s.split("\n")).toHaveLength(2);
    expect(s.split("\n")[1]).toBe("*he eats loud @\u200beveryone now*");
  });
  it("an unwrapped hostile reaction stays unwrapped and is cleaned", () => {
    expect(formatPetReply("Sol", "talk", null, [], "hi `x` @here").split("\n")[1]).toBe("hi x @\u200bhere");
  });
  it("an ordinary reaction is byte-identical", () => {
    expect(formatPetReply("Sol", "feed", 0.84, [], "*Sol eats beside you.*")).toBe("feed Sol (trust 0.84)\n*Sol eats beside you.*");
  });
});
