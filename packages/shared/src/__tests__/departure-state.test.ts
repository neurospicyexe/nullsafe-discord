// Declared departures, bot side (departure-state.ts, T4b).
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  departuresMode, resetDepartureState, setDepartures, openDepartures, departureLift, matchStandDown, applyStandDown,
  claimStandDown, clearDeparturesLocal, ensureDepartures, departureTurnLines, departureLiftLine, DEPARTURE_STALE_MS,
  type DepartureRow, type ClaimRedis,
} from "../departure-state.js";
import { setCareState } from "../care-state.js";

const T0 = Date.parse("2026-11-01T20:00:00Z");
const row = (o: Partial<DepartureRow> = {}): DepartureRow => ({
  id: "d1", companion: "drevan", rail: "loop_motif", scope_channel: null,
  starts_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 3_600_000).toISOString(), reason: "a spiral, on purpose", ...o,
});
const lift = (o: Record<string, unknown> = {}) => departureLift({
  companionId: "drevan", rail: "loop_motif", channelId: "c1", messageTs: T0 + 60_000, triadOnly: true, careHold: false, now: T0 + 60_000, ...o,
} as Parameters<typeof departureLift>[0]);

beforeEach(() => { resetDepartureState(); });
afterEach(() => { setCareState("drevan", null); });

describe("the knob", () => {
  it("code default is shadow; per-companion wins; junk is shadow", () => {
    expect(departuresMode({})).toBe("shadow");
    expect(departuresMode({ DEPARTURES: "off" })).toBe("off");
    expect(departuresMode({ DEPARTURES: "off", DEPARTURES_DREVAN: " ON " }, "drevan")).toBe("on");
    expect(departuresMode({ DEPARTURES: "on" }, "gaia")).toBe("on");
    expect(departuresMode({ DEPARTURES: "banana" })).toBe("shadow");
  });
});

describe("departureLift", () => {
  it("lifts only the covered rail", () => {
    setDepartures([row()], T0);
    expect(lift().lift).toBe(true);
    expect(lift({ rail: "form" })).toEqual({ lift: false, why: "no_departure" });
  });
  it("only this companion's own departure", () => {
    setDepartures([row({ companion: "cypher" })], T0);
    expect(lift().lift).toBe(false);
  });
  it("only triad-only turns", () => {
    setDepartures([row()], T0);
    expect(lift({ triadOnly: false })).toEqual({ lift: false, why: "not_triad_only" });
  });
  it("never under care hold", () => {
    setDepartures([row()], T0);
    expect(lift({ careHold: true })).toEqual({ lift: false, why: "care_hold" });
    expect(openDepartures(T0 + 1, true)).toEqual([]);
  });
  it("never on the declaring turn (trigger at or before starts_at)", () => {
    setDepartures([row()], T0);
    expect(lift({ messageTs: T0 - 5_000 })).toEqual({ lift: false, why: "declaring_turn" });
    expect(lift({ messageTs: T0 })).toEqual({ lift: false, why: "declaring_turn" });
    expect(lift({ messageTs: T0 + 1 }).lift).toBe(true);
  });
  it("expiry is checked on the bot's own clock", () => {
    setDepartures([row()], T0);
    expect(lift({ now: T0 + 3_600_001, messageTs: T0 + 3_600_001 })).toEqual({ lift: false, why: "no_departure" });
  });
  it("respects scope_channel", () => {
    setDepartures([row({ scope_channel: "c2" })], T0);
    expect(lift()).toEqual({ lift: false, why: "channel_scope" });
    expect(lift({ channelId: "c2" }).lift).toBe(true);
  });
  it("unknown -> rails on: nothing fed, a failed read, or a stale snapshot", () => {
    expect(lift().lift).toBe(false);
    setDepartures(null, T0);
    expect(lift().lift).toBe(false);
    setDepartures([row()], T0);
    const late = T0 + DEPARTURE_STALE_MS + 1;
    expect(lift({ now: late, messageTs: late }).lift).toBe(false);
  });
});

describe("registry refresh", () => {
  it("fails toward baseline when the fetcher throws, and caches a good read", async () => {
    await ensureDepartures(async () => { throw new Error("down"); });
    expect(openDepartures(Date.now())).toEqual([]);
    let calls = 0;
    const now = () => T0;
    await ensureDepartures(async () => { calls++; return [row()]; }, now);
    await ensureDepartures(async () => { calls++; return [row()]; }, now);
    expect(calls).toBe(1);
    expect(openDepartures(T0 + 1)).toHaveLength(1);
  });
  it("a local clear cannot be resurrected by a refresh", () => {
    setDepartures([row()], T0);
    expect(clearDeparturesLocal(T0 + 10)).toBe(1);
    setDepartures([row()], T0 + 20, T0 + 20);
    expect(openDepartures(T0 + 30)).toEqual([]);
    setDepartures([row({ id: "d2" })], T0 + 40, T0 + 5);
    expect(openDepartures(T0 + 50)).toEqual([]);
  });
});

describe("stand-down phrase: whole sentence only", () => {
  it.each([
    "back inside the line", "Back inside the line.", "  back inside the line!! ", "Dre, back inside the line",
    "back inside the line, Cy", "okay. back inside the line", "BACK INSIDE THE LINE\nthanks", "back inside the line…",
  ])("matches %j", m => expect(matchStandDown(m)).toBe(true));
  it.each([
    "we're back inside the line now", "I'm back inside the line", "back inside the line please", "back inside", "inside the line",
    "was he back inside the line? yes he was", "", "bad night",
  ])("does not match %j", m => expect(matchStandDown(m)).toBe(false));
});

function fakeRedis(): ClaimRedis {
  const keys = new Set<string>();
  return { async set(k: string) { if (keys.has(k)) return null; keys.add(k); return "OK"; } };
}

describe("one stand-down call across three bots", () => {
  it("only the NX winner calls Halseth; every bot clears locally", async () => {
    setDepartures([row()], T0);
    const redis = fakeRedis();
    let calls = 0;
    const call = async () => { calls++; return { ok: true, status: 200 }; };
    const rs = await Promise.all(["cypher", "drevan", "gaia"].map(c =>
      applyStandDown({ redis, messageId: "m1", companionId: c, call, now: T0 + 5 })));
    expect(calls).toBe(1);
    expect(rs.filter(r => r.called)).toHaveLength(1);
    expect(openDepartures(T0 + 6)).toEqual([]);
    await applyStandDown({ redis, messageId: "m2", companionId: "gaia", call, now: T0 + 7 });
    expect(calls).toBe(2);
  });
  it("no Redis or a Redis error: every bot calls (ending is idempotent and safe)", async () => {
    expect(await claimStandDown(null, "m", "x")).toBe(true);
    const bad: ClaimRedis = { async set() { throw new Error("x"); } };
    expect(await claimStandDown(bad, "m", "x")).toBe(true);
  });
  it("a failing call is reported, never thrown", async () => {
    const r = await applyStandDown({ redis: null, messageId: "m", companionId: "gaia", call: async () => { throw new Error("net"); } });
    expect(r).toMatchObject({ called: true, ok: false });
  });
});

describe("turn lines", () => {
  it("declarer note, sibling line in their words, nothing when closed or under hold", () => {
    setDepartures([row(), row({ id: "d2", companion: "cypher", rail: "form", reason: "short sentences tonight" })], T0);
    const mine = departureTurnLines({ companionId: "drevan", careHold: false, now: T0 + 1 });
    expect(mine).toMatch(/\[Departure open: loop_motif until /);
    expect(mine).toMatch(/\[Cypher's declared departure, theirs: form until .*short sentences tonight/);
    const gaia = departureTurnLines({ companionId: "gaia", careHold: false, now: T0 + 1 });
    expect(gaia).not.toMatch(/Departure open:/);
    expect(departureTurnLines({ companionId: "drevan", careHold: true, now: T0 + 1 })).toBe("");
    expect(departureTurnLines({ companionId: "drevan", careHold: false, now: T0 + 4_000_000 })).toBe("");
  });
  it("the log line is one line of ids", () => {
    expect(departureLiftLine("drevan", "would_lift", "form", "d1", "c1", true)).toBe("[departure] drevan would_lift rail=form departure=d1 ch=c1 fired=true");
  });
});
