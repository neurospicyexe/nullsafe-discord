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
import { handleMessage, handleResult, decide, type DirectorRuntime } from "../director/index.js";
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
    cfg: { turnBudget: 18, noUptakeMs: 90 * 60_000, inviteTtlMs: 180_000, order: "heat", limbic: false },
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

  it("spoke with a forage offer: consumes it from the durable record, lands the thread, clears state", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", offered: [{ id: "f1", kind: "forage" as const, toCompanion: "gaia" as const, inviteId: "i1", usedBy: null }] };
    await rt.store.save(s);
    await handleResult(result({ usedOfferIds: ["f1"], landed: "the crows remember", companionId: "gaia" }), rt);
    expect(consumeForageFind).toHaveBeenCalledWith("f1", "gaia");
    expect(convoLandFor).toHaveBeenCalledWith("t1", "the crows remember", "gaia");
    expect(await rt.store.load("c1")).toBeNull();
  });

  it("passed: resolves the invitation, never consumes forage, state stays", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", offered: [{ id: "f1", kind: "forage" as const, toCompanion: "gaia" as const, inviteId: "i1", usedBy: null }] };
    await rt.store.save(s);
    await handleResult(result({ outcome: "passed", usedOfferIds: ["f1"] }), rt);
    expect(resolveInvitation).toHaveBeenCalled();
    expect(consumeForageFind).not.toHaveBeenCalled();
    expect(await rt.store.load("c1")).not.toBeNull();
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

  it("live mode over budget, no thread: clears state without fading", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: null, botTurns: 20 };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(convoFadeFor).not.toHaveBeenCalled();
    expect(await rt.store.load("c1")).toBeNull();
  });

  it("live mode over budget, with a thread: fades it and clears state", async () => {
    const r = fakeRedis();
    const rt = runtime(r, "live");
    const s = { ...emptyState("c1", "t0"), threadId: "t1", botTurns: 20 };
    await rt.store.save(s);
    await decide("c1", rt);
    expect(convoFadeFor).toHaveBeenCalledWith("t1", "turn_budget");
    expect(await rt.store.load("c1")).toBeNull();
  });
});
