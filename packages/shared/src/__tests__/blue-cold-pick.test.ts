// Ruling 4 (Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md): a cold, unnamed Blue message with no
// holder gets ONE companion, picked by Jev. Shadow first: log the pick, nobody speaks.

import {
  blueColdPickMode, pickColdCompanion, runBlueColdPick, BLUE_COLD_CLAIM_PREFIX,
  type BlueColdRedis,
} from "../blue-cold-pick.js";
import type { JevAddressVerdict } from "../address-jev.js";
import type { CompanionId } from "../types.js";

class FakeRedis implements BlueColdRedis {
  store = new Map<string, string>();
  async set(key: string, val: string, _px: "PX", _ms: number, nx?: "NX"): Promise<string | null> {
    if (nx === "NX" && this.store.has(key)) return null;
    this.store.set(key, val);
    return "OK";
  }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
}

const verdict = (over: Partial<JevAddressVerdict> = {}): JevAddressVerdict => ({
  addressee: "room", confidence: 0.8, probabilities: {}, spokenTo: {}, invitesReply: 0.9,
  mentionsWithoutAddressing: 0, moreComing: 0.1, fit: {}, to: "room", ...over,
});

describe("blueColdPickMode", () => {
  it("defaults to shadow; on and off are honored (trimmed, any case); junk is shadow", () => {
    expect(blueColdPickMode({})).toBe("shadow");
    expect(blueColdPickMode({ BLUE_COLD_PICK: " ON " })).toBe("on");
    expect(blueColdPickMode({ BLUE_COLD_PICK: "off" })).toBe("off");
    expect(blueColdPickMode({ BLUE_COLD_PICK: "wat" })).toBe("shadow");
  });
});

describe("pickColdCompanion", () => {
  it("picks the companion with the strongest spoken-to / has-something blend", () => {
    const v = verdict({ spokenTo: { cypher: 0.1, drevan: 0.2, gaia: 0.1 }, fit: { cypher: 0.2, drevan: 0.9, gaia: 0.3 } });
    expect(pickColdCompanion(v)).toBe("drevan");
  });
  it("a human or nobody addressee is no pick (Blue talking to Raziel is not the triad's)", () => {
    for (const addressee of ["raziel", "nobody", "someone_else", "blue"] as const) {
      expect(pickColdCompanion(verdict({ addressee, fit: { drevan: 0.9 } }))).toBeNull();
    }
  });
  it("a line that does not invite a reply is no pick", () => {
    expect(pickColdCompanion(verdict({ invitesReply: 0.1, fit: { gaia: 0.9 } }))).toBeNull();
  });
  it("nothing clears the floor = no pick; no signals at all = no pick", () => {
    expect(pickColdCompanion(verdict({ fit: { cypher: 0.05, drevan: 0.1, gaia: 0.05 } }))).toBeNull();
    expect(pickColdCompanion(verdict())).toBeNull();
  });
  it("a tie breaks deterministically", () => {
    const v = verdict({ fit: { cypher: 0.8, drevan: 0.8, gaia: 0.8 } });
    expect(pickColdCompanion(v)).toBe(pickColdCompanion(v));
  });
});

function rig(mode: "shadow" | "on" | "off", v: JevAddressVerdict | null = verdict({ fit: { cypher: 0.2, drevan: 0.9, gaia: 0.3 } })) {
  const redis = new FakeRedis();
  const logs: string[] = [];
  let jevCalls = 0;
  const jev = async () => {
    jevCalls++;
    return v ? { ok: true as const, verdict: v, latency_ms: 5, wall_ms: 6 } : { ok: false as const, reason: "timeout", wall_ms: 4000 };
  };
  const run = (companionId: CompanionId, msgId = "m1") => runBlueColdPick({
    mode, companionId, messageId: msgId, channelId: "ch1", speaker: "Sora (Blue's system)", content: "anyone up?",
    redis, jev, fetchRecent: async () => [], log: (l) => logs.push(l),
    sleep: async () => {}, pollMs: 1, waitMs: 20,
  });
  return { redis, logs, run, jevCalls: () => jevCalls };
}

describe("runBlueColdPick", () => {
  it("(e) shadow: logs the pick (ids only), calls Jev once across three bots, and NOBODY speaks", async () => {
    const r = rig("shadow");
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.every(x => x.speak === false)).toBe(true);
    expect(r.jevCalls()).toBe(1);
    const lines = r.logs.filter(l => l.startsWith("[blue-cold]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/pick=drevan/);
    expect(lines[0]).toMatch(/mode=shadow/);
    expect(lines[0]).toMatch(/msg=m1/);
    expect(lines[0]).not.toMatch(/anyone up/);          // never the text
  });

  it("(e) on: exactly ONE companion speaks (the picked one), one Jev call", async () => {
    const r = rig("on");
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.filter(x => x.speak).length).toBe(1);
    expect(results[1]!.speak).toBe(true);               // drevan
    expect(r.jevCalls()).toBe(1);
  });

  it("on: a replay of the same message cannot make the picked companion answer twice", async () => {
    const r = rig("on");
    const first = await r.run("drevan");
    const again = await r.run("drevan");
    expect(first.speak).toBe(true);
    expect(again.speak).toBe(false);
  });

  it("on: Jev says none -> nobody speaks", async () => {
    const r = rig("on", verdict({ addressee: "raziel" }));
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.some(x => x.speak)).toBe(false);
    expect(r.logs.some(l => /pick=none/.test(l))).toBe(true);
  });

  it("on: Jev fails -> today's silence (nobody speaks), logged as none with the reason", async () => {
    const r = rig("on", null);
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.some(x => x.speak)).toBe(false);
    expect(r.logs.some(l => /pick=none/.test(l) && /why=timeout/.test(l))).toBe(true);
  });

  it("off: no Jev call, no Redis write, nobody speaks", async () => {
    const r = rig("off");
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.some(x => x.speak)).toBe(false);
    expect(r.jevCalls()).toBe(0);
    expect(r.redis.store.size).toBe(0);
  });

  it("no Redis: nobody speaks and Jev is not called (a claim cannot be made)", async () => {
    const logs: string[] = [];
    let calls = 0;
    const res = await runBlueColdPick({
      mode: "on", companionId: "drevan", messageId: "m2", channelId: "ch1", speaker: "x", content: "y",
      redis: null, jev: async () => { calls++; return { ok: false, reason: "x", wall_ms: 0 }; },
      fetchRecent: async () => [], log: (l) => logs.push(l),
    });
    expect(res.speak).toBe(false);
    expect(calls).toBe(0);
  });

  it("a claim key exists per message", async () => {
    const r = rig("shadow");
    await r.run("cypher", "m9");
    expect(r.redis.store.has(BLUE_COLD_CLAIM_PREFIX + "m9")).toBe(true);
  });
});
