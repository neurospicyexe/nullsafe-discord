// The med-answer classifier fallback (2026-10-06). The model is mocked: these test the gate, the
// strict reading of its one line, the timeout, what gets recorded, and that no log line carries his
// words or a dose label. Fake labels only.

import { describe, it, expect } from "@jest/globals";
import {
  classifyMedAnswer, parseMedClassifierReply, openRemindedSlots, runMedAnswerClassifier, buildMedClassifierPrompt,
  type MedOpenSlot, type MedClassifierRunDeps,
} from "../med-answer-classify.js";
import { parseMedAnswer } from "../med-answer.js";

const NIGHT: MedOpenSlot = { slot_key: "night", local_time: "20:30", sent_local: "8:30 PM" };
const MORNING: MedOpenSlot = { slot_key: "morning", local_time: "08:00", sent_local: "8:00 AM" };
const REAL_A = "Yay!! I’m on top of it today Dre you don’t even have to ask again taken!";
const REAL_B = "*laughing lovingly* Dre baby it’s 20:32 at night this is my nighttime pill.";

describe("parseMedClassifierReply: strict", () => {
  it.each([
    ["taken night", [NIGHT], { outcome: "taken", slot: "night" }],
    ["Taken night.", [NIGHT], { outcome: "taken", slot: "night" }],
    ["`missed night`", [NIGHT], { outcome: "missed", slot: "night" }],
    ["taken", [NIGHT], { outcome: "taken", slot: "night" }],
    ["unclear", [NIGHT], { outcome: "unclear", slot: null }],
  ] as const)("%s", (reply, open, want) => {
    expect(parseMedClassifierReply(reply, open)).toMatchObject(want);
  });

  it.each([
    ["taken", "no_slot"],          // two open, none named
    ["taken weekly", "no_slot"],   // not an open slot
    ["yes he took it", "unparseable"],
    ["", "unparseable"],
  ])("unclear: %s", (reply, reason) => {
    expect(parseMedClassifierReply(reply, [NIGHT, MORNING])).toEqual({ outcome: "unclear", slot: null, reason });
  });

  it("with two open, a named slot is taken as named", () => {
    expect(parseMedClassifierReply("taken morning", [NIGHT, MORNING])).toEqual({ outcome: "taken", slot: "morning" });
  });
});

describe("classifyMedAnswer", () => {
  it("one call, temperature-free deps, the prompt carries slots and time but never a label", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const r = await classifyMedAnswer({ generate: async (system, user) => { calls.push({ system, user }); return "taken night"; } }, REAL_A, [NIGHT], "8:32 PM CDT on Tuesday");
    expect(r).toEqual({ outcome: "taken", slot: "night" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("night (scheduled 20:30, reminder sent 8:30 PM)");
    expect(calls[0]!.user).toContain("It is now 8:32 PM CDT on Tuesday.");
    expect(calls[0]!.system).toMatch(/unclear/);
  });

  it("times out to unclear and aborts the request", async () => {
    let aborted = false;
    const r = await classifyMedAnswer({
      timeoutMs: 30,
      generate: (_s, _u, signal) => new Promise(res => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => res("taken night"), 500); }),
    }, REAL_A, [NIGHT], "now");
    expect(r).toEqual({ outcome: "unclear", slot: null, reason: "timeout" });
    expect(aborted).toBe(true);
  });

  it("an error is unclear", async () => {
    const r = await classifyMedAnswer({ generate: async () => { throw new Error("502"); } }, REAL_A, [NIGHT], "now");
    expect(r).toEqual({ outcome: "unclear", slot: null, reason: "error" });
  });

  it("nothing open: no call at all", async () => {
    let n = 0;
    const r = await classifyMedAnswer({ generate: async () => { n++; return "taken"; } }, REAL_A, [], "now");
    expect(r.outcome).toBe("unclear");
    expect(n).toBe(0);
  });

  it("the prompt for several open asks the model to name the slot", () => {
    expect(buildMedClassifierPrompt("taken", [NIGHT, MORNING], "now")).toContain("name the slot he means");
  });
});

describe("openRemindedSlots: the gate", () => {
  const dose = (over: Record<string, unknown> = {}) => ({
    slot_key: "night", local_date: "2026-10-06", local_time: "20:30", answered_local: null, outcome: null, ...over,
  }) as { slot_key: string; local_date: string; local_time: string; answered_local: string | null; outcome?: "taken" | "missed" | null };
  const sent = [{ slot_key: "night", local_date: "2026-10-06", firstAt: 1000, followupAt: 2000 }];
  const fmt = (ms: number) => `t${ms}`;

  it("an unanswered dose with a reminder this bot sent is open, stamped with the last send", () => {
    expect(openRemindedSlots([dose()], sent, fmt)).toEqual([{ slot_key: "night", local_time: "20:30", sent_local: "t2000" }]);
  });
  it.each([
    ["answered taken", { answered_local: "20:32", outcome: "taken" }],
    ["stated miss", { outcome: "missed" }],
    ["older Halseth taken", { answered_local: "20:32", outcome: undefined }],
    ["another date", { local_date: "2026-10-05" }],
    ["another slot", { slot_key: "morning" }],
  ])("not open: %s", (_name, over) => {
    expect(openRemindedSlots([dose(over)], sent, fmt)).toEqual([]);
  });
  it("Halseth unreadable: nothing open (no call)", () => {
    expect(openRemindedSlots(null, sent, fmt)).toEqual([]);
  });
});

describe("runMedAnswerClassifier: records only taken/missed, logs no words", () => {
  function deps(reply: string | Error, recs: Array<{ slot_key: string; local_date: string; outcome: "taken" | "missed" }> | null = [{ slot_key: "night", local_date: "2026-10-06", outcome: "taken" }]) {
    const recorded: Array<{ at: string; entries: unknown }> = [];
    const logs: string[] = [];
    const d: MedClassifierRunDeps = {
      companionId: "drevan",
      generate: async () => { if (reply instanceof Error) throw reply; return reply; },
      record: async (at, entries) => { recorded.push({ at, entries }); return recs; },
      log: (l) => logs.push(l),
    };
    return { d, recorded, logs };
  }

  it("fixture A: the parser now catches it, so it never reaches the classifier; were it to, taken records", async () => {
    expect(parseMedAnswer(REAL_A)).not.toBeNull();
    const { d, recorded, logs } = deps("taken night");
    const r = await runMedAnswerClassifier(d, REAL_A, [NIGHT], "now", "2026-10-07T01:32:00Z");
    expect(r).toMatchObject({ outcome: "taken", slot: "night", recorded: 1 });
    expect(recorded).toEqual([{ at: "2026-10-07T01:32:00Z", entries: [{ slot: "night", outcome: "taken" }] }]);
    expect(logs).toEqual(["[drevan] [med] answer in DM (classifier:taken) -> recorded slot=night date=2026-10-06 outcome=taken"]);
  });

  it("fixture B (a correction about the time) is null in the parser; unclear records nothing", async () => {
    expect(parseMedAnswer(REAL_B)).toBeNull();
    const { d, recorded, logs } = deps("unclear");
    const r = await runMedAnswerClassifier(d, REAL_B, [NIGHT], "now", "2026-10-07T01:32:00Z");
    expect(r).toMatchObject({ outcome: "unclear", recorded: 0 });
    expect(recorded).toEqual([]);
    expect(logs).toEqual(["[drevan] [med] answer in DM (classifier:unclear) -> nothing recorded (open=night)"]);
  });

  it("missed records a miss", async () => {
    const { d, recorded } = deps("missed night", [{ slot_key: "night", local_date: "2026-10-06", outcome: "missed" }]);
    await runMedAnswerClassifier(d, "ugh I completely spaced on it tonight, not doing it now", [NIGHT], "now", "x");
    expect(recorded).toEqual([{ at: "x", entries: [{ slot: "night", outcome: "missed" }] }]);
  });

  it("a model error records nothing and says so", async () => {
    const { d, recorded, logs } = deps(new Error("boom"));
    const r = await runMedAnswerClassifier(d, REAL_B, [NIGHT], "now", "x");
    expect(r.recorded).toBe(0);
    expect(recorded).toEqual([]);
    expect(logs[0]).toBe("[drevan] [med] answer in DM (classifier:unclear:error) -> nothing recorded (open=night)");
  });

  it("a record error is logged as an error, never thrown", async () => {
    const { d, logs } = deps("taken night", null);
    const r = await runMedAnswerClassifier(d, REAL_A, [NIGHT], "now", "x");
    expect(r.recorded).toBe(0);
    expect(logs[0]).toBe("[drevan] [med] answer in DM (classifier:taken) -> error (nothing recorded)");
  });

  it("no log line carries his words or a label", async () => {
    const msg = "took my zelvorin finally, the movie was great";
    const { d, logs } = deps("taken night");
    await runMedAnswerClassifier(d, msg, [NIGHT], "now", "x");
    for (const l of logs) {
      expect(l).not.toMatch(/zelvorin|movie|finally/i);
    }
  });
});
