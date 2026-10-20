// Director shadow voice (2026-10-13): pure parts plus the one call, with a fake fetch (never the network).

import { describe, it, expect, jest } from "@jest/globals";
import {
  LANES, buildEchoQuestions, buildVetoQuestions, directorEchoEval, directorJevEnabled, directorJevTimeoutMs,
  directorVetoEval, echoBrakeStep, readEchoBrakeConfig, readVetoTheta, renderDirectorJevState,
} from "../director-jev.js";
import type { JevAnswers } from "../jev-gate.js";

const cfg = readEchoBrakeConfig({} as NodeJS.ProcessEnv);

describe("questions", () => {
  it("echo is its own single noul call; thread_has_more and next_speaker are gone", () => {
    expect(Object.keys(buildEchoQuestions())).toEqual(["echoing"]);
    expect((buildEchoQuestions().echoing as { type: string }).type).toBe("noul");
  });
  it("the veto asks about ONE companion, in that companion's lane, never bundled", () => {
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      const q = buildVetoQuestions(c);
      expect(Object.keys(q)).toEqual(["has_something_to_add"]);
      const ins = (q.has_something_to_add as { instructions: string }).instructions;
      expect(ins).toContain(`Does ${LANES[c].name} have something to add here that the other two have not already said?`);
      expect(ins).toContain(LANES[c].lane);
    }
    expect(LANES.gaia.lane).toMatch(/monastic/);
    expect(LANES.drevan.lane).toMatch(/emotional mirror/);
    expect(LANES.cypher.lane).toMatch(/structural/);
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

describe("knobs (defaults live in code)", () => {
  it("brake defaults: on, theta 0.5, min turns 4, streak 2; garbage and blanks fall back", () => {
    expect(cfg).toEqual({ mode: "on", theta: 0.5, minTurns: 4, streak: 2 });
    expect(readEchoBrakeConfig({ DIRECTOR_ECHO_BRAKE: " SHADOW ", DIRECTOR_ECHO_BRAKE_THETA: "0.7", DIRECTOR_ECHO_BRAKE_MIN_TURNS: "6", DIRECTOR_ECHO_BRAKE_STREAK: "3" } as NodeJS.ProcessEnv))
      .toEqual({ mode: "shadow", theta: 0.7, minTurns: 6, streak: 3 });
    expect(readEchoBrakeConfig({ DIRECTOR_ECHO_BRAKE: "off" } as NodeJS.ProcessEnv).mode).toBe("off");
    expect(readEchoBrakeConfig({ DIRECTOR_ECHO_BRAKE: "wat", DIRECTOR_ECHO_BRAKE_THETA: "", DIRECTOR_ECHO_BRAKE_STREAK: "0" } as NodeJS.ProcessEnv)).toEqual({ mode: "on", theta: 0.5, minTurns: 4, streak: 2 });
  });
  it("veto theta 0.3 and timeout 6000 by default", () => {
    expect(readVetoTheta({} as NodeJS.ProcessEnv)).toBe(0.3);
    expect(readVetoTheta({ DIRECTOR_VETO_THETA: "0.4" } as NodeJS.ProcessEnv)).toBe(0.4);
    expect(directorJevTimeoutMs({} as NodeJS.ProcessEnv)).toBe(6000);
    expect(directorJevTimeoutMs({ DIRECTOR_JEV_TIMEOUT_MS: "2500" } as NodeJS.ProcessEnv)).toBe(2500);
    expect(directorJevTimeoutMs({ DIRECTOR_JEV_TIMEOUT_MS: "-1" } as NodeJS.ProcessEnv)).toBe(6000);
  });
  it("DIRECTOR_JEV: on unless off", () => {
    expect(directorJevEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(directorJevEnabled({ DIRECTOR_JEV: " OFF " } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("echoBrakeStep", () => {
  it("first echo read steers, the second in a row brakes, a clean read resets", () => {
    const first = echoBrakeStep({ p: 0.8, botTurns: 5, streak: 0, cfg });
    expect(first).toEqual({ echoing: true, streak: 1, action: "steer" });
    expect(echoBrakeStep({ p: 0.8, botTurns: 6, streak: first.streak, cfg })).toEqual({ echoing: true, streak: 2, action: "brake" });
    expect(echoBrakeStep({ p: 0.2, botTurns: 7, streak: 1, cfg })).toEqual({ echoing: false, streak: 0, action: "none" });
  });
  it("under min turns or under theta never fires; exactly theta fires", () => {
    expect(echoBrakeStep({ p: 0.99, botTurns: 3, streak: 1, cfg }).action).toBe("none");
    expect(echoBrakeStep({ p: 0.49, botTurns: 9, streak: 0, cfg }).action).toBe("none");
    expect(echoBrakeStep({ p: 0.5, botTurns: 4, streak: 0, cfg }).action).toBe("steer");
  });
  it("fails OPEN: no read means no steer, no brake, streak untouched", () => {
    expect(echoBrakeStep({ p: null, botTurns: 9, streak: 1, cfg })).toEqual({ echoing: false, streak: 1, action: "none" });
  });
  it("a streak knob of 1 brakes on the first read", () => {
    expect(echoBrakeStep({ p: 0.9, botTurns: 9, streak: 0, cfg: { ...cfg, streak: 1 } }).action).toBe("brake");
  });
});

describe("the calls", () => {
  const env = { HALSETH_URL: "https://halseth.example/", HALSETH_SECRET: "s" } as NodeJS.ProcessEnv;
  const reply = (answers: JevAnswers) => jest.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ answers, latency_ms: 180 }), { status: 200 })) as unknown as typeof fetch;
  it("echo: posts to /admin/jev with ONLY the echo question and returns p", async () => {
    const fetchImpl = reply({ echoing: { type: "noul", noul: 0.64 } });
    expect(await directorEchoEval("STATE", { env, fetchImpl })).toMatchObject({ ok: true, p: 0.64, latency_ms: 180 });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://halseth.example/admin/jev");
    expect(Object.keys(JSON.parse(init.body as string).questions)).toEqual(["echoing"]);
  });
  it("veto: ONE companion per call", async () => {
    const fetchImpl = reply({ has_something_to_add: { type: "noul", noul: 0.12 } });
    expect(await directorVetoEval("STATE", "gaia", { env, fetchImpl })).toMatchObject({ ok: true, p: 0.12 });
    const body = JSON.parse(((fetchImpl as unknown as jest.Mock).mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions)).toEqual(["has_something_to_add"]);
    expect(body.questions.has_something_to_add.instructions).toContain("Gaia");
  });
  it("failures are reasons, never throws", async () => {
    expect(await directorEchoEval("S", { env, fetchImpl: reply({}) })).toMatchObject({ ok: false, reason: "no_echoing" });
    expect(await directorEchoEval("S", { env: {} as NodeJS.ProcessEnv })).toMatchObject({ ok: false, reason: "no_halseth_env" });
    const boom = jest.fn(async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect((await directorVetoEval("S", "cypher", { env, fetchImpl: boom })).ok).toBe(false);
  });
});
