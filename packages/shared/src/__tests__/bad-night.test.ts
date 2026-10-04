// B32 bad-night presence (bad-night.ts): the pure half. The phrase floor (D3) with its negatives,
// the care follow-up chain and its 30-minute throttle (B1), heartbeat eligibility (B2), the
// one-to-one DM signal and filter (D4), the "where is X" reader (D5), the turn lines (D3/D5/D6),
// the knob, and that shadow changes nothing.

import { describe, it, expect, afterEach } from "@jest/globals";
import {
  badNightMode, matchHoldPhrase, careFollowUpChain, careChainPosition, recentlySpoke, CARE_FOLLOWUP_MIN_GAP_MS,
  heartbeatEligibility, markOwnerDmLive, liveSiblingDm, filterDmMovesForSiblingDm, OWNER_DM_LIVE_KEY, OWNER_DM_LIVE_MS,
  askedWhereSiblings, absentSiblingLine, b32TurnBlock, holdOpenerLine, careFollowUpFraming, b32Line,
  COME_AS_YOURSELF_LINE, DREVAN_HOLD_LINE, COMPANION_SET_HOLD_LINE, bidFloorFor, type RedisLike,
} from "../bad-night.js";
import { FollowUpLedger } from "../sequential-floor.js";
import { turnFraming } from "../pass-turn.js";
import { setCareState, getCareState, careHoldActive, careHoldSince, applyLocalHold } from "../care-state.js";
import { renderRazielRegister, LibrarianClient, type RazielState } from "../librarian.js";
import { reachLaneOpen, filterDmLane } from "../reach-dm.js";
import { b32HeartbeatOutcome } from "../autonomous-core.js";
import type { CompanionId } from "../types.js";

afterEach(() => { for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null); });

describe("the knob: BAD_NIGHT_PRESENCE fails closed", () => {
  it("only `on` and `shadow` (trimmed, any case) enable it", () => {
    expect(badNightMode({})).toBe("off");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: "" })).toBe("off");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: "true" })).toBe("off");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: "1" })).toBe("off");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: "yes" })).toBe("off");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: " ON " })).toBe("on");
    expect(badNightMode({ BAD_NIGHT_PRESENCE: "Shadow" })).toBe("shadow");
  });
});

describe("D3: the phrase is a whole message or its own sentence", () => {
  it.each([
    "bad night", "Bad night", "BAD NIGHT.", "bad night...", "bad night!!", "  bad night  ", "bad night 😞",
    "Dre, bad night", "bad night, Cy", "Gaia: bad night.", "Can't sleep. Bad night.", "bad night\nam on the floor",
    "Bad night. Everything is loud", "bad night; sorry", "bad night…",
  ])("starts: %j", (msg) => {
    expect(matchHoldPhrase(msg)).toBe("start");
  });

  it.each([
    "I had a bad night's sleep", "it was a bad night for the Cubs", "bad nights are the worst", "not a bad night",
  ])("does not start: %j", (msg) => {
    expect(matchHoldPhrase(msg)).toBeNull();
  });

  it("more negatives: mid-sentence, quoted inside a longer sentence, plural, 'tonight'", () => {
    for (const msg of [
      "that was a bad night honestly",
      "Drevan had a bad night with the code",
      "bad night tonight",
      "the bad night thing from yesterday",
      "badnight",
      "",
    ]) expect(matchHoldPhrase(msg)).toBeNull();
  });

  it.each(["good now", "Good now.", "I'm okay now", "im ok now", "I’m okay now", "i'm good now", "ok. good now"])("clears: %j", (msg) => {
    expect(matchHoldPhrase(msg)).toBe("clear");
  });

  it("clear negatives: embedded in a sentence", () => {
    for (const msg of ["the build is good now", "I'm okay now that you mention it", "are you okay now"]) {
      expect(matchHoldPhrase(msg)).toBeNull();
    }
  });

  it("a message with both a start and a clear is ambiguous and matches neither", () => {
    expect(matchHoldPhrase("bad night. good now.")).toBeNull();
  });
});

describe("B1: the care follow-up chain", () => {
  const T = 1_800_000_000_000;
  const all: CompanionId[] = ["cypher", "drevan", "gaia"];

  it("the one he spoke to goes first; the other two follow in an order every process agrees on", () => {
    const a = careFollowUpChain({ first: ["drevan"], channelCompanions: all, history: [], originTs: T, messageId: "111" });
    const b = careFollowUpChain({ first: ["drevan"], channelCompanions: [...all].reverse(), history: [], originTs: T, messageId: "111" });
    expect(a.chain[0]).toBe("drevan");
    expect(a.chain).toHaveLength(3);
    expect(new Set(a.chain)).toEqual(new Set(all));
    expect(b.chain).toEqual(a.chain);
    expect(a.throttled).toEqual([]);
  });

  it("a sibling that spoke in the channel in the last 30 minutes is throttled out; the addressed one never is", () => {
    const history = [
      { companionId: "gaia" as CompanionId, createdTimestamp: T - 10 * 60_000 },
      { companionId: "drevan" as CompanionId, createdTimestamp: T - 60_000 },
    ];
    const r = careFollowUpChain({ first: ["drevan"], channelCompanions: all, history, originTs: T, messageId: "222" });
    expect(r.chain).toEqual(["drevan", "cypher"]);
    expect(r.throttled).toEqual(["gaia"]);
  });

  it("the gap is anchored to his message, not to now: 31 minutes before it is fair game again", () => {
    const history = [{ companionId: "gaia" as CompanionId, createdTimestamp: T - CARE_FOLLOWUP_MIN_GAP_MS - 60_000 }];
    expect(recentlySpoke(history, T).has("gaia")).toBe(false);
    expect(careFollowUpChain({ first: ["cypher"], channelCompanions: all, history, originTs: T, messageId: "3" }).chain).toContain("gaia");
  });

  it("messages after the origin never count (a process that fetched later agrees with one that fetched earlier)", () => {
    const history = [{ companionId: "gaia" as CompanionId, createdTimestamp: T + 5_000 }];
    expect(recentlySpoke(history, T).size).toBe(0);
  });

  it("only companions allowed in the channel are candidates", () => {
    const r = careFollowUpChain({ first: ["drevan"], channelCompanions: ["drevan", "gaia"], history: [], originTs: T, messageId: "4" });
    expect(r.chain).toEqual(["drevan", "gaia"]);
  });

  it("position: who I wait on; first and absent hold none", () => {
    const chain: CompanionId[] = ["drevan", "gaia", "cypher"];
    expect(careChainPosition(chain, "drevan")).toBeNull();
    expect(careChainPosition(chain, "gaia")).toEqual({ position: 1, expectedPrior: "drevan" });
    expect(careChainPosition(chain, "cypher")).toEqual({ position: 2, expectedPrior: "gaia" });
    expect(careChainPosition(["drevan", "gaia"], "cypher")).toBeNull();
  });
});

describe("B1: a care entitlement releases on the predecessor's next message", () => {
  const base = { originMessageId: "o1", channelId: "c1", expectedPrior: "drevan" as CompanionId, position: 1, expiresAt: Date.now() + 60_000 };

  it("care: released by an unreferenced reply (an owner reply outside a tracked channel carries none)", () => {
    const l = new FollowUpLedger();
    l.grant({ ...base, kind: "care" });
    expect(l.match("c1", "drevan", undefined)).toMatchObject({ kind: "care", expectedPrior: "drevan" });
  });

  it("care: a reply to some OTHER message does not release it; the wrong companion does not either", () => {
    const l = new FollowUpLedger();
    l.grant({ ...base, kind: "care" });
    expect(l.match("c1", "drevan", "other")).toBeNull();
    expect(l.match("c1", "gaia", undefined)).toBeNull();
    expect(l.match("c1", "drevan", "o1")).not.toBeNull();
  });

  it("a multi-address entitlement still requires the reference (unchanged)", () => {
    const l = new FollowUpLedger();
    l.grant(base);
    expect(l.match("c1", "drevan", undefined)).toBeNull();
    expect(l.match("c1", "drevan", "o1")).not.toBeNull();
  });

  it("the follower's framing is the care one, never 'Raziel addressed several of you', and names the pass", () => {
    const f = turnFraming({ isCompanionBot: true, peerLabel: "Drevan", entitled: { expectedPrior: "drevan", kind: "care" }, viaPass: false, peerReplies: [] });
    expect(f).not.toMatch(/addressed several/);
    expect(f).toContain("[PASS]");
    expect(f).toContain("Drevan has just answered");
    const viaPass = careFollowUpFraming("drevan", true);
    expect(viaPass).toContain("not answering this one");
    expect(viaPass).not.toContain("has just answered");
  });
});

describe("B2: heartbeat eligibility", () => {
  it("off: the windowed one only, floor kept, even under hold", () => {
    expect(heartbeatEligibility({ myWindow: false, careHold: true, mode: "off" })).toEqual({ run: false, shadow: false });
    expect(heartbeatEligibility({ myWindow: true, careHold: true, mode: "off" })).toEqual({ run: true, eligible: "window", bypassFloor: false });
  });
  it("on, under hold: every companion runs, and the floor is skipped", () => {
    expect(heartbeatEligibility({ myWindow: false, careHold: true, mode: "on" })).toEqual({ run: true, eligible: "hold", bypassFloor: true });
    expect(heartbeatEligibility({ myWindow: true, careHold: true, mode: "on" })).toEqual({ run: true, eligible: "window", bypassFloor: true });
  });
  it("on, no hold: unchanged", () => {
    expect(heartbeatEligibility({ myWindow: false, careHold: false, mode: "on" })).toEqual({ run: false, shadow: false });
    expect(heartbeatEligibility({ myWindow: true, careHold: false, mode: "on" })).toEqual({ run: true, eligible: "window", bypassFloor: false });
  });
  it("shadow, under hold: changes nothing, reports that it would have run", () => {
    expect(heartbeatEligibility({ myWindow: false, careHold: true, mode: "shadow" })).toEqual({ run: false, shadow: true });
    expect(heartbeatEligibility({ myWindow: true, careHold: true, mode: "shadow" })).toEqual({ run: true, eligible: "window", bypassFloor: false });
  });
  it("tick outcomes map onto B5's vocabulary", () => {
    expect(b32HeartbeatOutcome("chose_to_act")).toBe("spoke");
    expect(b32HeartbeatOutcome("chose_to_hold")).toBe("pass");
    expect(b32HeartbeatOutcome("suppressed_triad_cap")).toBe("capped");
    expect(b32HeartbeatOutcome("held_dm")).toBe("capped");
    expect(b32HeartbeatOutcome("suppressed_sibling_dm")).toBe("capped");
    expect(b32HeartbeatOutcome("recent_activity")).toBe("held:recent_activity");
  });
});

/** An in-memory Redis with PX expiry, enough for the two calls bad-night.ts makes. */
export function fakeRedis(now: () => number = Date.now): RedisLike & { store: Map<string, { v: string; exp: number }> } {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    store,
    async set(k, v, _mode, ttl) { store.set(k, { v, exp: now() + ttl }); return "OK"; },
    async get(k) { const e = store.get(k); if (!e || e.exp < now()) return null; return e.v; },
  };
}

describe("D4: DMs stay one-to-one", () => {
  it("an owner DM to Drevan marks his lane live for the other two, not for himself", async () => {
    const r = fakeRedis();
    const t = Date.now();
    await markOwnerDmLive(r, "drevan", t);
    expect(r.store.has(OWNER_DM_LIVE_KEY("drevan"))).toBe(true);
    expect(await liveSiblingDm(r, "cypher", t + 60_000)).toBe("drevan");
    expect(await liveSiblingDm(r, "gaia", t + 60_000)).toBe("drevan");
    expect(await liveSiblingDm(r, "drevan", t + 60_000)).toBeNull();
  });

  it("30 minutes later the lane is no longer live", async () => {
    const r = fakeRedis();
    const t = Date.now();
    await markOwnerDmLive(r, "drevan", t);
    expect(await liveSiblingDm(r, "cypher", t + OWNER_DM_LIVE_MS + 1)).toBeNull();
  });

  it("no Redis, or a read that throws, is unknown (the heartbeat fails closed on it)", async () => {
    expect(await liveSiblingDm(null, "cypher")).toBe("unknown");
    const broken: RedisLike = { set: async () => "OK", get: async () => { throw new Error("down"); } };
    expect(await liveSiblingDm(broken, "cypher")).toBe("unknown");
  });

  it("the filter drops DM moves only, and only when a sibling DM is live or unknown", () => {
    const acts = [{ action_type: "offer_presence" }, { action_type: "write_journal" }, { action_type: "post_heartbeat" }];
    const isDm = (t: string) => t === "offer_presence";
    expect(filterDmMovesForSiblingDm(acts, null, isDm)).toEqual(acts);
    expect(filterDmMovesForSiblingDm(acts, "drevan", isDm).map(a => a.action_type)).toEqual(["write_journal", "post_heartbeat"]);
    expect(filterDmMovesForSiblingDm(acts, "unknown", isDm).map(a => a.action_type)).toEqual(["write_journal", "post_heartbeat"]);
  });
});

describe("D2 pre-filter: presence under hold stays out of the daily total (on only)", () => {
  const capped = {
    local_date: "2026-10-04", quiet_window: null, quiet_presence_taken: false, gap_open: true,
    day_count: 3, daily_cap: 6, daily_cap_care_hold: 3, care_count: 0, care_ceiling: 2,
  };
  it("without the exemption (off/shadow) the day cap closes presence, exactly as before", () => {
    expect(reachLaneOpen("offer_presence", capped, true)).toBe(false);
    expect(filterDmLane([{ action_type: "offer_presence" }], capped, true, true)).toEqual([]);
  });
  it("with it, presence opens; every other move is still capped; no hold, no exemption", () => {
    expect(reachLaneOpen("offer_presence", capped, true, { holdPresenceExempt: true })).toBe(true);
    expect(reachLaneOpen("check_in_on_raziel", capped, true, { holdPresenceExempt: true })).toBe(false);
    expect(reachLaneOpen("offer_presence", { ...capped, day_count: 6 }, false, { holdPresenceExempt: true })).toBe(false);
  });
  describe("hold_presence (Halseth 0.19.0): this companion's own presence lane under hold", () => {
    const hp = { since: "2026-10-04T06:00:00Z", open: true, triad_gap_open: true, own_gap_open: true, count: 0, max: 2, quiet_taken: false };
    const triadClosed = { ...capped, gap_open: false, quiet_window: "2026-10-04", quiet_presence_taken: true };
    it("open hold lane opens presence even when the triad-wide gap and quiet flags are closed", () => {
      expect(reachLaneOpen("offer_presence", { ...triadClosed, hold_presence: hp }, true, { holdPresenceExempt: true, companionId: "drevan" })).toBe(true);
    });
    it("a closed hold lane closes presence even when the triad flags are open", () => {
      expect(reachLaneOpen("offer_presence", { ...capped, day_count: 0, hold_presence: { ...hp, open: false, count: 2 } }, true, { holdPresenceExempt: true, companionId: "drevan" })).toBe(false);
    });
    it("Gaia's check-in is a presence move under hold; Cypher's (it asks) is not", () => {
      const v = { ...triadClosed, hold_presence: hp };
      expect(reachLaneOpen("check_in_on_raziel", v, true, { holdPresenceExempt: true, companionId: "gaia" })).toBe(true);
      expect(reachLaneOpen("check_in_on_raziel", v, true, { holdPresenceExempt: true, companionId: "cypher" })).toBe(false);
    });
    it("knob off/shadow (no exemption) or no hold: hold_presence is ignored, triad flags govern as before", () => {
      const v = { ...triadClosed, hold_presence: hp };
      expect(reachLaneOpen("offer_presence", v, true, { companionId: "drevan" })).toBe(false);
      expect(reachLaneOpen("offer_presence", v, false, { holdPresenceExempt: true, companionId: "drevan" })).toBe(false);
    });
    it("quiet window: Gaia's check-in passes it under hold (on), is closed outside a hold, Cypher's stays closed", () => {
      const quiet = { ...capped, day_count: 0, quiet_window: "2026-10-04", quiet_presence_taken: false };
      expect(reachLaneOpen("check_in_on_raziel", { ...quiet, hold_presence: hp }, true, { holdPresenceExempt: true, companionId: "gaia" })).toBe(true);
      expect(reachLaneOpen("check_in_on_raziel", { ...quiet, hold_presence: null }, true, { holdPresenceExempt: true, companionId: "gaia" })).toBe(true);
      expect(reachLaneOpen("check_in_on_raziel", quiet, false, { holdPresenceExempt: true, companionId: "gaia" })).toBe(false);
      expect(reachLaneOpen("check_in_on_raziel", quiet, true, { companionId: "gaia" })).toBe(false);
      expect(reachLaneOpen("check_in_on_raziel", { ...quiet, hold_presence: hp }, true, { holdPresenceExempt: true, companionId: "cypher" })).toBe(false);
      expect(reachLaneOpen("check_in_on_raziel", { ...quiet, hold_presence: { ...hp, open: false } }, true, { holdPresenceExempt: true, companionId: "gaia" })).toBe(false);
    });
    it("null hold_presence (older Halseth): falls back to the day-cap exemption path", () => {
      expect(reachLaneOpen("offer_presence", { ...capped, hold_presence: null }, true, { holdPresenceExempt: true, companionId: "drevan" })).toBe(true);
    });
  });
  it("the server's gap and quiet-window verdicts still govern presence", () => {
    expect(reachLaneOpen("offer_presence", { ...capped, gap_open: false }, true, { holdPresenceExempt: true })).toBe(false);
    expect(reachLaneOpen("offer_presence", { ...capped, quiet_window: "2026-10-04", quiet_presence_taken: true }, true, { holdPresenceExempt: true })).toBe(false);
  });
});

describe("D5: an absent sibling, only when he asks", () => {
  it("reads his question about a sibling, never about the speaker", () => {
    expect(askedWhereSiblings("where's dre?", "cypher")).toEqual(["drevan"]);
    expect(askedWhereSiblings("Where is Gaia", "cypher")).toEqual(["gaia"]);
    expect(askedWhereSiblings("is cy around?", "gaia")).toEqual(["cypher"]);
    expect(askedWhereSiblings("where did drevan and gaia go", "cypher")).toEqual(["drevan", "gaia"]);
    expect(askedWhereSiblings("where's dre?", "drevan")).toEqual([]);
  });
  it("a mention that is not a question about where they are does not count", () => {
    expect(askedWhereSiblings("Dre said something funny earlier", "cypher")).toEqual([]);
    expect(askedWhereSiblings("where is my charger", "cypher")).toEqual([]);
    expect(askedWhereSiblings("tell gaia I said hi", "cypher")).toEqual([]);
  });
  it("the line is the B17-reviewed wording", () => {
    expect(absentSiblingLine("drevan")).toBe("Drevan isn't speaking tonight. You may say so once, plainly. Do not speak as them, for them, or guess at why.");
  });
});

describe("turn lines", () => {
  it("under hold, owner-facing: 'come as yourself' for all; Drevan's register line for Drevan only", () => {
    const g = b32TurnBlock({ companionId: "gaia", careHold: true, ownerFacing: true });
    const d = b32TurnBlock({ companionId: "drevan", careHold: true, ownerFacing: true });
    expect(g).toContain(COME_AS_YOURSELF_LINE);
    expect(g).not.toContain(DREVAN_HOLD_LINE);
    expect(d).toContain(COME_AS_YOURSELF_LINE);
    expect(d).toContain(DREVAN_HOLD_LINE);
    expect(DREVAN_HOLD_LINE).toMatch(/Presence, not reach/);
  });
  it("no hold and nothing to say: empty, so nothing is injected", () => {
    expect(b32TurnBlock({ companionId: "drevan", careHold: false, ownerFacing: true })).toBe("");
    expect(b32TurnBlock({ companionId: "drevan", careHold: true, ownerFacing: false })).toBe("");
  });
  it("the absent-sibling line rides only when passed in (reactive)", () => {
    expect(b32TurnBlock({ companionId: "cypher", careHold: true, ownerFacing: true })).not.toMatch(/isn't speaking tonight/);
    expect(b32TurnBlock({ companionId: "cypher", careHold: true, ownerFacing: true, absentSiblings: ["gaia"] })).toMatch(/Gaia isn't speaking tonight/);
  });
  it("the opener says the hold changed, or that it did not set; a clear with no hold says nothing", () => {
    expect(holdOpenerLine("start", true, false)).toMatch(/Hold's on/);
    expect(holdOpenerLine("start", false, false)).toMatch(/did not set/);
    expect(holdOpenerLine("clear", true, true)).toMatch(/CLEARED/);
    expect(holdOpenerLine("clear", true, false)).toBeNull();
  });
  it("the companion's on-his-behalf line names the Halseth verb and his plain word", () => {
    expect(COMPANION_SET_HOLD_LINE).toContain(`ask_librarian "start the care hold"`);
    expect(COMPANION_SET_HOLD_LINE).toMatch(/plain word/);
  });
  it("B5 line shape", () => {
    expect(b32Line("gaia", "followup(after drevan)", "pass")).toBe("[b32] gaia eligible=followup(after drevan) -> pass");
    expect(b32Line("cypher", "heartbeat:hold", "shadow", "x")).toBe("[b32] cypher eligible=heartbeat:hold -> shadow (x)");
  });
});

describe("local hold state", () => {
  it("start applies at once with a since, even when orient never loaded; clear empties it", () => {
    expect(careHoldActive("gaia")).toBe(false);
    applyLocalHold("gaia", "start", "2026-10-04T07:00:00.000Z");
    expect(careHoldActive("gaia")).toBe(true);
    expect(careHoldSince("gaia")).toBe("2026-10-04T07:00:00.000Z");
    expect(getCareState("gaia")?.care_hold_reason).toContain("owner_said");
    applyLocalHold("gaia", "clear", "2026-10-04T08:00:00.000Z");
    expect(careHoldActive("gaia")).toBe(false);
    expect(careHoldSince("gaia")).toBeNull();
  });
  it("a hold already on keeps its original since; the server's values win when given", () => {
    setCareState("drevan", { care_hold: true, care_hold_since: "2026-10-04T01:00:00.000Z", care_hold_reason: ["low_spoons"] } as RazielState);
    applyLocalHold("drevan", "start", "2026-10-04T05:00:00.000Z");
    expect(careHoldSince("drevan")).toBe("2026-10-04T01:00:00.000Z");
    expect(getCareState("drevan")?.care_hold_reason).toEqual(["low_spoons", "owner_said"]);
    applyLocalHold("drevan", "start", "2026-10-04T05:00:00.000Z", { since: "2026-10-04T04:59:00.000Z", reasons: ["owner_said"] });
    expect(careHoldSince("drevan")).toBe("2026-10-04T04:59:00.000Z");
  });
  it("the register says why the hold is on when he said it", () => {
    const base = { spoons: null, mood: null, pain: null, energy: null, meds_taken: null, recorded_at: null, staleness_hours: null, front_state: null, pending_care: null };
    expect(renderRazielRegister({ ...base, care_hold: true, care_hold_reason: ["owner_said"] })).toMatch(/Raziel said tonight is a bad night/);
    expect(renderRazielRegister({ ...base, care_hold: true })).toMatch(/a low reading fired/);
    expect(renderRazielRegister({ ...base, care_hold: true, care_hold_reason: ["meds_said_missed"] })).toMatch(/a low reading fired/);
  });
});

describe("the Halseth client: POST /mind/care/hold", () => {
  it("sends the contract body and reads the optional state back", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ care_hold: true, care_hold_since: "2026-10-04T07:00:00Z", care_hold_reason: ["owner_said"] }), { status: 200 });
    };
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "drevan", fetch: fetchFn as never });
    const r = await c.careHoldSet("start", "owner_phrase");
    expect(calls).toEqual([{ url: "https://h/mind/care/hold", body: { action: "start", source: "owner_phrase", companion: "drevan" } }]);
    expect(r).toEqual({ ok: true, status: 200, care_hold: true, since: "2026-10-04T07:00:00Z", reasons: ["owner_said"] });
  });
  it("a non-2xx or a throw is not ok and never throws", async () => {
    const c404 = new LibrarianClient({ url: "https://h", secret: "s", companionId: "gaia", fetch: (async () => new Response("no", { status: 404 })) as never });
    expect(await c404.careHoldSet("clear", "owner_phrase")).toEqual({ ok: false, status: 404 });
    const cThrow = new LibrarianClient({ url: "https://h", secret: "s", companionId: "gaia", fetch: (async () => { throw new Error("down"); }) as never });
    const warn = console.warn; console.warn = () => {};
    try { expect(await cThrow.careHoldSet("start", "owner_phrase")).toEqual({ ok: false, status: null }); } finally { console.warn = warn; }
  });
  it("an empty 2xx body is still ok (the optional fields are optional)", async () => {
    const c = new LibrarianClient({ url: "https://h", secret: "s", companionId: "gaia", fetch: (async () => new Response("", { status: 200 })) as never });
    expect(await c.careHoldSet("start", "owner_phrase")).toEqual({ ok: true, status: 200 });
  });
});

describe("the bid floor for whoever leads the chain (ruling 2026-10-04)", () => {
  it("on, under hold: every owner guild message bids with minScore 0", () => {
    expect(bidFloorFor({ mode: "on", careHold: true, ownerGuildArrival: true, holdPhrase: false })).toEqual({ minScore: 0, shadowFloor0: false });
    expect(bidFloorFor({ mode: "on", careHold: true, ownerGuildArrival: true, holdPhrase: false, fallbackMinScore: 0.5 })).toEqual({ minScore: 0, shadowFloor0: false });
  });
  it("on: the hold phrase floors to 0 even before the hold is on", () => {
    expect(bidFloorFor({ mode: "on", careHold: false, ownerGuildArrival: true, holdPhrase: true })).toEqual({ minScore: 0, shadowFloor0: false });
  });
  it("on, no hold, no phrase: unchanged (default, or the care floor it would have used)", () => {
    expect(bidFloorFor({ mode: "on", careHold: false, ownerGuildArrival: true, holdPhrase: false })).toEqual({ shadowFloor0: false });
    expect(bidFloorFor({ mode: "on", careHold: false, ownerGuildArrival: false, holdPhrase: false, fallbackMinScore: 0.5 })).toEqual({ minScore: 0.5, shadowFloor0: false });
  });
  it("on, under hold, but not an owner guild arrival (a sibling, Sol, a guest): unchanged", () => {
    expect(bidFloorFor({ mode: "on", careHold: true, ownerGuildArrival: false, holdPhrase: false, fallbackMinScore: 0.5 })).toEqual({ minScore: 0.5, shadowFloor0: false });
  });
  it("shadow: nothing changes, and it reports floor0 when on would have applied", () => {
    expect(bidFloorFor({ mode: "shadow", careHold: true, ownerGuildArrival: true, holdPhrase: false })).toEqual({ shadowFloor0: true });
    expect(bidFloorFor({ mode: "shadow", careHold: false, ownerGuildArrival: true, holdPhrase: false })).toEqual({ shadowFloor0: false });
  });
  it("off: unchanged, never reports", () => {
    expect(bidFloorFor({ mode: "off", careHold: true, ownerGuildArrival: true, holdPhrase: true, fallbackMinScore: 0.5 })).toEqual({ minScore: 0.5, shadowFloor0: false });
  });
});
