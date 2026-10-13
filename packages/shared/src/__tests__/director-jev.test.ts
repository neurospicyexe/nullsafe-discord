// Director shadow voice (2026-10-13): pure parts plus the one call, with a fake fetch (never the network).

import { describe, it, expect, jest } from "@jest/globals";
import {
  NEXT_SPEAKERS, buildDirectorJevQuestions, directorJevEnabled, directorJevEval, jevAgreesDirector,
  parseDirectorJev, renderDirectorJevState,
} from "../director-jev.js";
import type { JevAnswers } from "../jev-gate.js";

const answers = (over: Partial<JevAnswers> = {}): JevAnswers => ({
  next_speaker: { type: "choice", choice: "gaia", confidence: 0.71, probabilities: { gaia: 0.71, drevan: 0.2, nobody: 0.09 } },
  thread_has_more: { type: "noul", noul: 0.64 },
  echoing: { type: "noul", noul: 0.18 },
  ...over,
});

describe("questions", () => {
  it("next_speaker covers the triad, the human, and nobody; two nouls ride along", () => {
    const q = buildDirectorJevQuestions();
    expect(Object.keys(q).sort()).toEqual(["echoing", "next_speaker", "thread_has_more"]);
    const ns = q.next_speaker as { type: string; criteria: Record<string, string> };
    expect(ns.type).toBe("choice");
    expect(Object.keys(ns.criteria)).toEqual([...NEXT_SPEAKERS]);
  });
});

describe("state", () => {
  it("labels companions, Raziel, Blue and guests; keeps the last 8; shows open calls and the budget", () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => ({ author: "drevan", companionId: "drevan" as const, isHuman: false, gist: `old ${i}` })),
      { author: "raziel", isHuman: true, gist: "hi all" },
      { author: "blue", isHuman: true, gist: "hey" },
      { author: "guest", isHuman: true, gist: "yo" },
      { author: "cypher", companionId: "cypher" as const, isHuman: false, gist: "Gaia, what do you see?" },
    ];
    const s = renderDirectorJevState({ turns, topic: "rain", openMoves: [{ from: "cypher", to: "gaia" }], botTurns: 7, turnBudget: 12 });
    expect(s).not.toContain("old 0");
    expect(s).not.toContain("old 1");
    expect(s).toContain("Drevan: old 2");
    expect(s).toContain("Raziel: hi all");
    expect(s).toContain("Blue: hey");
    expect(s).toContain("guest (a guest): yo");
    expect(s).toContain("Cypher: Gaia, what do you see?");
    expect(s).toContain("cypher called gaia");
    expect(s).toContain("7 of a budget of 12");
    expect(s).toContain("Blue (Raziel's husband, family)");
  });
});

describe("parse and compare", () => {
  it("parses the pick, distribution and nouls; rejects junk", () => {
    expect(parseDirectorJev(answers())).toEqual({ nextSpeaker: "gaia", confidence: 0.71, probabilities: { gaia: 0.71, drevan: 0.2, nobody: 0.09 }, threadHasMore: 0.64, echoing: 0.18 });
    expect(parseDirectorJev(answers({ next_speaker: { type: "choice", choice: "sol", confidence: 0.9, probabilities: {} } }))).toBeNull();
    expect(parseDirectorJev({})).toBeNull();
    expect(parseDirectorJev(null)).toBeNull();
  });
  it("an invite agrees on the same companion; a silence agrees with nobody or human", () => {
    const v = parseDirectorJev(answers())!;
    expect(jevAgreesDirector(v, { kind: "invite", companionId: "gaia" })).toBe(true);
    expect(jevAgreesDirector(v, { kind: "invite", companionId: "drevan" })).toBe(false);
    expect(jevAgreesDirector(v, { kind: "silence" })).toBe(false);
    expect(jevAgreesDirector({ ...v, nextSpeaker: "human" }, { kind: "silence" })).toBe(true);
    expect(jevAgreesDirector({ ...v, nextSpeaker: "nobody" }, { kind: "silence" })).toBe(true);
  });
  it("the knob: on unless DIRECTOR_JEV=off", () => {
    expect(directorJevEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(directorJevEnabled({ DIRECTOR_JEV: " OFF " } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("directorJevEval", () => {
  const env = { HALSETH_URL: "https://halseth.example/", HALSETH_SECRET: "s" } as NodeJS.ProcessEnv;
  it("posts to /admin/jev and parses", async () => {
    const fetchImpl = jest.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ answers: answers(), latency_ms: 180 }), { status: 200 })) as unknown as typeof fetch;
    const r = await directorJevEval("STATE", { env, fetchImpl });
    expect(r).toMatchObject({ ok: true, latency_ms: 180, verdict: { nextSpeaker: "gaia" } });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://halseth.example/admin/jev");
    expect(JSON.parse(init.body as string).purpose).toMatch(/director shadow/);
  });
  it("failures are reasons, never throws", async () => {
    const partial = jest.fn(async () => new Response(JSON.stringify({ answers: { echoing: { type: "noul", noul: 0.5 } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await directorJevEval("S", { env, fetchImpl: partial })).toMatchObject({ ok: false, reason: "no_next_speaker" });
    expect(await directorJevEval("S", { env: {} as NodeJS.ProcessEnv })).toMatchObject({ ok: false, reason: "no_halseth_env" });
  });
});
