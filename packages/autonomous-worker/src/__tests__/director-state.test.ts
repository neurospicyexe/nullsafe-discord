import { describe, it, expect } from "vitest";
import { emptyState } from "../director/types.js";
import { applyTurn, createRedisStateStore } from "../director/state.js";

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string, ...args: unknown[]) {
      if (args.includes("NX") && store.has(k)) return null;
      store.set(k, v); return "OK";
    },
    async del(k: string) { store.delete(k); return 1; },
  };
}

describe("ConversationState", () => {
  it("applyTurn records turns, resolves and opens moves, counts bot turns", () => {
    let s = emptyState("c1", "2026-09-03T00:00:00.000Z");
    s = applyTurn(s, { author: "drevan", companionId: "drevan", gist: "Gaia, the feather", messageId: "m1", saidAt: "2026-09-03T00:01:00.000Z", isHuman: false }, ["gaia"]);
    expect(s.openMoves).toEqual([{ from: "drevan", to: "gaia", messageId: "m1", saidAt: "2026-09-03T00:01:00.000Z" }]);
    expect(s.botTurns).toBe(1);
    expect(s.topic).toBe("Gaia, the feather");
    s = applyTurn(s, { author: "gaia", companionId: "gaia", gist: "It remains.", messageId: "m2", saidAt: "2026-09-03T00:02:00.000Z", isHuman: false }, []);
    expect(s.openMoves).toEqual([]);
    expect(s.lastSpeaker).toBe("gaia");
    expect(s.lastBotAt).toBe("2026-09-03T00:02:00.000Z");
  });
  it("human turns stamp lastHumanAt and do not count against botTurns", () => {
    let s = emptyState("c1", "t0");
    s = applyTurn(s, { author: "raziel", gist: "hi", messageId: "m3", saidAt: "t1", isHuman: true }, []);
    expect(s.lastHumanAt).toBe("t1");
    expect(s.botTurns).toBe(0);
  });
  it("caps turns at 24", () => {
    let s = emptyState("c1", "t0");
    for (let i = 0; i < 30; i++) s = applyTurn(s, { author: "cypher", companionId: "cypher", gist: `g${i}`, messageId: `m${i}`, saidAt: `t${i}`, isHuman: false }, []);
    expect(s.turns).toHaveLength(24);
    expect(s.turns[0]!.gist).toBe("g6");
  });
  it("redis store round-trips and dedupes messages", async () => {
    const r = fakeRedis();
    const store = createRedisStateStore(r as never);
    expect(await store.load("c1")).toBeNull();
    await store.save(emptyState("c1", "t0"));
    expect((await store.load("c1"))!.channelId).toBe("c1");
    expect(await store.seenMessage("m1")).toBe(true);
    expect(await store.seenMessage("m1")).toBe(false);
    await store.clear("c1");
    expect(await store.load("c1")).toBeNull();
  });
  it("applyTurn never mutates its input", () => {
    const s = emptyState("c1", "t0");
    const beforeTurns = s.turns; const beforeMoves = s.openMoves;
    const snapshot = JSON.stringify(s);
    applyTurn(s, { author: "drevan", companionId: "drevan", gist: "Gaia?", messageId: "m1", saidAt: "t1", isHuman: false }, ["gaia"]);
    expect(s.turns).toBe(beforeTurns);
    expect(s.openMoves).toBe(beforeMoves);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
  it("one open move per addressee", () => {
    let s = emptyState("c1", "t0");
    s = applyTurn(s, { author: "drevan", companionId: "drevan", gist: "Gaia, Gaia", messageId: "m1", saidAt: "t1", isHuman: false }, ["gaia", "gaia"]);
    s = applyTurn(s, { author: "cypher", companionId: "cypher", gist: "Gaia?", messageId: "m2", saidAt: "t2", isHuman: false }, ["gaia"]);
    expect(s.openMoves).toHaveLength(1);
    expect(s.openMoves[0]!.from).toBe("drevan");
  });
});
