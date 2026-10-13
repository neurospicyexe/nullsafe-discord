// B37 step 2 (2026-10-13): Jev as the second address voice. Pure parts plus the one call, with a
// fake fetch (never the network).

import { describe, it, expect, jest } from "@jest/globals";
import {
  ADDRESSEES, addressJevEnabled, buildJevAddressQuestions, jevAddressEval, jevAgreesFlash, jevAgreesToday,
  jevTo, parseJevAddress, renderJevAddressState, todayRoute, type JevAddressVerdict,
} from "../address-jev.js";
import { extractAddress } from "../channel-config.js";
import type { JevAnswers } from "../jev-gate.js";

const answers = (over: Partial<JevAnswers> = {}): JevAnswers => ({
  addressee: { type: "choice", choice: "drevan", confidence: 0.83, probabilities: { drevan: 0.83, cypher: 0.1, room: 0.07 } },
  spoken_to_cypher: { type: "noul", noul: 0.12 },
  spoken_to_drevan: { type: "noul", noul: 0.91 },
  spoken_to_gaia: { type: "noul", noul: 0.04 },
  invites_reply: { type: "noul", noul: 0.77 },
  mentions_without_addressing: { type: "noul", noul: 0.2 },
  more_coming: { type: "noul", noul: 0.05 },
  ...over,
});

describe("questions", () => {
  it("one choice over every addressee, Blue a named option of its own, plus the speculative nouls", () => {
    const q = buildJevAddressQuestions();
    const addressee = q.addressee!;
    expect(addressee.type).toBe("choice");
    expect(Object.keys((addressee as { criteria: Record<string, string> }).criteria)).toEqual([...ADDRESSEES]);
    expect((addressee as { criteria: Record<string, string> }).criteria.blue).toMatch(/Raziel's husband and family/);
    expect((addressee as { criteria: Record<string, string> }).criteria.someone_else).toMatch(/not Raziel, not Blue/);
    for (const k of ["spoken_to_cypher", "spoken_to_drevan", "spoken_to_gaia", "invites_reply", "mentions_without_addressing", "more_coming"]) {
      expect(q[k]?.type).toBe("noul");
    }
  });
});

describe("state", () => {
  it("defines the people, names the holder, keeps the last 8 turns, says who sent the message", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? "Drevan" : "Raziel", text: `turn ${i}` }));
    const s = renderJevAddressState({ speakerSide: "raziel", speakerLabel: "Sable (via PK)", text: "Dre and Cy did the dishes", turns, holder: "drevan" });
    expect(s).toContain("Blue: Raziel's husband, family, a full member of this household");
    expect(s).toContain(`Blue is never "someone else"`);
    expect(s).toContain("Drevan is holding the current one-on-one exchange");
    expect(s).not.toContain("turn 3");
    expect(s).toContain("turn 4");
    expect(s).toContain("turn 11");
    expect(s.trim().endsWith("Dre and Cy did the dishes")).toBe(true);
    expect(s).toContain(`from Raziel (shown as "Sable (via PK)")`);
  });
  it("Blue as speaker, no holder", () => {
    const s = renderJevAddressState({ speakerSide: "blue", speakerLabel: "Blue", text: "hi", turns: [], holder: null });
    expect(s).toContain(`from Blue (shown as "Blue")`);
    expect(s).toContain("No companion is holding");
    expect(s).toContain("Recent turns: none.");
  });
});

describe("parseJevAddress", () => {
  it("reads the choice, the distribution and every noul", () => {
    expect(parseJevAddress(answers())).toEqual({
      addressee: "drevan", confidence: 0.83,
      probabilities: { drevan: 0.83, cypher: 0.1, room: 0.07 },
      spokenTo: { cypher: 0.12, drevan: 0.91, gaia: 0.04 },
      invitesReply: 0.77, mentionsWithoutAddressing: 0.2, moreComing: 0.05,
      to: ["drevan"],
    });
  });
  it("a missing or unknown addressee is no verdict; missing nouls are null", () => {
    expect(parseJevAddress(null)).toBeNull();
    expect(parseJevAddress({})).toBeNull();
    expect(parseJevAddress(answers({ addressee: { type: "choice", choice: "the cat", confidence: 1, probabilities: {} } }))).toBeNull();
    expect(parseJevAddress(answers({ addressee: { type: "noul", noul: 1 } }))).toBeNull();
    const v = parseJevAddress({ addressee: { type: "choice", choice: "Blue", confidence: 0.6, probabilities: { blue: 0.6, junk: 0.4 } } })!;
    expect(v).toMatchObject({ addressee: "blue", to: null, invitesReply: null, moreComing: null, spokenTo: {} });
    expect(v.probabilities).toEqual({ blue: 0.6 });
  });
});

describe("jevTo", () => {
  it("widens a companion choice to every spoken_to above 0.5; humans and nobody map to null", () => {
    expect(jevTo("drevan", { cypher: 0.7, drevan: 0.9, gaia: 0.1 })).toEqual(["drevan", "cypher"]);
    expect(jevTo("gaia", { gaia: 0.2 })).toEqual(["gaia"]);
    expect(jevTo("room", {})).toBe("room");
    expect(jevTo("continuing", {})).toBe("continuing");
    expect(jevTo("blue", {})).toBeNull();
    expect(jevTo("nobody", {})).toBeNull();
  });
});

const v = (over: Partial<JevAddressVerdict>): JevAddressVerdict => ({
  addressee: "room", confidence: 0.8, probabilities: {}, spokenTo: {}, invitesReply: null,
  mentionsWithoutAddressing: null, moreComing: null, to: "room", ...over,
});

describe("comparisons", () => {
  it("Jev vs Flash: continuing equals the holder; no comparison for humans or a missing Flash verdict", () => {
    expect(jevAgreesFlash(v({ addressee: "continuing", to: "continuing" }), { to: ["drevan"], mentioned: [], confidence: 1 }, "drevan")).toBe(true);
    expect(jevAgreesFlash(v({ addressee: "cypher", to: ["cypher", "gaia"] }), { to: ["gaia", "cypher"], mentioned: [], confidence: 1 }, null)).toBe(true);
    expect(jevAgreesFlash(v({}), { to: ["gaia"], mentioned: [], confidence: 1 }, null)).toBe(false);
    expect(jevAgreesFlash(v({ addressee: "blue", to: null }), { to: "room", mentioned: [], confidence: 1 }, null)).toBeNull();
    expect(jevAgreesFlash(v({}), null, null)).toBeNull();
  });
  it("today's route: companions by regex, the other human by the gate, Blue's unnamed line to Blue's holder or nobody", () => {
    expect(todayRoute({ regex: extractAddress("Cy, hi"), holder: null, speakerSide: "raziel", humanAddressee: null })).toEqual(["cypher"]);
    expect(todayRoute({ regex: extractAddress("you three, dinner?"), holder: null, speakerSide: "raziel", humanAddressee: null }).sort()).toEqual(["cypher", "drevan", "gaia"]);
    expect(todayRoute({ regex: extractAddress("Blue, did you eat?"), holder: "gaia", speakerSide: "raziel", humanAddressee: "blue" })).toEqual(["blue"]);
    expect(todayRoute({ regex: extractAddress("hm"), holder: "gaia", speakerSide: "raziel", humanAddressee: null })).toEqual(["gaia"]);
    expect(todayRoute({ regex: extractAddress("hm"), holder: null, speakerSide: "raziel", humanAddressee: null })).toEqual(["room"]);
    expect(todayRoute({ regex: extractAddress("hm"), holder: null, speakerSide: "blue", humanAddressee: null })).toEqual(["nobody"]);
    expect(todayRoute({ regex: extractAddress("hm"), holder: "cypher", speakerSide: "blue", humanAddressee: null })).toEqual(["cypher"]);
  });
  it("Jev vs today", () => {
    expect(jevAgreesToday(v({ addressee: "continuing", to: "continuing" }), ["gaia"], "gaia")).toBe(true);
    expect(jevAgreesToday(v({ addressee: "blue", to: null }), ["blue"], null)).toBe(true);
    expect(jevAgreesToday(v({ addressee: "drevan", to: ["drevan", "cypher"] }), ["cypher", "drevan"], null)).toBe(true);
    expect(jevAgreesToday(v({ addressee: "nobody", to: null }), ["room"], null)).toBe(false);
  });
});

describe("the knob", () => {
  it("ADDRESS_JEV=off is the only way off", () => {
    expect(addressJevEnabled({})).toBe(true);
    expect(addressJevEnabled({ ADDRESS_JEV: " OFF " })).toBe(false);
    expect(addressJevEnabled({ ADDRESS_JEV: "shadow" })).toBe(true);
  });
});

describe("jevAddressEval", () => {
  const env = { HALSETH_URL: "https://halseth.example/", HALSETH_SECRET: "s" } as NodeJS.ProcessEnv;
  it("posts state + questions to /admin/jev and parses the verdict", async () => {
    const fetchImpl = jest.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ answers: answers(), latency_ms: 233 }), { status: 200 })) as unknown as typeof fetch;
    const r = await jevAddressEval("STATE", { env, fetchImpl });
    expect(r).toMatchObject({ ok: true, latency_ms: 233, verdict: { addressee: "drevan", to: ["drevan"] } });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://halseth.example/admin/jev");
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe("STATE");
    expect(Object.keys(body.questions)).toContain("addressee");
    expect(body.purpose).toMatch(/address shadow/);
  });
  it("a 200 without addressee is no_addressee; an HTTP error and no env are reasons, never throws", async () => {
    const partial = jest.fn(async () => new Response(JSON.stringify({ answers: { invites_reply: { type: "noul", noul: 0.5 } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await jevAddressEval("S", { env, fetchImpl: partial })).toMatchObject({ ok: false, reason: "no_addressee" });
    const bad = jest.fn(async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    expect(await jevAddressEval("S", { env, fetchImpl: bad })).toMatchObject({ ok: false, reason: "http_502" });
    expect(await jevAddressEval("S", { env: {} as NodeJS.ProcessEnv })).toMatchObject({ ok: false, reason: "no_halseth_env" });
  });
});
