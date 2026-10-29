// Ruling 4 (Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md): a cold, unnamed Blue message with no
// holder gets ONE companion, picked by Jev. Shadow first: log the pick, nobody speaks.
// 2026-10-25 revision (Raziel: Blue should not have to name a companion): Jev's human MASS and
// invites_reply are the two gates; `nobody`/`room`/`continuing` fall through; the host wins a hosted
// room; a pick never leaves the channel's seated companions.

import {
  blueColdPickMode, pickColdCompanion, coldPickDecision, humanMass, runBlueColdPick, BLUE_COLD_CLAIM_PREFIX,
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
  it("defaults to on (2026-10-29); shadow and off are honored (trimmed, any case); junk is the default", () => {
    expect(blueColdPickMode({})).toBe("on");
    expect(blueColdPickMode({ BLUE_COLD_PICK: " ON " })).toBe("on");
    expect(blueColdPickMode({ BLUE_COLD_PICK: " Shadow " })).toBe("shadow");
    expect(blueColdPickMode({ BLUE_COLD_PICK: "off" })).toBe("off");
    expect(blueColdPickMode({ BLUE_COLD_PICK: "wat" })).toBe("on");
  });
});

describe("pickColdCompanion", () => {
  it("picks the companion with the strongest spoken-to / has-something blend (why=fit)", () => {
    const v = verdict({ spokenTo: { cypher: 0.1, drevan: 0.2, gaia: 0.1 }, fit: { cypher: 0.2, drevan: 0.9, gaia: 0.3 } });
    expect(pickColdCompanion(v)).toBe("drevan");
    expect(coldPickDecision(v).why).toBe("fit");
  });
  it("a line spoken to a human is no pick: the gate is the human probability MASS, not the top choice", () => {
    // Top choice `nobody`, but Raziel carries 0.45 and Blue 0.1: a question to Raziel under a `nobody` argmax.
    const toRaziel = verdict({ addressee: "nobody", probabilities: { nobody: 0.4, raziel: 0.45, blue: 0.1 }, fit: { drevan: 0.9 } });
    expect(coldPickDecision(toRaziel)).toMatchObject({ pick: null, why: "human:raziel", human: 0.55 });
    for (const addressee of ["raziel", "someone_else", "blue"] as const) {
      expect(pickColdCompanion(verdict({ addressee, probabilities: { [addressee]: 0.7 }, fit: { drevan: 0.9 } }))).toBeNull();
    }
  });
  it("a human TOP choice with little mass behind it falls through (10-25 row: someone_else at 0.44, invites 0.52)", () => {
    const v = verdict({ addressee: "someone_else", confidence: 0.37, invitesReply: 0.52,
      probabilities: { someone_else: 0.44, nobody: 0.3, raziel: 0.01, blue: 0.02 }, fit: { drevan: 0.66 }, spokenTo: { drevan: 0.07 } });
    expect(coldPickDecision(v)).toMatchObject({ pick: "drevan", why: "fit" });
  });
  it("no distribution at all: a human top choice counts as the human's; a triad/room/nobody top choice does not", () => {
    expect(humanMass(verdict({ addressee: "raziel", probabilities: {} }))).toEqual({ sum: 1, top: "raziel" });
    expect(humanMass(verdict({ addressee: "nobody", probabilities: {} }))).toEqual({ sum: null, top: "-" });
    expect(pickColdCompanion(verdict({ addressee: "raziel", probabilities: {}, fit: { drevan: 0.9 } }))).toBeNull();
  });
  it("`nobody`, `room` and `continuing` are not answers by name: they fall through to invites + the pick", () => {
    for (const addressee of ["nobody", "room", "continuing"] as const) {
      const v = verdict({ addressee, probabilities: { [addressee]: 0.6, raziel: 0.1 }, invitesReply: 0.9, fit: { drevan: 0.9 } });
      expect(pickColdCompanion(v)).toBe("drevan");
    }
  });
  it("the 10-25 #movie-night cold rows: the three that invited a reply go to the host, the three reactions sit", () => {
    const rows: Array<[number, number, string | null]> = [
      // invites, human mass, expected pick (host room, drevan)
      [0.11, 0.18, null], [0.11, 0.16, null], [0.54, 0.18, "drevan"], [0.17, 0.17, null], [0.90, 0.39, "drevan"], [0.52, 0.47, "drevan"],
    ];
    for (const [inv, mass, expected] of rows) {
      const v = verdict({ addressee: "nobody", invitesReply: inv, probabilities: { nobody: 1 - mass, raziel: mass },
        spokenTo: { drevan: 0.2 }, fit: { drevan: 0.6, gaia: 0.62 } });
      expect(pickColdCompanion(v, { host: "drevan" })).toBe(expected);
    }
  });
  it("a line that does not invite a reply is no pick", () => {
    expect(coldPickDecision(verdict({ invitesReply: 0.1, fit: { gaia: 0.9 } }))).toMatchObject({ pick: null, why: "no_invite" });
  });
  it("a hosted room is the host's once the line clears the gates, even when a sibling fits better", () => {
    const v = verdict({ fit: { cypher: 0.2, drevan: 0.3, gaia: 0.9 } });
    expect(coldPickDecision(v, { host: "drevan" })).toMatchObject({ pick: "drevan", why: "host" });
    expect(pickColdCompanion(v)).toBe("gaia");
  });
  it("a companion Jev reads as called without a name beats the host (spoken_to >= theta)", () => {
    const v = verdict({ addressee: "gaia", spokenTo: { gaia: 0.7, drevan: 0.1 }, fit: { gaia: 0.5 } });
    expect(coldPickDecision(v, { host: "drevan" })).toMatchObject({ pick: "gaia", why: "spoken_to" });
    // ...but only when the room seats that companion.
    expect(coldPickDecision(v, { host: "drevan", eligible: ["drevan"] })).toMatchObject({ pick: "drevan", why: "host" });
  });
  it("a pick never leaves the channel's seated companions (a Drevan-only room cannot publish a Cypher pick)", () => {
    const v = verdict({ fit: { cypher: 0.95, drevan: 0.4, gaia: 0.3 } });
    expect(pickColdCompanion(v, { eligible: ["drevan"] })).toBe("drevan");
    expect(pickColdCompanion(v, { eligible: ["drevan", "gaia"] })).toBe("drevan");
    expect(pickColdCompanion(v, { eligible: [] })).toBeNull();
    // A host that is not seated is ignored, not picked.
    expect(pickColdCompanion(v, { eligible: ["gaia"], host: "drevan" })).toBe("gaia");
  });
  it("nothing clears the floor = no pick; no signals at all = no pick", () => {
    expect(coldPickDecision(verdict({ fit: { cypher: 0.05, drevan: 0.1, gaia: 0.05 } }))).toMatchObject({ pick: null, why: "below_floor" });
    expect(coldPickDecision(verdict())).toMatchObject({ pick: null, why: "no_signal" });
  });
  it("a tie breaks deterministically", () => {
    const v = verdict({ fit: { cypher: 0.8, drevan: 0.8, gaia: 0.8 } });
    expect(pickColdCompanion(v)).toBe(pickColdCompanion(v));
  });
});

function rig(
  mode: "shadow" | "on" | "off",
  v: JevAddressVerdict | null = verdict({ fit: { cypher: 0.2, drevan: 0.9, gaia: 0.3 } }),
  room: { host?: CompanionId | null; eligible?: readonly CompanionId[] } = {},
) {
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
    sleep: async () => {}, pollMs: 1, waitMs: 20, ...room,
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

  it("on: Jev says a human's -> nobody speaks; the log carries inv= human= host=", async () => {
    const r = rig("on", verdict({ addressee: "raziel", probabilities: { raziel: 0.8 }, invitesReply: 0.9 }));
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.some(x => x.speak)).toBe(false);
    const line = r.logs.find(l => /pick=none/.test(l));
    expect(line).toMatch(/why=human:raziel/);
    expect(line).toMatch(/inv=0\.90/);
    expect(line).toMatch(/human=0\.80/);
    expect(line).toMatch(/host=-/);
  });

  it("on: in a hosted room the host answers a cold line (one speaker), and the log says why=host", async () => {
    const r = rig("on", verdict({ addressee: "nobody", probabilities: { nobody: 0.6, raziel: 0.16 }, invitesReply: 0.54,
      spokenTo: { drevan: 0.13 }, fit: { gaia: 0.62, drevan: 0.6 } }), { host: "drevan" });
    const results = await Promise.all((["cypher", "drevan", "gaia"] as CompanionId[]).map(c => r.run(c)));
    expect(results.filter(x => x.speak).length).toBe(1);
    expect(results[1]!.speak).toBe(true);               // drevan, the host, not gaia (the better fit)
    expect(r.logs.some(l => /pick=drevan/.test(l) && /why=host/.test(l) && /host=drevan/.test(l))).toBe(true);
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
