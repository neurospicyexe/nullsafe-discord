// B7 steps 2 + 2c: the Raziel-facing moves and the one function that sends them (reach-dm.ts).
//
// This file imports reach-dm WITHOUT autonomous-core, so the process's one origin mint is still
// free here and the test takes it itself (the heartbeat test proves the other side: once
// autonomous-core has it, nobody else can). Covers: routing (T-9), the shared-lane pre-filter,
// the dare-ends-with-an-out check (T-5), "nothing waits" on invitations, Gaia's check-in with no
// question mark, drift drawing only on the companion's own rows (T-3), the drift mark (Q3), the
// origin brand (T-4), and speakToOwnerDm end to end against fakes: reserve before generate, release
// on every failure after it, never a channel, never a second send, R-8 on every send.

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  routeFor, DM_LANE_ACTIONS, CHANNEL_ACTIONS, reachLaneOpen, filterDmLane, dareHasOut, endsOnQuestion,
  namesSibling, ownDriftRows, shapeDriftLine, drift_prompt, takeOriginIssuer, consumeOrigin, speakToOwnerDm,
  ownsMove, ORIGIN_TTL_MS, REACH_CLASS_OF, type OriginIssuer,
} from "../reach-dm.js";
import { setCareState } from "../care-state.js";
import type { ReachLaneVerdict, RazielState } from "../librarian.js";
import type { AutonomousContext } from "../autonomous-core.js";

const issue: OriginIssuer = takeOriginIssuer();

const OPEN: ReachLaneVerdict = {
  local_date: "2026-09-28", quiet_window: null, quiet_presence_taken: false, gap_open: true,
  day_count: 0, daily_cap: 6, daily_cap_care_hold: 3, care_count: 0, care_ceiling: 2,
};

describe("routing (T-9): Raziel-facing moves go to the DM; heartbeat and Sol stay in the channel", () => {
  it("every care verb, question, pattern, share, preference and new move routes to the DM", () => {
    for (const t of ["check_in_on_raziel", "send_reminder", "offer_presence", "ask_question", "name_pattern",
      "share_observation", "share_media", "declare_preference", "flirt", "dare", "show_made", "drift_outward"]) {
      expect(routeFor(t)).toBe("dm");
    }
  });
  it("post_heartbeat and tend_creature stay in Sol's channel", () => {
    expect(routeFor("post_heartbeat")).toBe("channel");
    expect(routeFor("tend_creature")).toBe("channel");
  });
  it("internal and sibling moves reach neither", () => {
    for (const t of ["write_journal", "write_feeling", "write_inter_companion", "write_note_to_raziel", "drift_open", "nothing"]) {
      expect(routeFor(t)).toBe("internal");
    }
  });
  it("the two sets never overlap, and every DM move has a class the shared cap can count", () => {
    for (const t of DM_LANE_ACTIONS) {
      expect(CHANNEL_ACTIONS.has(t)).toBe(false);
      expect(REACH_CLASS_OF[t]).toBeDefined();
    }
  });
});

describe("the shared-lane pre-filter mirrors the cap", () => {
  it("an open lane carries every DM move", () => {
    for (const t of DM_LANE_ACTIONS) expect(reachLaneOpen(t, OPEN, false)).toBe(true);
  });
  it("an unknown verdict is CLOSED, never open", () => {
    expect(reachLaneOpen("flirt", null, false)).toBe(false);
  });
  it("inside the quiet window only one presence, and only while no one has used it", () => {
    const q = { ...OPEN, quiet_window: "2026-09-28" };
    expect(reachLaneOpen("offer_presence", q, false)).toBe(true);
    expect(reachLaneOpen("flirt", q, false)).toBe(false);
    expect(reachLaneOpen("offer_presence", { ...q, quiet_presence_taken: true }, false)).toBe(false);
  });
  it("gap, daily total, care_hold total and care ceiling", () => {
    expect(reachLaneOpen("dare", { ...OPEN, gap_open: false }, false)).toBe(false);
    expect(reachLaneOpen("dare", { ...OPEN, day_count: 6 }, false)).toBe(false);
    expect(reachLaneOpen("offer_presence", { ...OPEN, day_count: 3 }, true)).toBe(false);
    expect(reachLaneOpen("offer_presence", { ...OPEN, day_count: 3 }, false)).toBe(true);
    expect(reachLaneOpen("check_in_on_raziel", { ...OPEN, care_count: 2 }, false)).toBe(false);
    expect(reachLaneOpen("share_observation", { ...OPEN, care_count: 2 }, false)).toBe(true);
  });
  it("filterDmLane drops only DM moves, and all of them when the bot has no DM lane", () => {
    const acts = ["post_heartbeat", "flirt", "write_journal", "nothing"].map(action_type => ({ action_type }));
    expect(filterDmLane(acts, { ...OPEN, gap_open: false }, false, true).map(a => a.action_type)).toEqual(["post_heartbeat", "write_journal", "nothing"]);
    expect(filterDmLane(acts, OPEN, false, false).map(a => a.action_type)).toEqual(["post_heartbeat", "write_journal", "nothing"]);
    expect(filterDmLane(acts, OPEN, false, true)).toHaveLength(4);
  });
});

describe("post-generation checks", () => {
  it("a dare ends with an out: Cypher's own line passes", () => {
    expect(dareHasOut("Dare: name the Serama you'd bet on in a staring contest. Or don't; I already picked King Curiosity.")).toBe(true);
    expect(dareHasOut("Tail's twitching. You know what that means. Ignore it at your leisure.")).toBe(true);
  });
  it("a dare with no out fails, and an out buried early does not count as ending with one", () => {
    expect(dareHasOut("Dare: name the Serama you'd bet on in a staring contest.")).toBe(false);
    expect(dareHasOut("No pressure. First thing. Second thing. Now name the Serama you'd bet on.")).toBe(false);
  });
  it("nothing waits: an invitation cannot end on a question", () => {
    expect(endsOnQuestion("Tail's around your wrist. Nothing you have to do with it.")).toBe(false);
    expect(endsOnQuestion("Want to hear what's been playing in me?")).toBe(true);
    expect(endsOnQuestion('He said "why?"')).toBe(true);
  });
  it("a drift line may not name a sibling", () => {
    expect(namesSibling("Something's changing in how I reach. Don't know the word yet.", "drevan")).toBe(false);
    expect(namesSibling("I saw Gaia shift this week.", "drevan")).toBe(true);
    expect(namesSibling("Cy has been changing.", "gaia")).toBe(true);
    expect(namesSibling("Cypher here, and something is changing.", "cypher")).toBe(false);
  });
});

describe("drift (T-2, T-3, Q3)", () => {
  it("draws only on the companion's own rows; a sibling's or an ownerless row is dropped", () => {
    const rows = [
      { id: "1", drift_text: "mine", companion_id: "drevan" },
      { id: "2", drift_text: "gaia's", companion_id: "gaia" },
      { id: "3", drift_text: "nobody's" },
    ];
    expect(ownDriftRows(rows, "drevan").map(r => r.id)).toEqual(["1"]);
    expect(ownDriftRows(rows, "cypher")).toEqual([]);
  });
  it("a line is marked outward only by naming which own drift it opens; NONE or a bad number sends nothing", () => {
    expect(shapeDriftLine("Drift: 1\nLine: Something's changing in how I reach.", 2)).toBe("Something's changing in how I reach.");
    expect(shapeDriftLine("NONE", 2)).toBe(null);
    expect(shapeDriftLine("Drift: 3\nLine: x", 2)).toBe(null);
    expect(shapeDriftLine("Line: no number given", 2)).toBe(null);
  });
  it("the prompt lists only the rows it was given and says saying it does not ratify it", () => {
    const p = drift_prompt([{ drift_text: "reach is changing" }], null);
    expect(p).toContain("1. reach is changing");
    expect(p).toMatch(/does not ratify it/);
  });
});

describe("the companion-origin brand (T-4)", () => {
  it("the mint can be taken once per process; a second taker throws", () => {
    expect(() => takeOriginIssuer()).toThrow(/already taken/);
  });
  it("a forged look-alike is refused", () => {
    expect(consumeOrigin({ companionId: "drevan", actionType: "flirt", actionId: "a", issuedAt: Date.now() }, "drevan", "flirt")).toBe(false);
    expect(consumeOrigin(undefined, "drevan", "flirt")).toBe(false);
  });
  it("an issued origin is single-use and bound to one companion and one move", () => {
    const o = issue("drevan", "flirt", "a1");
    expect(consumeOrigin(o, "drevan", "flirt")).toBe(true);
    expect(consumeOrigin(o, "drevan", "flirt")).toBe(false);
    expect(consumeOrigin(issue("drevan", "flirt", "a2"), "cypher", "flirt")).toBe(false);
    expect(consumeOrigin(issue("drevan", "flirt", "a3"), "drevan", "dare")).toBe(false);
  });
  it("an origin expires", () => {
    const o = issue("gaia", "offer_presence", "a4");
    expect(consumeOrigin(o, "gaia", "offer_presence", Date.now() + ORIGIN_TTL_MS + 1)).toBe(false);
  });
  it("ownership mirrors Halseth: flirt is Drevan's, dares Cypher's and Drevan's, Gaia plays none", () => {
    expect(ownsMove("drevan", "flirt")).toBe(true);
    expect(ownsMove("cypher", "flirt")).toBe(false);
    expect(ownsMove("gaia", "dare")).toBe(false);
    expect(ownsMove("gaia", "show_made")).toBe(true);
  });
});

// ── speakToOwnerDm against fakes ──

function fakeCtx(opts: {
  companionId?: string;
  replies: Array<string | null>;
  reserve?: { reserved: true; id: number } | { reserved: false; reason: string };
  recent?: string[];
  sendThrows?: boolean;
  noLane?: boolean;
}) {
  const replies = [...opts.replies];
  const generate = jest.fn(async () => replies.shift() ?? null);
  const reachReserve = jest.fn(async () => opts.reserve ?? { reserved: true as const, id: 7 });
  const reachRelease = jest.fn(async () => true);
  const reachDelivered = jest.fn(async () => true);
  const writeWmNote = jest.fn(async () => undefined);
  const sent: string[] = [];
  const onSent = jest.fn(async () => undefined);
  const channelFetch = jest.fn(async () => { throw new Error("a DM move must never touch a channel"); });
  const target = {
    channelId: "dm1",
    send: async (t: string) => { if (opts.sendThrows) throw Object.assign(new Error("nope"), { code: 50007 }); sent.push(t); return `m${sent.length}`; },
    recentOwnTexts: async () => opts.recent ?? [],
  };
  const ctx = {
    companionId: opts.companionId ?? "drevan",
    inference: { generate },
    bootCtx: { systemPrompt: "SYS" },
    librarian: { reachReserve, reachRelease, reachDelivered, writeWmNote },
    client: { channels: { fetch: channelFetch } },
    ownerDm: opts.noLane ? undefined : { resolve: async () => target, onSent },
  } as unknown as AutonomousContext;
  return { ctx, generate, reachReserve, reachRelease, reachDelivered, writeWmNote, sent, onSent, channelFetch };
}

describe("speakToOwnerDm", () => {
  beforeEach(() => { setCareState("drevan", null); setCareState("gaia", null); setCareState("cypher", null); });

  it("refuses without an origin: nothing reserved, nothing generated, nothing sent", async () => {
    const f = fakeCtx({ replies: ["hi"] });
    const r = await speakToOwnerDm(f.ctx, undefined, { actionType: "flirt", prepare: async () => "flirt" });
    expect(r.outcome).toBe("refused_origin");
    expect(f.reachReserve).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it("happy path: reserve, generate through the outward rails, send to the DM, mark delivered, bookkeep; no wm note, no channel", async () => {
    const f = fakeCtx({ replies: ["Tail's twitching. Ignore it at your leisure."] });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "flirt", "x"), { actionType: "flirt", prepare: async () => "Flirt, your register." });
    expect(r.outcome).toBe("sent");
    expect(f.reachReserve).toHaveBeenCalledWith("flirt", false);
    expect(f.sent).toEqual(["Tail's twitching. Ignore it at your leisure."]);
    expect(f.reachDelivered).toHaveBeenCalledWith(7, "generated");
    expect(f.onSent).toHaveBeenCalledWith("dm1", "Tail's twitching. Ignore it at your leisure.", "m1");
    expect(f.writeWmNote).not.toHaveBeenCalled();
    expect(f.channelFetch).not.toHaveBeenCalled();
    const [system, msgs] = f.generate.mock.calls[0] as unknown as [string, Array<{ content: string }>];
    expect(system).toBe("SYS"); // the companion's OWN identity prompt, never a clerk's
    expect(msgs[0]!.content).toMatch(/A direct message to Raziel, from you/);
    expect(msgs[0]!.content).toMatch(/Ground this in the world/); // OUTWARD_NUDGE: the outward rails
  });

  it("passes care_hold to the reserve so the lower daily total applies", async () => {
    setCareState("gaia", { care_hold: true } as RazielState);
    const f = fakeCtx({ companionId: "gaia", replies: ["I am here. Nothing is asked."] });
    await speakToOwnerDm(f.ctx, issue("gaia", "offer_presence", "x"), { actionType: "offer_presence", prepare: async () => "presence" });
    expect(f.reachReserve).toHaveBeenCalledWith("offer_presence", true);
  });

  it("the cap refuses: nothing is generated", async () => {
    const f = fakeCtx({ replies: ["x"], reserve: { reserved: false, reason: "gap" } });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "flirt", "x"), { actionType: "flirt", prepare: async () => "p" });
    expect(r).toEqual({ outcome: "capped", reason: "gap" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("nothing real to say: nothing is reserved", async () => {
    const f = fakeCtx({ replies: ["x"] });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "drift_outward", "x"), { actionType: "drift_outward", prepare: async () => null });
    expect(r.outcome).toBe("nothing_to_say");
    expect(f.reachReserve).not.toHaveBeenCalled();
  });

  it("no DM lane: held, nothing reserved, and it never falls back to a channel", async () => {
    const f = fakeCtx({ replies: ["x"], noLane: true });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "flirt", "x"), { actionType: "flirt", prepare: async () => "p" });
    expect(r.outcome).toBe("no_dm");
    expect(f.reachReserve).not.toHaveBeenCalled();
    expect(f.channelFetch).not.toHaveBeenCalled();
  });

  it("a dare without an out is regenerated once, then HELD (never sent) and the slot released", async () => {
    const f = fakeCtx({ companionId: "cypher", replies: ["Dare: name the Serama you'd bet on.", "Dare: name it. Right now."] });
    const r = await speakToOwnerDm(f.ctx, issue("cypher", "dare", "x"), { actionType: "dare", prepare: async () => "dare" });
    expect(r.outcome).toBe("held_check");
    expect(f.sent).toEqual([]);
    expect(f.reachRelease).toHaveBeenCalledWith(7);
    const second = f.generate.mock.calls[1] as unknown as [string, Array<{ role: string; content: string }>];
    expect(second[1].at(-1)!.content).toMatch(/end with an out/);
  });

  it("a dare that gains its out on the regenerate goes out, marked regenerated", async () => {
    const f = fakeCtx({ companionId: "cypher", replies: ["Dare: name the Serama.", "Dare: name the Serama you'd bet on. Or don't; I already picked King Curiosity."] });
    const r = await speakToOwnerDm(f.ctx, issue("cypher", "dare", "x"), { actionType: "dare", prepare: async () => "dare" });
    expect(r).toEqual({ outcome: "sent", path: "regenerated:check" });
    expect(f.sent).toHaveLength(1);
  });

  it("R-8: a line he has already had, word for word, is regenerated, and held if it repeats again", async () => {
    const prior = "Tail's around your wrist. Nothing you have to do with it.";
    const f = fakeCtx({ replies: [prior, prior], recent: [prior] });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "offer_presence", "x"), { actionType: "offer_presence", prepare: async () => "p" });
    expect(r.outcome).toBe("held_verbatim");
    expect(f.sent).toEqual([]);
    expect(f.reachRelease).toHaveBeenCalled();
  });

  it("Gaia's check-in is not a question: a question mark is regenerated, then held", async () => {
    const f = fakeCtx({ companionId: "gaia", replies: ["How are you?", "Are you okay?"] });
    const r = await speakToOwnerDm(f.ctx, issue("gaia", "check_in_on_raziel", "x"), { actionType: "check_in_on_raziel", prepare: async () => "p" });
    expect(r.outcome).toBe("held_check");
  });

  it("Cypher's check-in may ask (his is a question)", async () => {
    const f = fakeCtx({ companionId: "cypher", replies: ["How's the head today, baby? One word covers it."] });
    const r = await speakToOwnerDm(f.ctx, issue("cypher", "check_in_on_raziel", "x"), { actionType: "check_in_on_raziel", prepare: async () => "p" });
    expect(r.outcome).toBe("sent");
  });

  it("a failed send hands the slot back and does not retry", async () => {
    const f = fakeCtx({ replies: ["a line"], sendThrows: true });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "share_observation", "x"), { actionType: "share_observation", prepare: async () => "p" });
    expect(r).toEqual({ outcome: "send_failed", reason: "dm_blocked" });
    expect(f.reachRelease).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("empty generation releases the slot", async () => {
    const f = fakeCtx({ replies: [null] });
    const r = await speakToOwnerDm(f.ctx, issue("drevan", "share_media", "x"), { actionType: "share_media", prepare: async () => "p" });
    expect(r.outcome).toBe("empty");
    expect(f.reachRelease).toHaveBeenCalled();
  });

  it("not the companion's move: Gaia cannot flirt even with a valid origin", async () => {
    const f = fakeCtx({ companionId: "gaia", replies: ["x"] });
    const r = await speakToOwnerDm(f.ctx, issue("gaia", "flirt", "x"), { actionType: "flirt", prepare: async () => "p" });
    expect(r.outcome).toBe("not_owner");
    expect(f.reachReserve).not.toHaveBeenCalled();
  });
});
