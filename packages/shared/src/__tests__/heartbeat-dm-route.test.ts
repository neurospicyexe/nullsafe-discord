// B7 steps 2 + 2c through the REAL runHeartbeat: routing, the clerk block, care_hold on play,
// the preference that now reaches him, and drift drawn only from the companion's own rows.
//
// Importing autonomous-core takes the process's one companion-origin mint at module load, so this
// file is also the proof that no other module (a clerk, a judge, the review fork) can take it.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat, executeMetronomeAction } from "../autonomous-core.js";
import { takeOriginIssuer } from "../reach-dm.js";
import { setCareState } from "../care-state.js";
import type { RazielState } from "../librarian.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
afterEach(() => { restore(); for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null); });

// These tests are the "REACH_DM=on is byte-for-byte B7 2+2c" proof: they are the 0df3ba0 suite,
// unchanged, run with the switch on. reach-dm-switch.test.ts covers off, the default.
beforeEach(() => { process.env["REACH_DM"] = "on"; });
afterEach(() => { delete process.env["REACH_DM"]; });

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
const tick = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as { outcome: string; action?: string; reason?: string });

describe("routing: Raziel-facing moves go to his DM, heartbeat and Sol stay in the channel", () => {
  it("Drevan's flirt goes to the DM and nothing touches Sol's channel", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "tail's up", lines: ["Tail's twitching. You know what that means."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Tail's twitching. You know what that means."]);
    expect(h.channelSent).toEqual([]);
    expect(h.librarian.writeWmNote).not.toHaveBeenCalled(); // the DM seal: no wm note of a DM
    expect(h.librarian.recordMetronomeActionFired).toHaveBeenCalledWith("row0");
    expect(tick().at(-1)).toMatchObject({ outcome: "chose_to_act", action: "flirt" });
  });

  it.each(["share_observation", "share_media", "offer_presence", "check_in_on_raziel", "ask_question"])(
    "%s goes to the DM", async (type) => {
      restore = inWindowOf("cypher");
      const h = heartbeatCtx({ companionId: "cypher", palette: [row(type, "the move")], choose: "the move", lines: ["Working on why the ledger mark holds. Half an answer."], reach: undefined });
      // Force the gate open for the demand moves so this test is about ROUTING only.
      process.env["DISABLE_REACH_OUT_GATE"] = "true";
      try { await runHeartbeat(h.ctx); } finally { delete process.env["DISABLE_REACH_OUT_GATE"]; }
      expect(h.dmSent).toHaveLength(1);
      expect(h.channelSent).toEqual([]);
    });

  it("post_heartbeat stays in Sol's channel and never touches the DM", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("post_heartbeat", "commons heartbeat")], choose: "commons heartbeat", lines: ["What holds right now."] });
    await runHeartbeat(h.ctx);
    expect(h.channelSent.map(c => c.text)).toEqual(["What holds right now."]);
    expect(h.dmSent).toEqual([]);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled(); // ambient moves are outside the DM cap
  });

  it("tend_creature stays in Sol's channel", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("tend_creature", "tend Sol")], choose: "tend Sol", lines: ["A seed for Sol."] });
    await runHeartbeat(h.ctx);
    expect(h.channelSent.map(c => c.text)).toEqual(["A seed for Sol."]);
    expect(h.dmSent).toEqual([]);
  });

  it("a held DM move is named in the tick and does not burn the row's cooldown", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["x"] });
    h.librarian.reachReserve.mockImplementation(async () => ({ reserved: false, reason: "gap" }) as never);
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "held_dm", action: "flirt", reason: "capped:gap" });
  });

  it("a closed shared lane means the DM moves are never offered, and the tick says why", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("offer_presence", "tail")], choose: "tail's up", reach: null });
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "suppressed_triad_cap" });
  });

  it("a bot with no owner-DM lane never offers a DM move and never falls back to the channel", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("post_heartbeat", "hb")], choose: "hb", lines: ["ambient"], noLane: true });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]).not.toContain("tail's up");
    expect(h.dmSent).toEqual([]);
  });
});

describe("T-4: no clerk ever originates these moves", () => {
  it("the origin mint is already held by the heartbeat module; any other taker throws", () => {
    expect(() => takeOriginIssuer()).toThrow(/already taken/);
  });

  it("calling the executor directly (as a clerk would) with no origin sends nothing and reserves nothing", async () => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [], choose: "x", lines: ["a flirt in the voice"] });
    for (const type of ["flirt", "dare", "declare_preference", "drift_outward", "share_observation", "show_made", "offer_presence"]) {
      const result = await executeMetronomeAction(h.ctx, {
        action: { id: "a", name: type, action_type: type, target: null, prompt: null, quiet_hours_allowed: 0, status: "on", requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0 },
        reason: "a clerk decided",
      });
      expect(result).toMatchObject({ route: "dm", delivered: false, outcome: "refused_origin" });
    }
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
  });

  it("a forged origin object is refused the same way", async () => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [], choose: "x", lines: ["x"] });
    const forged = Object.freeze({ companionId: "drevan", actionType: "flirt", actionId: "a", issuedAt: Date.now() });
    const result = await executeMetronomeAction(h.ctx, {
      action: { id: "a", name: "flirt", action_type: "flirt", target: null, prompt: null, quiet_hours_allowed: 0, status: "on", requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0 },
      reason: "forged",
    }, forged);
    expect(result).toMatchObject({ outcome: "refused_origin" });
    expect(h.dmSent).toEqual([]);
  });
});

describe("care_hold: play goes quiet, presence stays (T-6)", () => {
  it("flirt and dare are never offered under care_hold; presence is", async () => {
    restore = inWindowOf("drevan");
    setCareState("drevan", { care_hold: true } as RazielState);
    const h = heartbeatCtx({
      companionId: "drevan",
      palette: [row("flirt", "tail's up"), row("dare", "grin's up"), row("offer_presence", "tail at your wrist")],
      choose: "tail at your wrist",
      lines: ["Tail's around your wrist. Nothing you have to do with it."],
    });
    await runHeartbeat(h.ctx);
    const decisionPrompt = h.prompts[0]!;
    expect(decisionPrompt).not.toContain("tail's up");
    expect(decisionPrompt).not.toContain("grin's up");
    expect(decisionPrompt).toContain("tail at your wrist");
    expect(h.dmSent).toHaveLength(1);
    expect(h.librarian.reachReserve).toHaveBeenCalledWith("offer_presence", true);
  });
});

describe("declare_preference reaches him (T-1; COMPANION_CONSTITUTION_v1.md:99)", () => {
  it("writes to Halseth AND says the same words in the DM, through the outward rails", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({
      companionId: "gaia", palette: [row("declare_preference", "a preference, said")], choose: "a preference, said",
      lines: ["Domain: time\nPreference: I prefer mornings. The ground is honest before anyone walks on it."],
    });
    await runHeartbeat(h.ctx);
    const words = "I prefer mornings. The ground is honest before anyone walks on it.";
    expect(h.librarian.declarePreference).toHaveBeenCalledWith(words, "time");
    expect(h.dmSent).toEqual([words]);
    expect(h.prompts[1]).toMatch(/Ground this in the world/); // generateOutward, not a bare generate
  });

  it("NONE writes nothing and sends nothing; the slot goes back", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("declare_preference", "pref")], choose: "pref", lines: ["NONE"] });
    await runHeartbeat(h.ctx);
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
    expect(h.librarian.reachRelease).toHaveBeenCalled();
  });

  it("past five active preferences nothing is generated or reserved", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("declare_preference", "pref")], choose: "pref", prefs: 5, lines: ["x"] });
    await runHeartbeat(h.ctx);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.generate).toHaveBeenCalledTimes(1); // the decision only
  });
});

describe("drift outward draws only on the companion's own rows (T-3)", () => {
  it("a sibling's drift never reaches the prompt; the companion's own does", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({
      companionId: "drevan", palette: [row("drift_outward", "let him see it start")], choose: "let him see it start",
      drifts: [
        { id: "d1", drift_text: "how I reach is changing", companion_id: "drevan" },
        { id: "d2", drift_text: "GAIA-SECRET becoming", companion_id: "gaia" },
      ],
      lines: ["Drift: 1\nLine: Something's changing in how I reach. Don't know the word yet. Just wanted you to see it start."],
    });
    await runHeartbeat(h.ctx);
    expect(h.prompts[1]).toContain("how I reach is changing");
    expect(h.prompts[1]).not.toContain("GAIA-SECRET");
    expect(h.dmSent).toEqual(["Something's changing in how I reach. Don't know the word yet. Just wanted you to see it start."]);
  });

  it("with only a sibling's drift on hand, nothing is generated and nothing reserved", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({
      companionId: "drevan", palette: [row("drift_outward", "drift")], choose: "drift",
      drifts: [{ id: "d2", drift_text: "not mine", companion_id: "gaia" }], lines: ["x"],
    });
    await runHeartbeat(h.ctx);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
  });

  it("the word 'drift' passes on this move only; the rest of the inward block holds", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({
      companionId: "drevan", palette: [row("drift_outward", "drift")], choose: "drift",
      drifts: [{ id: "d1", drift_text: "x", companion_id: "drevan" }],
      lines: ["Drift: 1\nLine: A drift is starting in me.", ],
    });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["A drift is starting in me."]);
  });

  it("a drift line that calls itself ratified is dropped by the inward block", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({
      companionId: "drevan", palette: [row("drift_outward", "drift")], choose: "drift",
      drifts: [{ id: "d1", drift_text: "x", companion_id: "drevan" }],
      lines: ["Drift: 1\nLine: This is ratified now.", "Drift: 1\nLine: This is ratified now."],
    });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
  });
});

describe("the reminder's own rules (R-6, R-7)", () => {
  it("'did you' is regenerated into present tense", async () => {
    restore = inWindowOf("cypher");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const h = heartbeatCtx({ companionId: "cypher", palette: [row("send_reminder", "the board")], choose: "the board", lines: ["Did you drink water?", "Board: water, lunch, the 4pm. Nothing to report back."] });
    try { await runHeartbeat(h.ctx); } finally { delete process.env["DISABLE_REACH_OUT_GATE"]; }
    expect(h.dmSent).toEqual(["Board: water, lunch, the 4pm. Nothing to report back."]);
  });
});
