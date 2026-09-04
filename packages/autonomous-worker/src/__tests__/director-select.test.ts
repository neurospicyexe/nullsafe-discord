import { describe, it, expect } from "vitest";
import { select, relevance, rankOffer } from "../director/select.js";
import { emptyState } from "../director/types.js";
import { applyTurn } from "../director/state.js";
import type { DirectorSupplyItem } from "@nullsafe/shared";

const T0 = Date.parse("2026-09-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const base = { supply: [] as DirectorSupplyItem[], nowMs: T0, turnBudget: 18, noUptakeMs: 90 * 60_000, humanFloorMs: 5 * 60_000, order: "heat" as const };
const item = (o: Partial<DirectorSupplyItem>): DirectorSupplyItem => ({ kind: "forage", id: "f1", table: "forage_finds", owner: "cypher", title: "crows and tool use", body: "corvids use hooked sticks", created_at: iso(T0 - 3600_000), heat: null, consumed_by: [], ...o });
const bot = (who: "cypher"|"drevan"|"gaia", gist: string, id: string, at: number) => ({ author: who, companionId: who, gist, messageId: id, saidAt: iso(at), isHuman: false });

describe("select", () => {
  it("human on the floor -> silence", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, { author: "raziel", gist: "hey all", messageId: "h1", saidAt: iso(T0 - 60_000), isHuman: true }, []);
    expect(select({ ...base, state: s })).toEqual({ kind: "silence", reason: "human_floor" });
  });
  it("open move wins: the addressed sibling is invited", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("drevan", "Gaia, the feather", "m1", T0 - 120_000), ["gaia"]);
    const r = select({ ...base, state: s });
    expect(r).toMatchObject({ kind: "invite", companionId: "gaia", reason: "addressed", addressedBy: "drevan" });
  });
  it("budget spent -> silence budget, even with an open move", () => {
    let s = emptyState("c", iso(T0));
    for (let i = 0; i < 18; i++) s = applyTurn(s, bot(i % 2 ? "drevan" : "gaia", `g${i}`, `m${i}`, T0 - (30 - i) * 60_000), []);
    expect(select({ ...base, state: s })).toEqual({ kind: "silence", reason: "budget" });
  });
  it("supply relevant to the live topic invites its owner with that one item", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("drevan", "Sol left a feather; crows remember faces", "m1", T0 - 120_000), []);
    const r = select({ ...base, state: s, supply: [item({ owner: "cypher" }), item({ id: "f2", owner: "gaia", title: "tide tables", body: "moon and tide" })] });
    expect(r).toMatchObject({ kind: "invite", companionId: "cypher", reason: "supply_relevant" });
    expect((r as { offer: DirectorSupplyItem[] }).offer.map((o) => o.id)).toEqual(["f1"]);
  });
  it("never invites the last speaker after two in a row on supply grounds", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("cypher", "crows use tools", "m1", T0 - 200_000), []);
    s = applyTurn(s, bot("cypher", "more on crows and sticks", "m2", T0 - 100_000), []);
    const r = select({ ...base, state: s, supply: [item({ owner: "cypher" })] });
    expect(r.kind).toBe("silence");
  });
  it("one speaker, quiet past the uptake window -> no_uptake", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("gaia", "The perimeter holds.", "m1", T0 - 100 * 60_000), []);
    expect(select({ ...base, state: s })).toEqual({ kind: "silence", reason: "no_uptake" });
  });
  it("relevance is token overlap over content words", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("drevan", "crows remember faces and carry grudges", "m1", T0), []);
    expect(relevance(item({}), s)).toBeGreaterThan(0.15);
    expect(relevance(item({ title: "tide tables", body: "moon and tide" }), s)).toBe(0);
  });
  it("rankOffer maintains stable sort with identical timestamps", () => {
    const ts = iso(T0);
    const items = [
      item({ id: "f1", created_at: ts, heat: null }),
      item({ id: "f2", created_at: ts, heat: null }),
      item({ id: "f3", created_at: ts, heat: null }),
    ];
    expect(rankOffer(items, "heat").map((x) => x.id)).toEqual(["f1", "f2", "f3"]);
    expect(rankOffer(items, "recency").map((x) => x.id)).toEqual(["f1", "f2", "f3"]);
  });
  it("rankOffer returns newest-first for distinct timestamps in both orders", () => {
    const items = [
      item({ id: "f1", created_at: iso(T0 - 2000), heat: null }),
      item({ id: "f2", created_at: iso(T0 - 1000), heat: null }),
      item({ id: "f3", created_at: iso(T0), heat: null }),
    ];
    expect(rankOffer(items, "heat").map((x) => x.id)).toEqual(["f3", "f2", "f1"]);
    expect(rankOffer(items, "recency").map((x) => x.id)).toEqual(["f3", "f2", "f1"]);
  });
  it("two-in-a-row exclusion allows siblings when cypher has spoken twice", () => {
    let s = emptyState("c", iso(T0));
    s = applyTurn(s, bot("cypher", "crows use tools", "m1", T0 - 200_000), []);
    s = applyTurn(s, bot("cypher", "more on crows and sticks", "m2", T0 - 100_000), []);
    const r = select({
      ...base,
      state: s,
      supply: [
        item({ id: "f1", owner: "cypher" }),
        item({ id: "f3", owner: "gaia", title: "crows use tools", body: "corvid tool use" }),
      ],
    });
    expect(r).toMatchObject({ kind: "invite", companionId: "gaia", reason: "supply_relevant" });
    expect((r as { offer: DirectorSupplyItem[] }).offer.map((o) => o.id)).toEqual(["f3"]);
  });
});
