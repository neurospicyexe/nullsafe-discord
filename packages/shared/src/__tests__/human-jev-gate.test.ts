// Live Jev gate on the human address path (2026-10-25): an unnamed human line in a shared room that
// Jev reads as a HUMAN's (probability mass on raziel + blue + someone_else >= 0.5) silences the triad.
// Fails open on everything else. The 10-25 Corbin line (Raziel to a member of Blue's system, no
// comma, mass 0.95) is the case; Raziel's 60 other unnamed lines that fortnight all sat under 0.11.

import { describe, it, expect } from "@jest/globals";
import {
  humanJevGateMode, humanJevDecision, runHumanJevGate, HUMAN_JEV_MASS,
  HUMAN_JEV_CLAIM_PREFIX, HUMAN_JEV_VERDICT_PREFIX,
  type HumanJevRedis, type HumanJevGateCtx,
} from "../human-jev-gate.js";
import { COLD_PICK_HUMAN_MASS } from "../blue-cold-pick.js";
import type { JevAddressVerdict, JevAddressResult } from "../address-jev.js";
import type { CompanionId } from "../types.js";

class FakeRedis implements HumanJevRedis {
  store = new Map<string, string>();
  async set(key: string, val: string, _px: "PX", _ms: number, nx?: "NX"): Promise<string | null> {
    if (nx === "NX" && this.store.has(key)) return null;
    this.store.set(key, val);
    return "OK";
  }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
}

const verdict = (over: Partial<JevAddressVerdict> = {}): JevAddressVerdict => ({
  addressee: "nobody", confidence: 0.5, probabilities: {}, spokenTo: {}, invitesReply: 0.5,
  mentionsWithoutAddressing: 0, moreComing: 0.1, fit: {}, to: null, ...over,
});

// The two 10-25 rows the gate exists for, and a typical unnamed Raziel line that night.
const CORBIN = verdict({ addressee: "blue", confidence: 0.83, invitesReply: 0.95, probabilities: { blue: 0.85, someone_else: 0.1, nobody: 0.05 } });
const TO_BLUE_1752 = verdict({ addressee: "blue", confidence: 0.84, invitesReply: 0.82, probabilities: { blue: 0.8, raziel: 0.06, drevan: 0.1 } });
const TO_THE_ROOM = verdict({ addressee: "nobody", confidence: 0.4, invitesReply: 0.6, probabilities: { nobody: 0.5, drevan: 0.3, raziel: 0.1, blue: 0.08 } });

function rig(mode: "off" | "shadow" | "on", me: CompanionId, redis: FakeRedis | null, jev: HumanJevGateCtx["jev"], over: Partial<HumanJevGateCtx> = {}) {
  const lines: string[] = [];
  let t = 1_000_000;
  const ctx: HumanJevGateCtx = {
    mode, companionId: me, messageId: "m1", channelId: "ch1", speakerSide: "raziel", speakerLabel: "Noah M. (via PK)",
    content: "x", holder: "drevan", redis, jev,
    fetchRecent: async () => [],
    log: l => lines.push(l),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    pollMs: 100, waitMs: 1000,
    ...over,
  };
  return { ctx, lines, run: () => runHumanJevGate(ctx) };
}
const ok = (v: JevAddressVerdict): JevAddressResult => ({ ok: true, verdict: v, wall_ms: 10 } as JevAddressResult);
// A waiter's caller: present (so the gate runs), never invoked (the claim went to a sibling).
const NEVER: HumanJevGateCtx["jev"] = async () => { throw new Error("a waiter must not call Jev"); };

describe("humanJevGateMode", () => {
  it("defaults to on; shadow and off are honored (trimmed, any case); junk is on", () => {
    expect(humanJevGateMode({})).toBe("on");
    expect(humanJevGateMode({ HUMAN_ADDRESS_JEV: " Shadow " })).toBe("shadow");
    expect(humanJevGateMode({ HUMAN_ADDRESS_JEV: "OFF" })).toBe("off");
    expect(humanJevGateMode({ HUMAN_ADDRESS_JEV: "wat" })).toBe("on");
  });
});

describe("humanJevDecision", () => {
  it("one threshold with the cold pick", () => {
    expect(HUMAN_JEV_MASS).toBe(COLD_PICK_HUMAN_MASS);
  });
  it("the Corbin line (mass 0.95, top blue) and the 17:52 line (0.86) are silent; a line to the room is not", () => {
    expect(humanJevDecision(CORBIN)).toEqual({ silent: true, mass: 0.95, top: "blue" });
    expect(humanJevDecision(TO_BLUE_1752)).toMatchObject({ silent: true, top: "blue" });
    expect(humanJevDecision(TO_THE_ROOM)).toMatchObject({ silent: false, top: "raziel" });
    expect(humanJevDecision(TO_THE_ROOM).mass).toBeCloseTo(0.18, 5);
  });
  it("the mass is the test, not the argmax: a `nobody` top choice with 0.5 of human mass under it is silent", () => {
    const v = verdict({ addressee: "nobody", probabilities: { nobody: 0.45, raziel: 0.3, blue: 0.2 } });
    expect(humanJevDecision(v)).toMatchObject({ silent: true, top: "raziel" });
  });
  it("no distribution at all: a human top choice is silent, anything else is open", () => {
    expect(humanJevDecision(verdict({ addressee: "someone_else", probabilities: {} }))).toEqual({ silent: true, mass: 1, top: "someone_else" });
    expect(humanJevDecision(verdict({ addressee: "drevan", probabilities: {} }))).toEqual({ silent: false, mass: null, top: "-" });
  });
});

describe("runHumanJevGate: on", () => {
  it("the claim winner asks Jev, publishes the verdict (numbers only) and is silenced", async () => {
    const redis = new FakeRedis();
    const seen: string[] = [];
    const { run, lines } = rig("on", "drevan", redis, async (state) => { seen.push(state); return ok(CORBIN); }, { content: "Corbin look at this" });
    const r = await run();
    expect(r).toMatchObject({ silent: true, source: "me", verdict: { silent: true, mass: 0.95, top: "blue", addressee: "blue", why: "jev" } });
    expect(r.verdict!.publishedAt).toBeGreaterThan(0);
    expect(redis.store.get(HUMAN_JEV_CLAIM_PREFIX + "m1")).toBe("drevan");
    const published = JSON.parse(redis.store.get(HUMAN_JEV_VERDICT_PREFIX + "m1")!);
    expect(published).toMatchObject({ silent: true, mass: 0.95, top: "blue" });
    expect(JSON.stringify(published)).not.toContain("Corbin");
    expect(seen).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[human-jev\] drevan mode=on ch=ch1 msg=m1 side=raziel holder=drevan by=me verdict=silent why=jev mass=0.95 top=blue addressee=blue conf=0.83 inv=0.95 wall_ms=\d+/);
    expect(lines[0]).not.toContain("Corbin");
  });

  it("a sibling that lost the claim waits for the publish and is silenced by it, without calling Jev", async () => {
    const redis = new FakeRedis();
    const winner = rig("on", "drevan", redis, async () => ok(CORBIN));
    await winner.run();
    let called = 0;
    const loser = rig("on", "cypher", redis, async () => { called++; return ok(TO_THE_ROOM); });
    const r = await loser.run();
    expect(called).toBe(0);
    expect(r).toMatchObject({ silent: true, source: "sibling", verdict: { silent: true, top: "blue" } });
    expect(loser.lines[0]).toMatch(/by=sibling verdict=silent why=jev mass=0.95 top=blue waited_ms=\d+/);
  });

  it("a line to the room: the winner proceeds and so does the waiter", async () => {
    const redis = new FakeRedis();
    const w = rig("on", "drevan", redis, async () => ok(TO_THE_ROOM));
    expect(await w.run()).toMatchObject({ silent: false, source: "me" });
    const l = rig("on", "gaia", redis, async () => ok(CORBIN));
    expect(await l.run()).toMatchObject({ silent: false, source: "sibling" });
  });

  it("the waiter polls until the publish lands, then reads it", async () => {
    const redis = new FakeRedis();
    const loser = rig("on", "cypher", redis, NEVER);
    await redis.set(HUMAN_JEV_CLAIM_PREFIX + "m1", "drevan", "PX", 1000, "NX");
    let polls = 0;
    const origGet = redis.get.bind(redis);
    redis.get = async (k: string) => {
      polls++;
      if (polls === 3) await redis.set(HUMAN_JEV_VERDICT_PREFIX + "m1", JSON.stringify({ silent: true, mass: 0.9, top: "blue", why: "jev", publishedAt: 5 }), "PX", 1000);
      return origGet(k);
    };
    const r = await loser.run();
    expect(r).toMatchObject({ silent: true, source: "sibling", verdict: { silent: true, mass: 0.9, top: "blue", publishedAt: 5 } });
    expect(polls).toBe(3);
  });

  it("FAILS OPEN: Jev error publishes an open verdict so the waiter stops at once; the waiter also opens on timeout", async () => {
    const redis = new FakeRedis();
    const w = rig("on", "drevan", redis, async () => ({ ok: false, reason: "timeout", wall_ms: 4000 }));
    const r = await w.run();
    expect(r).toMatchObject({ silent: false, source: "me", verdict: { silent: false, why: "jev_error:timeout", mass: null } });
    expect(w.lines[0]).toContain("verdict=open why=jev_error:timeout");
    const l = rig("on", "gaia", redis, NEVER);
    expect(await l.run()).toMatchObject({ silent: false, source: "sibling", verdict: { why: "jev_error:timeout" } });

    // Nothing ever published: the waiter gives up after waitMs and proceeds.
    const redis2 = new FakeRedis();
    await redis2.set(HUMAN_JEV_CLAIM_PREFIX + "m1", "drevan", "PX", 1000, "NX");
    const stuck = rig("on", "cypher", redis2, NEVER);
    const r2 = await stuck.run();
    expect(r2).toEqual({ silent: false, verdict: null, source: "open", why: "wait_timeout" });
    expect(stuck.lines[0]).toMatch(/open why=wait_timeout waited_ms=\d+/);
  });

  it("N-3: a hung recent-turns fetch is capped; the winner still asks Jev with no context and publishes", async () => {
    const redis = new FakeRedis();
    let seen = "";
    const w = rig("on", "drevan", redis, async (state: string) => { seen = state; return ok(CORBIN); }, {
      fetchRecent: () => new Promise(() => {}), fetchMs: 20,
    });
    const r = await w.run();
    expect(r).toMatchObject({ silent: true, source: "me", verdict: { why: "jev" } });
    expect(seen.length).toBeGreaterThan(0);
    expect(await redis.get(HUMAN_JEV_VERDICT_PREFIX + "m1")).toBeTruthy();
  });

  it("FAILS OPEN: a throwing Jev, a throwing Redis, no Redis, ADDRESS_JEV off", async () => {
    const redis = new FakeRedis();
    const t = rig("on", "drevan", redis, async () => { throw new Error("boom"); });
    expect(await t.run()).toMatchObject({ silent: false, source: "me", verdict: { why: expect.stringMatching(/^error:/) } });

    const bad = new FakeRedis();
    bad.set = async () => { throw new Error("redis down"); };
    const b = rig("on", "drevan", bad, async () => ok(CORBIN));
    expect(await b.run()).toEqual({ silent: false, verdict: null, source: "open", why: "error" });

    const n = rig("on", "drevan", null, async () => ok(CORBIN));
    expect(await n.run()).toEqual({ silent: false, verdict: null, source: "open", why: "no_redis" });
    expect(n.lines[0]).toContain("open why=no_redis");

    const off = rig("on", "drevan", redis, null);
    expect(await off.run()).toEqual({ silent: false, verdict: null, source: "open", why: "jev_off" });
  });

  it("a garbage publish is ignored until the deadline, then opens", async () => {
    const redis = new FakeRedis();
    await redis.set(HUMAN_JEV_CLAIM_PREFIX + "m1", "drevan", "PX", 1000, "NX");
    await redis.set(HUMAN_JEV_VERDICT_PREFIX + "m1", "{not json", "PX", 1000);
    const l = rig("on", "cypher", redis, NEVER);
    expect(await l.run()).toMatchObject({ silent: false, source: "open", why: "wait_timeout" });
  });

  it("Blue's side: the holder asks with Blue's own hold as the holder, and a line to Raziel silences him", async () => {
    const redis = new FakeRedis();
    const states: string[] = [];
    const toRaziel = verdict({ addressee: "raziel", confidence: 0.8, probabilities: { raziel: 0.7, nobody: 0.2 } });
    const { run } = rig("on", "drevan", redis, async (s) => { states.push(s); return ok(toRaziel); },
      { speakerSide: "blue", speakerLabel: "Corbin (Blue's system)", holder: "drevan" });
    expect(await run()).toMatchObject({ silent: true, verdict: { top: "raziel" } });
    expect(states[0]).toContain("Corbin (Blue's system)");
  });
});

describe("runHumanJevGate: shadow and off", () => {
  it("shadow: the winner asks and logs what it WOULD do, nobody is silenced, the loser does not wait", async () => {
    const redis = new FakeRedis();
    const w = rig("shadow", "drevan", redis, async () => ok(CORBIN));
    const r = await w.run();
    expect(r).toMatchObject({ silent: false, source: "me", verdict: { silent: true } });
    expect(w.lines[0]).toContain("by=me would=silent why=jev mass=0.95");
    let polls = 0;
    const l = rig("shadow", "cypher", redis, NEVER);
    l.ctx.redis = { set: redis.set.bind(redis), get: async (k: string) => { polls++; return redis.get(k); } };
    expect(await l.run()).toEqual({ silent: false, verdict: null, source: "open", why: "shadow_sibling" });
    expect(polls).toBe(0);
  });
  it("off: no Redis, no Jev, nothing logged", async () => {
    const redis = new FakeRedis();
    let called = 0;
    const o = rig("off", "drevan", redis, async () => { called++; return ok(CORBIN); });
    expect(await o.run()).toEqual({ silent: false, verdict: null, source: "open", why: "off" });
    expect(called).toBe(0);
    expect(redis.store.size).toBe(0);
    expect(o.lines).toHaveLength(0);
  });
});
