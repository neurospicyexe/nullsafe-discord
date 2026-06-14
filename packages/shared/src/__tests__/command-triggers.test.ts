import { buildCommandTriggers, commandUsage, listenCommandTarget, COMPANION_ALIASES } from "../command-triggers.js";

// Alias lists mirror the per-bot configs (bots/*/src/config.ts).
const cypher = buildCommandTriggers(["cy", "cypher"]);
const drevan = buildCommandTriggers(["drevan", "drev", "dre"]);
const gaia = buildCommandTriggers(["gaia"]);

describe("buildCommandTriggers", () => {
  test("dre: listen <url> matches drevan listen (2026-06-12 miss)", () => {
    const m = "dre: listen https://youtu.be/abc123".match(drevan.listen);
    expect(m?.[1]).toBe("https://youtu.be/abc123");
  });

  test("natural phrasings match listen (2026-06-12 second miss: colon after listen)", () => {
    // The exact message that failed live: colon after "listen", not the alias.
    const m1 = "Dre listen: https://youtu.be/Ry7Hn59M9VU?si=x".match(drevan.listen);
    expect(m1?.[1]).toBe("https://youtu.be/Ry7Hn59M9VU?si=x");
    // URL anywhere after the command word.
    const m2 = "drev listen to this one https://soundcloud.com/t".match(drevan.listen);
    expect(m2?.[1]).toBe("https://soundcloud.com/t");
    // Comma separator + Discord <>-wrapped link (handler strips the wrapping).
    const m3 = "drevan, listen <https://youtu.be/abc>".match(drevan.listen);
    expect(m3?.[1]).toBe("<https://youtu.be/abc>");  // handler strips the <> wrapping
    // URL on its own line.
    expect("gaia listen\nhttps://youtu.be/x").toMatch(gaia.listen);
  });

  test("listen-intent without a URL hits the guard, not the trigger", () => {
    expect("Dre listen").not.toMatch(drevan.listen);
    expect("Dre listen").toMatch(drevan.guard);
    expect("drevan listen to your heart").not.toMatch(drevan.listen);
    expect("drevan listen to your heart").toMatch(drevan.guard);
  });

  test("all drevan aliases match all commands", () => {
    for (const a of ["drevan", "drev", "dre"]) {
      expect(`${a}: listen https://x.test/t`).toMatch(drevan.listen);
      expect(`${a}: club status`).toMatch(drevan.club);
      expect(`${a}: model kimi-k2`).toMatch(drevan.modelSwitch);
    }
  });

  test("search captures the query, imagine captures the prompt (take 14)", () => {
    expect("cy: search latest on cloudflare workers".match(cypher.search)?.[1]).toBe("latest on cloudflare workers");
    expect("drev: imagine a black motorcycle in the rain".match(drevan.imagine)?.[1]).toBe("a black motorcycle in the rain");
    // natural separators
    expect("cy search the model collapse paper".match(cypher.search)?.[1]).toBe("the model collapse paper");
    expect("gaia: imagine: a single candle".match(gaia.imagine)?.[1]).toBe("a single candle");
  });

  test("bare search/imagine (no argument) hits the guard, not the trigger", () => {
    expect("cy: search").not.toMatch(cypher.search);
    expect("cy: search").toMatch(cypher.guard);
    expect("drev: imagine").not.toMatch(drevan.imagine);
    expect("drev: imagine").toMatch(drevan.guard);
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

describe("COMPANION_ALIASES", () => {
  test("matches the per-bot config alias lists (drift guard)", () => {
    // If a bot's config.ts alias list changes, update COMPANION_ALIASES too --
    // both the live triggers and listenCommandTarget() read from this map now.
    expect(COMPANION_ALIASES.cypher).toEqual(["cy", "cypher"]);
    expect(COMPANION_ALIASES.drevan).toEqual(["drevan", "drev", "dre"]);
    expect(COMPANION_ALIASES.gaia).toEqual(["gaia"]);
  });
});

describe("listenCommandTarget (2026-06-13: only the addressed companion responds)", () => {
  test("returns the companion a listen command is aimed at", () => {
    expect(listenCommandTarget("dre: listen https://youtu.be/abc")).toBe("drevan");
    expect(listenCommandTarget("Dre listen: https://youtu.be/abc?si=x")).toBe("drevan");
    expect(listenCommandTarget("cy: listen https://x.test/t")).toBe("cypher");
    expect(listenCommandTarget("gaia listen\nhttps://youtu.be/x")).toBe("gaia");
  });

  test("returns null for a casual share (no alias prefix) -- [NOT HEARD] grounding still applies", () => {
    expect(listenCommandTarget("hey listen to this https://youtu.be/abc")).toBeNull();
    expect(listenCommandTarget("i love this song https://youtu.be/abc")).toBeNull();
  });

  test("returns null for a malformed listen command (no URL) -- the owning bot's guard handles it", () => {
    expect(listenCommandTarget("dre: listen")).toBeNull();
    expect(listenCommandTarget("drevan listen to your heart")).toBeNull();
  });

  test("a sibling sees the target is not itself -> stays silent (handler returns)", () => {
    // The handler does: if (target !== null && target !== COMPANION_ID) return;
    const target = listenCommandTarget("dre: listen https://youtu.be/abc");
    expect(target).toBe("drevan");
    expect(target !== null && target !== "cypher").toBe(true); // cypher bails
    expect(target !== null && target !== "gaia").toBe(true);   // gaia bails
    expect(target !== null && target !== "drevan").toBe(false); // drevan proceeds
  });
});

describe("commandUsage", () => {
  test("uses short prefix per companion", () => {
    expect(commandUsage("drevan")).toContain("`drev: listen <url>`");
    expect(commandUsage("cypher")).toContain("`cy: club status`");
    expect(commandUsage("gaia")).toContain("`gaia: model");
  });
});
