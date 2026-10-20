// The director's Jev (2026-10-20 redesign): echo brake (live, graduated), veto check (shadow), one decide row.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  getDirectorSupply: vi.fn(async () => ({ items: [], cursor: "2026-09-03T00:00:00.000Z" })),
  getDirectorNeighborhood: vi.fn(async () => ({ lines: [], nodes: [] })),
  recordInvitation: vi.fn(async () => {}),
  resolveInvitation: vi.fn(async () => {}),
  convoActiveFor: vi.fn(async () => null),
  convoOpenFor: vi.fn(async () => ({ id: "t1" })),
  convoTurnFor: vi.fn(async () => {}),
  convoLandFor: vi.fn(async () => true),
  convoFadeFor: vi.fn(async () => true),
  consumeForageFind: vi.fn(async () => true),
}));

import { fireDirectorJev, resolveEcho, decide, type DirectorRuntime } from "../director/index.js";
import { emptyState, type ConversationState } from "../director/types.js";
import { createRedisStateStore } from "../director/state.js";
import { createSupplyPool } from "../director/supply.js";
import { createHalsethLedger } from "../director/ledger.js";
import { recordInvitation } from "../halseth-client.js";
import { readEchoBrakeConfig, LOOP_BREAK_STEER } from "@nullsafe/shared";

const cfg = { turnBudget: 12, noUptakeMs: 1, inviteTtlMs: 1, order: "heat" as const, limbic: false, minGapMs: 1 };
const brakeCfg = readEchoBrakeConfig({} as NodeJS.ProcessEnv);
const state = (over: Partial<ConversationState> = {}): ConversationState => ({
  ...emptyState("ch1", "2026-10-13T00:00:00.000Z"),
  turns: [{ author: "cypher", companionId: "cypher", gist: "Gaia, what do you see?", messageId: "m9", saidAt: "2026-10-13T00:01:00.000Z", isHuman: false }],
  botTurns: 5,
  ...over,
});
const ok = (p: number) => async (_s?: string, _c?: unknown) => ({ ok: true as const, p, latency_ms: 150, wall_ms: 190 });
const invite = { kind: "invite" as const, companionId: "gaia" as const, reason: "addressed" as const, offer: [], addressedBy: "cypher" };

afterEach(() => { delete process.env["DIRECTOR_JEV"]; });

describe("fireDirectorJev", () => {
  it("logs the director's pick beside the echo read and a veto check on the picked companion", async () => {
    const log = vi.fn();
    const echoFn = vi.fn(ok(0.7)); const vetoFn = vi.fn(ok(0.1));
    await fireDirectorJev(state(), invite, false, { cfg }, { echoFn, vetoFn, log, brakeCfg, vetoTheta: 0.3 }).done;
    expect(echoFn.mock.calls[0]![0]).toContain("Cypher: Gaia, what do you see?");
    expect(vetoFn).toHaveBeenCalledWith(expect.any(String), "gaia");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      kind: "decide", channel_id: "ch1", after_msg_id: "m9", after_author: "cypher", bot_turns: 5,
      director: { kind: "invite", companion: "gaia", reason: "addressed", paced: false },
      echo: expect.objectContaining({ p: 0.7, streak: 1, action: "steer", effective: "steer", mode: "on" }),
      veto: expect.objectContaining({ companion: "gaia", p: 0.1, theta: 0.3, would_veto: true }),
    }));
  });
  it("a high veto p is not a would_veto; a silence or paced invite asks no veto", async () => {
    const log = vi.fn(); const vetoFn = vi.fn(ok(0.9));
    await fireDirectorJev(state(), invite, false, { cfg }, { echoFn: ok(0.1), vetoFn, log, brakeCfg, vetoTheta: 0.3 }).done;
    expect(log.mock.calls[0]![0].veto.would_veto).toBe(false);
    vetoFn.mockClear(); log.mockClear();
    await fireDirectorJev(state(), { kind: "silence", reason: "nothing_to_add" }, false, { cfg }, { echoFn: ok(0.1), vetoFn, log, brakeCfg }).done;
    await fireDirectorJev(state(), invite, true, { cfg }, { echoFn: ok(0.1), vetoFn, log, brakeCfg }).done;
    expect(vetoFn).not.toHaveBeenCalled();
    expect(log.mock.calls.every((c) => c[0].veto === null)).toBe(true);
  });
  it("failures are logged as reasons; a throw never escapes", async () => {
    const log = vi.fn();
    await fireDirectorJev(state(), invite, false, { cfg }, { echoFn: async () => ({ ok: false as const, reason: "http_502", wall_ms: 40 }), vetoFn: async () => { throw new Error("boom"); }, log, brakeCfg }).done;
    expect(log.mock.calls[0]![0]).toMatchObject({ echo: { p: null, failure: "http_502", action: "none" }, veto: { p: null, would_veto: null } });
    expect(log.mock.calls[0]![0].veto.failure).toMatch(/^throw:/);
  });
  it("DIRECTOR_JEV=off: no call, no row, no echo read", async () => {
    process.env["DIRECTOR_JEV"] = "off";
    const echoFn = vi.fn(); const log = vi.fn();
    const r = fireDirectorJev(state(), invite, false, { cfg }, { echoFn: echoFn as never, log, brakeCfg });
    await r.done;
    expect(await r.echo).toBeNull();
    expect(echoFn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("resolveEcho", () => {
  const read = (p: number) => ({ ok: true as const, p, latency_ms: 1, wall_ms: 1 });
  it("a summons from a human is steered, never braked", () => {
    const human = { ...invite, addressedBy: "raziel" };
    expect(resolveEcho(state({ echoStreak: 1 }), human, read(0.9), brakeCfg)).toMatchObject({ raw: "steer", effective: "steer", streak: 2 });
    expect(resolveEcho(state({ echoStreak: 1 }), invite, read(0.9), brakeCfg).effective).toBe("brake");
  });
  it("shadow mode computes the streak but acts on nothing; a null read fails open", () => {
    expect(resolveEcho(state(), invite, read(0.9), { ...brakeCfg, mode: "shadow" })).toMatchObject({ raw: "steer", effective: "none", streak: 1 });
    expect(resolveEcho(state({ echoStreak: 1 }), invite, null, brakeCfg)).toMatchObject({ effective: "none", streak: 1 });
  });
});

// decide(): the brake runs BEFORE the invite. Real shared eval, stubbed network.
function fakeRedis() {
  const store = new Map<string, string>();
  return { store, async get(k: string) { return store.get(k) ?? null; }, async set(k: string, v: string) { store.set(k, v); return "OK"; }, async del(k: string) { store.delete(k); return 1; }, async publish(_c: string, _m: string) { return 1; } };
}
function runtime(redis: ReturnType<typeof fakeRedis>): DirectorRuntime {
  return {
    mode: "live", redis: redis as never, store: createRedisStateStore(redis as never), ledger: createHalsethLedger(),
    pool: createSupplyPool({ fetch: async () => ({ items: [], cursor: "x" }), redis: null }),
    cfg: { turnBudget: 18, noUptakeMs: 90 * 60_000, inviteTtlMs: 180_000, order: "heat", limbic: false, minGapMs: 1 },
    now: () => Date.parse("2026-10-13T00:05:00.000Z"),
  };
}
describe("decide: graduated echo brake", () => {
  const saved = { fetch: globalThis.fetch, url: process.env["HALSETH_URL"], secret: process.env["HALSETH_SECRET"] };
  afterEach(() => {
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [["HALSETH_URL", saved.url], ["HALSETH_SECRET", saved.secret]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    delete process.env["DIRECTOR_ECHO_BRAKE"];
  });
  const stub = (echoP: number | "fail") => {
    process.env["HALSETH_URL"] = "https://h.example"; process.env["HALSETH_SECRET"] = "s";
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => {
      const qs = JSON.parse(init.body as string).questions;
      if (echoP === "fail" && qs.echoing) return new Response("no", { status: 502 });
      const answers = qs.echoing ? { echoing: { type: "noul", noul: echoP } } : { has_something_to_add: { type: "noul", noul: 0.9 } };
      return new Response(JSON.stringify({ answers, latency_ms: 5 }), { status: 200 });
    }) as typeof fetch;
  };
  const seed = async (redis: ReturnType<typeof fakeRedis>, over: Partial<ConversationState> = {}) => {
    const rt = runtime(redis);
    await rt.store.save(state({ openMoves: [{ from: "cypher", to: "gaia", messageId: "m9", saidAt: "2026-10-13T00:01:00.000Z" }], ...over }));
    return rt;
  };
  it("first echo read invites and persists the streak; the second in a row is echo_brake, no invite", async () => {
    stub(0.9);
    const redis = fakeRedis(); const rt = await seed(redis);
    vi.mocked(recordInvitation).mockClear();
    await decide("ch1", rt, true);
    expect(recordInvitation).toHaveBeenCalledTimes(1);
    const after1 = await rt.store.load("ch1");
    expect(after1?.echoStreak).toBe(1);
    await rt.store.save({ ...after1!, lastInviteAt: null });
    await decide("ch1", rt, true);
    expect(recordInvitation).toHaveBeenCalledTimes(1); // braked, nothing new recorded
    expect((await rt.store.load("ch1"))?.echoStreak).toBe(2);
  });
  it("the steer rides the published invite's state block", async () => {
    stub(0.9);
    const redis = fakeRedis(); const published: string[] = [];
    redis.publish = async (_c: string, m: string) => { published.push(m); return 1; };
    const rt = await seed(redis);
    await decide("ch1", rt, true);
    expect(JSON.parse(published[0]!).stateBlock).toContain(LOOP_BREAK_STEER);
  });
  it("a clean read resets the streak; a Jev failure fails open (invites, streak untouched)", async () => {
    stub(0.1); let rt = await seed(fakeRedis(), { echoStreak: 1 });
    await decide("ch1", rt, true);
    expect((await rt.store.load("ch1"))?.echoStreak).toBe(0);
    stub("fail"); rt = await seed(fakeRedis(), { echoStreak: 1 });
    vi.mocked(recordInvitation).mockClear();
    await decide("ch1", rt, true);
    expect(recordInvitation).toHaveBeenCalledTimes(1);
    expect((await rt.store.load("ch1"))?.echoStreak).toBe(1);
  });
  it("off and shadow modes never brake, even at a long streak", async () => {
    for (const mode of ["off", "shadow"]) {
      process.env["DIRECTOR_ECHO_BRAKE"] = mode; stub(0.9);
      const rt = await seed(fakeRedis(), { echoStreak: 5 });
      vi.mocked(recordInvitation).mockClear();
      await decide("ch1", rt, true);
      expect(recordInvitation).toHaveBeenCalledTimes(1);
    }
  });
  it("only a message-triggered decide is braked (the floor timer path is untouched)", async () => {
    stub(0.9);
    const rt = await seed(fakeRedis(), { echoStreak: 5 });
    vi.mocked(recordInvitation).mockClear();
    await decide("ch1", rt, false);
    expect(recordInvitation).toHaveBeenCalledTimes(1);
  });
});
