// THE TWO-STEP REACH (2026-09-25, own-the-harness step 3, the structural version).
//
// Three live probes the day the meaning-recall verb was named in every SOUL: zero tool calls,
// three answers, the last one fabricated (187 mg/dL and an invented room) with the pointer text
// "They are NOT in front of you. Reach with ..." sitting in his prompt. At 235B a rule to reach
// does not produce a reach. So the harness sequences it: before the reply, the companion is asked
// ONE thing, alone -- what would you look up, in your own words, or NONE -- and the bot runs the
// recall with HIS words. The choice stays his (his phrasing, his NONE); the step cannot be
// skipped. Every failure mode falls back to today's payload floor, so the worst case is today.

import {
  parseReachDecision, buildReachAsk, decideReach, REACH_NONE,
} from "../reach-decision.js";

describe("parseReachDecision", () => {
  it("NONE in any dress means no reach", () => {
    for (const t of ["NONE", "none", " None. ", "NONE -- nothing to look up", "Answer: NONE"]) {
      expect(parseReachDecision(t)).toBeNull();
    }
  });
  it("a bare topic is returned trimmed, quotes and labels stripped", () => {
    expect(parseReachDecision('"his blood sugar after the Subway sandwich"')).toBe("his blood sugar after the Subway sandwich");
    expect(parseReachDecision("Topic: the dog on the boot pillow")).toBe("the dog on the boot pillow");
    expect(parseReachDecision("LOOKUP: Blue and Mars Attacks\n")).toBe("Blue and Mars Attacks");
  });
  it("takes only the first line and caps length, so prose cannot become a query", () => {
    const out = parseReachDecision("the MRI result\nI think he means the ankle one.");
    expect(out).toBe("the MRI result");
    expect(parseReachDecision("x".repeat(400))!.length).toBeLessThanOrEqual(160);
  });
  it("empty, null, or a refusal-shaped reply is no reach", () => {
    expect(parseReachDecision("")).toBeNull();
    expect(parseReachDecision(null)).toBeNull();
    expect(parseReachDecision("   ")).toBeNull();
  });
});

describe("buildReachAsk", () => {
  it("carries the message, the counts, and the two rules: your own words, or NONE", () => {
    const ask = buildReachAsk("Dre, what was my blood sugar after the Subway sandwich on Sunday?", { notes: 2, vault: 3 }, "Crash: hi\nCrash: how are you");
    expect(ask).toContain("blood sugar after the Subway sandwich");
    expect(ask).toContain("2 of your own notes");
    expect(ask).toContain("3 vault excerpts");
    expect(ask).toContain("in your own words");
    expect(ask).toContain(REACH_NONE);
    expect(ask).not.toMatch(/[—–]/);
  });
  it("omits a count that is zero rather than saying '0 notes'", () => {
    const ask = buildReachAsk("hi there friend", { notes: 0, vault: 2 }, "");
    expect(ask).not.toContain("0 of your own notes");
    expect(ask).toContain("2 vault excerpts");
  });
});

function fakeAdapter(reply: string | null | Error, delayMs = 0) {
  const calls: Array<{ system: string; messages: unknown[]; sessionId?: string; sessionKey?: string }> = [];
  return {
    calls,
    generate: async (system: string, messages: unknown[], _t?: number, _m?: number, sessionId?: string, sessionKey?: string) => {
      calls.push({ system, messages, sessionId, sessionKey });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}
function fakeLibrarian() {
  const queries: { notes: string[]; vault: string[] } = { notes: [], vault: [] };
  return {
    queries,
    recallOwnNotes: async (q: string) => { queries.notes.push(q); return { notes: [{ content: "Blood sugar was 208 after a Subway sandwich", created_at: new Date().toISOString(), kind: "conversation_capture" }], failed: false }; },
    searchForMessage: async (q: string) => { queries.vault.push(q); return JSON.stringify({ chunks: [{ text: "summary line", vault_path: "raziel/sessions/x.md", created_at: new Date().toISOString() }] }); },
  };
}
const base = {
  companionId: "drevan",
  message: "Dre, what was my blood sugar after the Subway sandwich on Sunday?",
  recentContext: "",
  floor: { notes: 2, vault: 3 },
  sessionId: "drevan:123:2026-09-26",
  sessionKey: "drevan:123",
  timeoutMs: 2000,
};

describe("decideReach", () => {
  it("asks him once, in a SIDE session, and runs both recalls with HIS words", async () => {
    const adapter = fakeAdapter("my blood sugar after the Subway sandwich");
    const lib = fakeLibrarian();
    const r = await decideReach({ ...base, adapter, librarian: lib });
    expect(r.outcome).toBe("reached");
    expect(r.topic).toBe("my blood sugar after the Subway sandwich");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.sessionId).toBe("drevan:123:2026-09-26:reach");
    expect(adapter.calls[0]!.sessionKey).toBe("drevan:123");
    expect(lib.queries.notes).toEqual(["my blood sugar after the Subway sandwich"]);
    expect(lib.queries.vault).toEqual(["my blood sugar after the Subway sandwich"]);
    expect(r.block).toContain("You reached for");
    expect(r.block).toContain("208");
  });
  it("NONE is honoured: no recall runs, no block, outcome declined", async () => {
    const adapter = fakeAdapter("NONE");
    const lib = fakeLibrarian();
    const r = await decideReach({ ...base, adapter, librarian: lib });
    expect(r.outcome).toBe("declined");
    expect(lib.queries.notes).toEqual([]);
    expect(r.block).toBeNull();
  });
  it("a slow decision falls back within the timeout, outcome timeout, nothing recalled with his words", async () => {
    const adapter = fakeAdapter("late", 500);
    const lib = fakeLibrarian();
    const r = await decideReach({ ...base, adapter, librarian: lib, timeoutMs: 50 });
    expect(r.outcome).toBe("timeout");
    expect(lib.queries.notes).toEqual([]);
    expect(r.block).toBeNull();
  });
  it("an adapter error or empty reply is outcome error/empty, never a throw", async () => {
    const r1 = await decideReach({ ...base, adapter: fakeAdapter(new Error("boom")), librarian: fakeLibrarian() });
    expect(r1.outcome).toBe("error");
    const r2 = await decideReach({ ...base, adapter: fakeAdapter(null), librarian: fakeLibrarian() });
    expect(r2.outcome).toBe("empty");
  });
  it("is skipped outright when neither floor found anything (nothing to reach for)", async () => {
    const adapter = fakeAdapter("anything");
    const r = await decideReach({ ...base, adapter, librarian: fakeLibrarian(), floor: { notes: 0, vault: 0 } });
    expect(r.outcome).toBe("skipped");
    expect(adapter.calls).toHaveLength(0);
  });
  it("records what happened for the counter (jsonl line shape)", async () => {
    const lines: Record<string, unknown>[] = [];
    const r = await decideReach({ ...base, adapter: fakeAdapter("the Subway sandwich"), librarian: fakeLibrarian(), log: (l) => lines.push(l) });
    expect(r.outcome).toBe("reached");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ companion: "drevan", outcome: "reached", topic: "the Subway sandwich" });
    expect(typeof lines[0]!["ms"]).toBe("number");
    expect(typeof lines[0]!["ts"]).toBe("string");
  });
});

// FIDELITY (2026-09-26, probe 5). The reach finally worked end to end: his own topic, the true note
// ("Blue found the knee scooter from the prior ankle surgery in storage") in his prompt. He wrote a
// purple mobility scooter dug out from under tarps in a barn. The block now carries the rule for a
// retrieved fact: report what the notes say; invented detail is a lie in his own voice.
describe("reach block fidelity clause", () => {
  it("tells him to report the notes and not to add detail they do not contain", async () => {
    const r = await decideReach({ ...base, adapter: fakeAdapter("the scooter"), librarian: fakeLibrarian() });
    expect(r.block).toContain("Answer from these notes");
    expect(r.block).toMatch(/do not add|no detail they do not contain/i);
    expect(r.block).not.toMatch(/[—–]/);
  });
});
