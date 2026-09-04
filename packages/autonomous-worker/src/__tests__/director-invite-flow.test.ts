import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { renderStateBlock, buildInvite } from "../director/invite.js";
import { handleMessage, handleResult, decide, serializeByKey, type DirectorRuntime } from "../director/index.js";
import { floorSelection } from "../director/floor.js";
import { createRedisStateStore } from "../director/state.js";
import { createSupplyPool } from "../director/supply.js";
import { createHalsethLedger } from "../director/ledger.js";
import { emptyState } from "../director/types.js";
import { applyTurn } from "../director/state.js";
import { recordInvitation, resolveInvitation, consumeForageFind, convoFadeFor, convoLandFor } from "../halseth-client.js";
import { CHANNEL, type DirectorResultPayload } from "@nullsafe/shared";

function fakeRedis() {
  const store = new Map<string, string>(); const published: Array<[string, string]> = [];
  return { store, published,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string, ...a: unknown[]) { if (a.includes("NX") && store.has(k)) return null; store.set(k, v); return "OK"; },
    async del(k: string) { store.delete(k); return 1; },
    async publish(ch: string, msg: string) { published.push([ch, msg]); return 1; } };
}
function runtime(redis: ReturnType<typeof fakeRedis>, mode: "shadow" | "live"): DirectorRuntime {
  return {
    mode, redis: redis as never, store: createRedisStateStore(redis as never), ledger: createHalsethLedger(),
    pool: createSupplyPool({ fetch: async () => ({ items: [], cursor: "x" }), redis: null }),
    cfg: { turnBudget: 18, noUptakeMs: 90 * 60_000, inviteTtlMs: 180_000, order: "heat", limbic: false, minGapMs: 120_000 },
    now: () => Date.parse("2026-09-03T12:00:00.000Z"),
  };
}
const msg = (companionId: "drevan"|"gaia", content: string, id: string) => ({
  channelId: "c1", messageId: id, authorId: "b", authorKind: "companion" as const, companionId, content,
  replyToMessageId: null, createdAt: "2026-09-03T11:59:00.000Z", publishedBy: companionId,
});

beforeEach(() => {
  vi.mocked(recordInvitation).mockClear();
  vi.mocked(resolveInvitation).mockClear();
  vi.mocked(consumeForageFind).mockClear();
  vi.mocked(convoFadeFor).mockClear();
  vi.mocked(convoLandFor).mockClear();
});

describe("invite rendering", () => {
  it("state block names speakers and open moves", () => {
    let s = emptyState("c1", "t0");
    s = applyTurn(s, { author: "drevan", companionId: "drevan", gist: "Gaia, the feather", messageId: "m1", saidAt: "t1", isHuman: false }, ["gaia"]);
    const block = renderStateBlock(s);
    expect(block).toContain("drevan: Gaia, the feather");
    expect(block).toContain("open: drevan -> gaia");
  });
  it("buildInvite carries offer ids and an expiry", () => {
    const s = emptyState("c1", "t0");
    const inv = buildInvite({ kind: "invite", companionId: "cypher", reason: "open", offer: [] }, s, {}, { inviteTtlMs: 1000 }, { inviteId: "i1", nowMs: 0 });
    expect(inv.expiresAt).toBe(new Date(1000).toISOString());
    expect(inv.companionId).toBe("cypher");
  });
  it("buildInvite accepts addressedBy as a human name without type error", () => {
    const s = emptyState("c1", "t0");
    const inv = buildInvite({ kind: "invite", companionId: "gaia", reason: "addressed", offer: [], addressedBy: "raziel" }, s, {}, { inviteTtlMs: 1000 }, { inviteId: "i1", nowMs: 0 });
    expect(inv.addressedBy).toBe("raziel");
    expect(inv.companionId).toBe("gaia");
  });
});

describe("handleMessage", () => {
  it("shadow: records a shadow row and publishes nothing", async () => {
    const r = fakeRedis();
    await handleMessage(msg("drevan", "Gaia, the feather is still there.", "m1"), runtime(r, "shadow"));
    expect(recordInvitation).toHaveBeenCalledWith(expect.objectContaining({ companion_id: "gaia", reason: "addressed", outcome: "shadow" }));
    expect(r.published).toHaveLength(0);
  });
  it("live: records issued and publishes to the invitee's channel", async () => {
    const r = fakeRedis();
    await handleMessage(msg("drevan", "Gaia, the feather is still there.", "m1"), runtime(r, "live"));
    expect(recordInvitation).toHaveBeenCalledWith(expect.objectContaining({ outcome: "issued" }));
    expect(r.published[0]![0]).toBe(CHANNEL.directorInvite("gaia"));
  });
  it("silence selections record nothing", async () => {
    const r = fakeRedis();
    await handleMessage(msg("gaia", "The perimeter holds.", "m2"), runtime(r, "live"));
    expect(recordInvitation).not.toHaveBeenCalled();
    expect(r.published).toHaveLength(0);
  });
});

describe("handleResult", () => {
  const result = (over: Partial<DirectorResultPayload> = {}): DirectorResultPayload => ({
    inviteId: "i1", companionId: "gaia", channelId: "c1", outcome: "spoke", usedOfferIds: [], ...over,
  });

  it("spoke with a forage offer: consumes it from the durable record, lands the thread, RESETS state (floor clock keeps ticking)", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", offered: [{ id: "f1", kind: "forage" as const, toCompanion: "gaia" as const, inviteId: "i1", usedBy: null }] };
    await rt.store.save(s);
    await handleResult(result({ usedOfferIds: ["f1"], landed: "the crows remember", companionId: "gaia" }), rt);
    expect(consumeForageFind).toHaveBeenCalledWith("f1", "gaia");
    expect(convoLandFor).toHaveBeenCalledWith("t1", "the crows remember", "gaia");
    const after = await rt.store.load("c1");
    expect(after).not.toBeNull();
    expect(after!.turns.length).toBe(0);
    expect(after!.threadId).toBeNull();
    expect(after!.startedAt).toBe(new Date(rt.now()).toISOString());
  });

  it("passed: resolves the invitation, never consumes forage, state stays (not reset -- no land happened)", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", offered: [{ id: "f1", kind: "forage" as const, toCompanion: "gaia" as const, inviteId: "i1", usedBy: null }] };
    await rt.store.save(s);
    await handleResult(result({ outcome: "passed", usedOfferIds: ["f1"] }), rt);
    expect(resolveInvitation).toHaveBeenCalled();
    expect(consumeForageFind).not.toHaveBeenCalled();
    const after = await rt.store.load("c1");
    expect(after).not.toBeNull();
    expect(after!.threadId).toBe("t1");
  });

  it("passed: closes the open move addressed to the passing companion (C3c) -- a pass is an answer, not silence", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), openMoves: [{ from: "drevan", to: "gaia" as const, messageId: "m1", saidAt: "t1" }] };
    await rt.store.save(s);
    await handleResult(result({ outcome: "passed", companionId: "gaia" }), rt);
    const after = await rt.store.load("c1");
    expect(after!.openMoves).toHaveLength(0);
  });
});

describe("C1: floor survives a land/fade -- reset state, not deleted, so its silence clock keeps running", () => {
  it("a floorSelection check well after a land/fade sees the reset channel as quiet and picks it", () => {
    const T = Date.parse("2026-09-03T12:00:00.000Z");
    const resetAt = new Date(T).toISOString();
    const reset = emptyState("c1", resetAt);
    const laterT = T + 7 * 3600_000; // T+7h
    const supply = [{ kind: "project" as const, id: "p1", table: "companion_projects", owner: "cypher", title: "p1", body: "", created_at: "2026-09-01", heat: null, consumed_by: [] }];
    const pick = floorSelection({
      states: [reset], supply, nowMs: laterT,
      silenceHours: 6, wakingStartHour: 7, wakingEndHour: 23, tzOffsetHours: -5,
      turnsBySpeaker7d: { cypher: 0, drevan: 0, gaia: 0 },
    });
    expect(pick).toMatchObject({ channelId: "c1", companionId: "cypher" });
  });
});

describe("I2: recordInvitation failure must not publish", () => {
  it("a rejecting recordInvitation logs and returns without touching store/publish", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    vi.mocked(recordInvitation).mockRejectedValueOnce(new Error("halseth down"));
    const s = { ...emptyState("c1", "t0"), openMoves: [{ from: "drevan", to: "gaia" as const, messageId: "m1", saidAt: "t1" }] };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(r.published).toHaveLength(0);
    const after = await rt.store.load("c1");
    expect(after!.lastInviteAt).toBeNull();
  });
});

describe("I3: pacing gate", () => {
  it("two invite-eligible messages close together: the second is paced out (not recorded, not published)", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    await handleMessage(msg("drevan", "Gaia, the feather is still there.", "m1"), rt);
    expect(recordInvitation).toHaveBeenCalledTimes(1);
    vi.mocked(recordInvitation).mockClear();
    await handleMessage(msg("drevan", "Gaia, one more thing.", "m2"), rt);
    expect(recordInvitation).not.toHaveBeenCalled();
    expect(r.published).toHaveLength(1); // only the first invite ever published
  });
});

describe("serializeByKey", () => {
  it("two calls on the same key run in order", async () => {
    const chains = new Map<string, Promise<void>>();
    const order: number[] = [];
    const p1 = serializeByKey(chains, "k1", async () => { await new Promise((r) => setTimeout(r, 10)); order.push(1); });
    const p2 = serializeByKey(chains, "k1", async () => { order.push(2); });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
  it("different keys run concurrently (neither waits on the other's chain)", async () => {
    const chains = new Map<string, Promise<void>>();
    const order: string[] = [];
    const pA = serializeByKey(chains, "a", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("a-done"); });
    const pB = serializeByKey(chains, "b", async () => { order.push("b-done"); });
    await pB;
    expect(order).toEqual(["b-done"]); // b finished before a, proving they didn't share a chain
    await pA;
    expect(order).toEqual(["b-done", "a-done"]);
  });
});

describe("decide -- fade and clear", () => {
  it("shadow mode over budget: never fades, state stays", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "shadow");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", botTurns: 20 };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(convoFadeFor).not.toHaveBeenCalled();
    expect(await rt.store.load("c1")).not.toBeNull();
  });

  it("live mode over budget, no thread: RESETS state without fading (floor clock survives)", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: null, botTurns: 20 };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(convoFadeFor).not.toHaveBeenCalled();
    const after = await rt.store.load("c1");
    expect(after).not.toBeNull();
    expect(after!.turns.length).toBe(0);
    expect(after!.threadId).toBeNull();
    expect(after!.startedAt).toBe(new Date(rt.now()).toISOString());
  });

  it("live mode over budget, with a thread: fades it and RESETS state (floor clock survives)", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", botTurns: 20 };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(convoFadeFor).toHaveBeenCalledWith("t1", "turn_budget");
    const after = await rt.store.load("c1");
    expect(after).not.toBeNull();
    expect(after!.turns.length).toBe(0);
    expect(after!.threadId).toBeNull();
    expect(after!.startedAt).toBe(new Date(rt.now()).toISOString());
  });
});
