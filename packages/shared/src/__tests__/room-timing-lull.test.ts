// Room timing, LIVE cut (2026-11-01): the "wait for the lull" behaviour behind ROOM_TIMING=on.
// Drevan (note d5a37a0c): during a burst, react instead of taking the floor, then answer ONCE at about a
// minute of quiet, or not at all; "if the other human answers inside the burst, it was theirs".

import { describe, it, expect } from "@jest/globals";
import {
  LullScheduler, liveHoldApplies, roomTimingMode, LULL_MS, LULL_MAX_AGE_MS,
  type HeldLine, type LullDropReason, type RoomTimingResult,
} from "../room-timing.js";

function harness(start = 1_000_000) {
  let t = start;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const released: HeldLine<string>[] = [];
  const dropped: { h: HeldLine<string>; why: LullDropReason }[] = [];
  const s = new LullScheduler<string>({
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    onRelease: (h) => released.push(h),
    onDrop: (h, why) => dropped.push({ h, why }),
  });
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = until;
  };
  const held = (over: Partial<HeldLine<string>> = {}): HeldLine<string> => ({
    channelId: "ch", messageId: "m1", side: "raziel", messageAt: t, reason: "human_volley", payload: "p", ...over,
  });
  return { s, advance, held, released, dropped, now: () => t, pendingTimers: () => timers.length };
}

describe("LullScheduler", () => {
  it("releases a held line after a minute of quiet", () => {
    const h = harness();
    h.s.hold(h.held());
    h.advance(LULL_MS - 1);
    expect(h.released).toHaveLength(0);
    h.advance(1);
    expect(h.released.map(x => x.messageId)).toEqual(["m1"]);
    expect(h.s.pending("ch")).toBeNull();
  });

  it("any message that is not mine restarts the lull", () => {
    const h = harness();
    h.s.hold(h.held());
    h.advance(40_000);
    h.s.noteMessage("ch", { side: "raziel", isSelf: false, messageId: "m2" });
    h.advance(40_000);
    expect(h.released).toHaveLength(0);
    h.advance(20_000);
    expect(h.released).toHaveLength(1);
  });

  it("the other human answering inside the burst drops it: it was theirs", () => {
    const h = harness();
    h.s.hold(h.held({ side: "raziel" }));
    h.advance(10_000);
    h.s.noteMessage("ch", { side: "blue", isSelf: false, messageId: "b1" });
    h.advance(LULL_MS);
    expect(h.released).toHaveLength(0);
    expect(h.dropped.map(d => d.why)).toEqual(["other_human"]);
  });

  it("sees the other human even when they answered BEFORE the hold registered (settle window race)", () => {
    const h = harness();
    const at = h.now();
    h.advance(2_000);
    h.s.noteMessage("ch", { side: "blue", isSelf: false, messageId: "b1" });
    h.advance(3_000); // the held turn reaches the gate after its settle
    h.s.hold(h.held({ messageAt: at }));
    h.advance(LULL_MS);
    expect(h.released).toHaveLength(0);
    expect(h.dropped.map(d => d.why)).toEqual(["other_human"]);
  });

  it("an earlier other-human line (the volley that caused the hold) does not drop it", () => {
    const h = harness();
    h.s.noteMessage("ch", { side: "blue", isSelf: false, messageId: "b0" });
    h.advance(20_000);
    h.s.hold(h.held({ messageAt: h.now() }));
    h.advance(LULL_MS);
    expect(h.released).toHaveLength(1);
  });

  it("my own post in the channel cancels the hold (I already spoke, e.g. named on a later line)", () => {
    const h = harness();
    h.s.hold(h.held());
    h.advance(5_000);
    h.s.noteMessage("ch", { side: null, isSelf: true, messageId: "me1" });
    expect(h.dropped.map(d => d.why)).toEqual(["self_spoke"]);
    h.advance(LULL_MS * 2);
    expect(h.released).toHaveLength(0);
    expect(h.pendingTimers()).toBe(0);
  });

  it("a newer held line replaces the older one: one answer for the burst", () => {
    const h = harness();
    h.s.hold(h.held({ messageId: "m1" }));
    h.advance(20_000);
    h.s.noteMessage("ch", { side: "raziel", isSelf: false, messageId: "m2" });
    h.s.hold(h.held({ messageId: "m2", messageAt: h.now() }));
    h.advance(LULL_MS);
    expect(h.released.map(x => x.messageId)).toEqual(["m2"]);
    expect(h.dropped.map(d => d.why)).toEqual(["replaced"]);
  });

  it("a held line older than the stale cap at release is dropped, not answered", () => {
    const h = harness();
    h.s.hold(h.held());
    // Chatter keeps the lull away (Raziel's lines to a named sibling), long past the cap.
    for (let i = 0; i < 12; i++) { h.advance(30_000); h.s.noteMessage("ch", { side: "raziel", isSelf: false, messageId: `x${i}` }); }
    expect(h.now() - 1_000_000).toBeGreaterThan(LULL_MAX_AGE_MS - LULL_MS);
    h.advance(LULL_MS);
    expect(h.released).toHaveLength(0);
    expect(h.dropped.map(d => d.why)).toEqual(["stale"]);
  });

  it("channels are independent", () => {
    const h = harness();
    h.s.hold(h.held({ channelId: "a", messageId: "a1" }));
    h.s.hold(h.held({ channelId: "b", messageId: "b1" }));
    h.s.noteMessage("a", { side: "blue", isSelf: false, messageId: "x" });
    h.advance(LULL_MS);
    expect(h.released.map(x => x.messageId)).toEqual(["b1"]);
    expect(h.dropped.map(d => d.h.messageId)).toEqual(["a1"]);
  });

  it("the held line's own id never counts as a message after it", () => {
    const h = harness();
    h.s.hold(h.held({ messageId: "m1" }));
    h.s.noteMessage("ch", { side: "blue", isSelf: false, messageId: "m1" });
    h.advance(LULL_MS);
    expect(h.released).toHaveLength(1);
  });

  it("a release callback that throws never wedges the scheduler", () => {
    let t = 0;
    let fire: (() => void) | null = null;
    const s = new LullScheduler<string>({
      now: () => t, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {},
      onRelease: () => { throw new Error("boom"); }, onDrop: () => {},
    });
    s.hold({ channelId: "c", messageId: "m", side: "raziel", messageAt: 0, reason: "flood", payload: "" });
    t = LULL_MS;
    expect(() => fire!()).not.toThrow();
    expect(s.pending("c")).toBeNull();
  });
});

describe("liveHoldApplies: which decisions the live cut acts on", () => {
  const r = (decision: RoomTimingResult["decision"], reason: RoomTimingResult["reason"]): RoomTimingResult => ({ decision, reason, react: false });
  it.each(["human_volley", "watch_along", "flood"] as const)("holds on the holder's %s", (reason) => {
    expect(liveHoldApplies(r("hold_for_lull", reason))).toBe(true);
  });
  it("never holds a room question: a cold question must not make all three wait", () => {
    expect(liveHoldApplies(r("hold_for_lull", "room_question"))).toBe(false);
  });
  it("stay_quiet and answer_now are inert in this cut", () => {
    expect(liveHoldApplies(r("stay_quiet", "not_mine"))).toBe(false);
    expect(liveHoldApplies(r("stay_quiet", "to_other_human"))).toBe(false);
    expect(liveHoldApplies(r("answer_now", "holder"))).toBe(false);
    expect(liveHoldApplies(null)).toBe(false);
  });
});

describe("ROOM_TIMING mode with a per-companion override", () => {
  it("default shadow; on and off read; garbage is shadow", () => {
    expect(roomTimingMode({})).toBe("shadow");
    expect(roomTimingMode({ ROOM_TIMING: " ON " })).toBe("on");
    expect(roomTimingMode({ ROOM_TIMING: "off" })).toBe("off");
    expect(roomTimingMode({ ROOM_TIMING: "yes please" })).toBe("shadow");
  });
  it("ROOM_TIMING_<COMPANION> wins for that companion only", () => {
    const env = { ROOM_TIMING: "shadow", ROOM_TIMING_DREVAN: "on" };
    expect(roomTimingMode(env, "drevan")).toBe("on");
    expect(roomTimingMode(env, "cypher")).toBe("shadow");
    expect(roomTimingMode({ ROOM_TIMING: "on", ROOM_TIMING_GAIA: "off" }, "gaia")).toBe("off");
    expect(roomTimingMode({ ROOM_TIMING_DREVAN: "" , ROOM_TIMING: "on" }, "drevan")).toBe("on");
  });
});
