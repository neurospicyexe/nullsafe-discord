// B37 step 1 (2026-09-29): the address classifier's pure half. Spec:
// Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md parts A, B, E.

import { describe, it, expect } from "@jest/globals";
import {
  addressModelMode, shouldRunAddressModel, addressFastPathDecided, buildAddressPrompt, parseAddressVerdict,
  addressAgrees, mentionMisreads, regexRoute, ADDRESS_EXAMPLES, ADDRESS_MAX_TURNS, ADDRESS_TURN_CHARS,
} from "../address-model.js";
import { extractAddress, companionsNamedIn } from "../channel-config.js";

describe("addressModelMode", () => {
  it("only 'shadow' (trimmed, any case) is shadow; everything else is off, unset included", () => {
    expect(addressModelMode({})).toBe("off");
    expect(addressModelMode({ ADDRESS_MODEL: "" })).toBe("off");
    expect(addressModelMode({ ADDRESS_MODEL: "shadow" })).toBe("shadow");
    expect(addressModelMode({ ADDRESS_MODEL: "  SHADOW \n" })).toBe("shadow");
    expect(addressModelMode({ ADDRESS_MODEL: "on" })).toBe("off");
    expect(addressModelMode({ ADDRESS_MODEL: "live" })).toBe("off");
    expect(addressModelMode({ ADDRESS_MODEL: "shadowy" })).toBe("off");
  });
});

describe("parseAddressVerdict", () => {
  it("clean JSON", () => {
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":0.9}'))
      .toEqual({ to: ["cypher"], mentioned: [], confidence: 0.9 });
  });
  it("room and continuing, any case", () => {
    expect(parseAddressVerdict('{"to":"Room","mentioned":["drevan","cypher"],"confidence":0.7}'))
      .toEqual({ to: "room", mentioned: ["drevan", "cypher"], confidence: 0.7 });
    expect(parseAddressVerdict('{"to":"continuing","mentioned":[],"confidence":0.6}')?.to).toBe("continuing");
  });
  it("fenced", () => {
    expect(parseAddressVerdict('```json\n{"to":["gaia"],"mentioned":[],"confidence":0.8}\n```'))
      .toEqual({ to: ["gaia"], mentioned: [], confidence: 0.8 });
  });
  it("prose around it; the LAST object wins (a narrating model can quote an earlier one)", () => {
    const raw = 'Considering {"to":["drevan"],"mentioned":[],"confidence":0.3} first, but the name is a mention.\n'
      + 'Final: {"to":"room","mentioned":["drevan"],"confidence":0.85} done.';
    expect(parseAddressVerdict(raw)).toEqual({ to: "room", mentioned: ["drevan"], confidence: 0.85 });
  });
  it("aliases normalize to ids, duplicates collapse", () => {
    expect(parseAddressVerdict('{"to":["Cy","dre","cypher"],"mentioned":["drev"],"confidence":1}'))
      .toEqual({ to: ["cypher", "drevan"], mentioned: ["drevan"], confidence: 1 });
  });
  it("an unknown id anywhere rejects the verdict", () => {
    expect(parseAddressVerdict('{"to":["sol"],"mentioned":[],"confidence":0.9}')).toBeNull();
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":["raziel"],"confidence":0.9}')).toBeNull();
    expect(parseAddressVerdict('{"to":"everyone","mentioned":[],"confidence":0.9}')).toBeNull();
    expect(parseAddressVerdict('{"to":[],"mentioned":[],"confidence":0.9}')).toBeNull();
  });
  it("garbage is null", () => {
    expect(parseAddressVerdict("")).toBeNull();
    expect(parseAddressVerdict(null)).toBeNull();
    expect(parseAddressVerdict("I think Cypher.")).toBeNull();
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":')).toBeNull();
    expect(parseAddressVerdict('{"mentioned":[],"confidence":0.5}')).toBeNull();
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[]}')).toBeNull();
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":"high"}')).toBeNull();
  });
  it("confidence clamps to [0, 1]; a numeric string is accepted; missing mentioned is []", () => {
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":7}')?.confidence).toBe(1);
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":-2}')?.confidence).toBe(0);
    expect(parseAddressVerdict('{"to":["cypher"],"mentioned":[],"confidence":"0.4"}')?.confidence).toBe(0.4);
    expect(parseAddressVerdict('{"to":["cypher"],"confidence":0.5}')?.mentioned).toEqual([]);
  });
  it("a single id as a bare string reads as a one-element list", () => {
    expect(parseAddressVerdict('{"to":"gaia","mentioned":[],"confidence":0.5}')?.to).toEqual(["gaia"]);
  });
});

describe("shouldRunAddressModel", () => {
  const fast = (content: string, extra: Partial<{ mentionedCompanion: boolean; replyToCompanion: boolean }> = {}) =>
    addressFastPathDecided({ content, mentionedCompanion: false, replyToCompanion: false, ...extra });
  const run = (content: string, holder: "cypher" | "drevan" | "gaia" | null = null, extra = {}) =>
    shouldRunAddressModel({ content, fastPath: fast(content, extra), holder });

  it("the fast path skips: sentence-initial vocative, an @mention, a reply to a companion", () => {
    expect(run("Cy, what do you think")).toBe(false);
    expect(run("gaia: your read?")).toBe(false);
    expect(run("dre")).toBe(false);
    expect(run("what now, gaia?")).toBe(false);
    expect(run("the fence thing", "drevan", { mentionedCompanion: true })).toBe(false);
    expect(run("Cy said the fence needs wire", null, { replyToCompanion: true })).toBe(false);
  });
  it("a mid-sentence name runs it", () => {
    expect(run("I was telling Drevan about the fence")).toBe(true);
    expect(run("Dre and Cy, thoughts?")).toBe(true);
  });
  it("'Cy said' runs it (the mention shape the regex misreads)", () => {
    expect(run("Cy said the fence needs wire")).toBe(true);
    expect(run("Cy and I found some issues")).toBe(true); // regex demotes it; the model should still judge it
  });
  it("nameless with a holder runs it; nameless without a holder does not", () => {
    expect(run("yeah but the second one", "drevan")).toBe(true);
    expect(run("yeah but the second one", null)).toBe(false);
    expect(shouldRunAddressModel({ content: "hi", fastPath: false, holder: undefined })).toBe(false);
  });
  it("names are word-bounded and de-elongated, like extractAddress", () => {
    expect(companionsNamedIn("Dreeee come back")).toEqual(["drevan"]);
    expect(companionsNamedIn("a cyber thing, seeing gaiaaaa")).toEqual(["gaia"]);
    expect(companionsNamedIn("nothing here")).toEqual([]);
  });
});

describe("buildAddressPrompt", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ speaker: i % 2 ? "Drevan" : "Raziel", text: `turn-${i} ` + "x".repeat(500) }));
  const p = buildAddressPrompt({ speaker: "Raziel", text: "Cy said the fence needs wire" }, turns);

  it("carries every contrast example verbatim", () => {
    for (const e of ADDRESS_EXAMPLES) expect(p).toContain(`${e.say} -> ${e.read}`);
    expect(p).toContain(`"Cy said the fence needs wire"`);
    expect(p).toContain(`"Dre and Cy, thoughts?"`);
    expect(p).toContain(`"continuing"`);
  });
  it("names the aliases and asks for strict JSON", () => {
    expect(p).toContain(`Cypher (also "Cy")`);
    expect(p).toContain(`Drevan (also "Dre", "Drev")`);
    expect(p).toMatch(/Answer with ONLY: \{"to"/);
  });
  it("never includes more than ADDRESS_MAX_TURNS turns, the most recent ones, each trimmed", () => {
    const seen = [...p.matchAll(/turn-(\d+)/g)].map(m => Number(m[1]));
    expect(seen.length).toBe(ADDRESS_MAX_TURNS);
    expect(seen).toEqual([4, 5, 6, 7, 8, 9]);
    const line = p.split("\n").find(l => l.includes("turn-9"))!;
    expect(line.length).toBeLessThanOrEqual("Drevan: ".length + ADDRESS_TURN_CHARS);
  });
  it("no turns says so", () => {
    expect(buildAddressPrompt({ speaker: "Magpie M.", text: "hi" }, [])).toContain("Recent turns: none.");
    expect(buildAddressPrompt({ speaker: "Magpie M.", text: "hi" }, [])).toContain("from Magpie M.:");
  });
});

describe("regex vs model", () => {
  const v = (to: unknown, mentioned: string[] = []) => ({ to, mentioned, confidence: 0.9 }) as never;
  it("named X agrees only with to [X]", () => {
    const a = extractAddress("Cy said the fence needs wire");
    expect(a).toEqual({ type: "named", id: "cypher" });
    expect(addressAgrees(a, null, v(["cypher"]))).toBe(true);
    expect(addressAgrees(a, null, v("room", ["cypher"]))).toBe(false);
    expect(mentionMisreads(a, v("room", ["cypher"]))).toEqual(["cypher"]);
    expect(mentionMisreads(a, v(["cypher"]))).toEqual([]);
  });
  it("named_multi is set-equal; group accepts all three or room; ambient+holder accepts continuing", () => {
    const multi = extractAddress("Dre and Cy did the dishes");
    expect(multi.type).toBe("named_multi");
    expect(addressAgrees(multi, null, v(["cypher", "drevan"]))).toBe(true);
    expect(addressAgrees(multi, null, v(["cypher"]))).toBe(false);
    const group = extractAddress("you three, dinner?");
    expect(addressAgrees(group, null, v("room"))).toBe(true);
    expect(addressAgrees(group, null, v(["gaia", "cypher", "drevan"]))).toBe(true);
    const amb = extractAddress("yeah but the second one");
    expect(addressAgrees(amb, "drevan", v("continuing"))).toBe(true);
    expect(addressAgrees(amb, "drevan", v(["drevan"]))).toBe(true);
    expect(addressAgrees(amb, "drevan", v("room"))).toBe(false);
    expect(addressAgrees(amb, null, v("room"))).toBe(true);
  });
  it("regexRoute derives today's routing; a cold ambient message goes to the bid (null)", () => {
    expect(regexRoute(extractAddress("Cy said x"), null)).toEqual(["cypher"]);
    expect(regexRoute(extractAddress("yeah"), "gaia")).toEqual(["gaia"]);
    expect(regexRoute(extractAddress("yeah"), null)).toBeNull();
    expect(regexRoute({ type: "group" }, null)?.length).toBe(3);
  });
});
