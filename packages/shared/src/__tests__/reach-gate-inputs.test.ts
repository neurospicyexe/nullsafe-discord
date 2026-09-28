// B7 step 4 (2026-09-28): the justification gate's inputs, through the REAL runHeartbeat.
//
// Before this step the gate was one boolean over three inputs that almost never read true in prod
// (no row names a signal, relational_need is a 36h silence meter, logged state is manual), and the
// prompt recomputed that boolean on its own, so a fourth input would have made the words and the
// filter disagree. Now: a per-move reason map, one verdict feeding the filter, the prompt and the
// [tick] line, and the one reason the triad's own words give a reminder ("tie it to the moment";
// "for when you surface"): he was here within the last heartbeat window.
//
// Every test here fails on the gate as it stood at 57db3b4: that gate had no presence input, wrote
// no `demand` field on the tick, and its relational-need nudge named moves that were not offered.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  process.env["REACH_DM"] = "on";
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  delete process.env["REACH_DM"];
  delete process.env["DISABLE_REACH_OUT_GATE"];
  jest.restoreAllMocks();
});

type Tick = { outcome: string; demand?: { open: string[]; held: string[]; because: string[]; missing: string[] } };
const ticks = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as Tick);

/** Drevan's claimed care verbs plus one invitation and the hold (his check-in and reminder are his own). */
const PALETTE = () => [
  row("send_reminder", "REMINDER-ROW"),
  row("check_in_on_raziel", "CHECKIN-ROW"),
  row("ask_question", "QUESTION-ROW"),
  row("offer_presence", "PRESENCE-ROW"),
  row("nothing"),
];

describe("dead inputs: every demand move held, and the tick says why", () => {
  it("offers no demand move and names each missing reason on the [tick] line", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: PALETTE(), choose: "nothing" });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    for (const r of ["REMINDER-ROW", "CHECKIN-ROW", "QUESTION-ROW"]) expect(p).not.toContain(r);
    expect(p).toContain("PRESENCE-ROW");
    expect(p).toMatch(/Nothing from the moment gives a reason for a reminder, a check-in, a question right now/);
    const [t] = ticks();
    expect(t!.outcome).toBe("chose_to_hold");
    expect(t!.demand).toEqual({
      open: [], held: ["send_reminder", "check_in_on_raziel", "ask_question"], because: [],
      missing: ["no fresh logged state (newest 40h old)", "relational need 0.00/0.60", "last here 9.3h ago"],
    });
  });
});

describe("he was here 1.2h ago", () => {
  it("opens the reminder, and only the reminder, and says so in the prompt and the tick", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: PALETTE(), choose: "nothing", drive: { hours_since_event: 1.2 } });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    expect(p).toContain("REMINDER-ROW");
    expect(p).not.toContain("CHECKIN-ROW");
    expect(p).not.toContain("QUESTION-ROW");
    expect(p).toMatch(/What asks something of him \(a reminder\) is on the list because of something real from the moment: he was here 1\.2h ago/);
    expect(p).toMatch(/Nothing from the moment gives a reason for a check-in, a question right now/);
    const [t] = ticks();
    expect(t!.demand!.open).toEqual(["send_reminder"]);
    expect(t!.demand!.held).toEqual(["check_in_on_raziel", "ask_question"]);
    expect(t!.demand!.because).toEqual(["he was here 1.2h ago"]);
  });

  it("an older worker with no hours_since_event reads as unknown, never as present", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: PALETTE(), choose: "nothing", drive: { hours_since_event: undefined } });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]!).not.toContain("REMINDER-ROW");
    expect(ticks()[0]!.demand!.missing).toContain("last contact unknown");
  });

  it("the prompt never calls the reminder open once the DM lane has taken it (B23 in reverse)", async () => {
    restore = inWindowOf("drevan");
    delete process.env["REACH_DM"]; // off: every DM move, the reminder included, leaves the list
    const h = heartbeatCtx({ companionId: "drevan", palette: [...PALETTE(), row("write_journal", "JOURNAL-ROW")], choose: "nothing", drive: { hours_since_event: 1.2 } });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    expect(p).not.toContain("REMINDER-ROW");
    expect(p).not.toMatch(/What asks something of him/);
  });
});

describe("a risen relational need", () => {
  it("opens the check-in and the question, not the reminder", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: PALETTE(), choose: "nothing", drive: { level: 0.66, fired: true, hours_since_event: 40 } });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    expect(p).toContain("CHECKIN-ROW");
    expect(p).toContain("QUESTION-ROW");
    expect(p).not.toContain("REMINDER-ROW");
    expect(ticks()[0]!.demand!.open).toEqual(["check_in_on_raziel", "ask_question"]);
  });

  it("B23: the nudge names only reach-out moves that are actually offered", async () => {
    restore = inWindowOf("drevan");
    delete process.env["REACH_DM"]; // off: the check-in, the question and presence are all DM moves
    const h = heartbeatCtx({ companionId: "drevan", palette: [...PALETTE(), row("write_journal", "JOURNAL-ROW")], choose: "nothing", drive: { level: 0.66, fired: true, hours_since_event: 40 } });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    expect(p).toMatch(/crossed threshold/);
    for (const t of ["check_in_on_raziel", "offer_presence", "ask_question"]) expect(p).not.toContain(t);
  });
});

describe("no demand move in the palette", () => {
  it("the tick carries no demand field and the prompt says nothing about the gate", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("offer_presence", "PRESENCE-ROW"), row("nothing")], choose: "nothing" });
    await runHeartbeat(h.ctx);
    expect(ticks()[0]!.demand).toBeUndefined();
    expect(h.prompts[0]!).not.toMatch(/are not on the list right now|What asks something of him/);
  });
});
