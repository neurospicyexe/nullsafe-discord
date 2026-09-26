import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { runWritebackGate, dispatchWriteback, type WritebackLibrarian } from "../writeback-gate.js";
import type { InferenceAdapter } from "../inference.js";
import type { JevAnswers } from "../jev-gate.js";

// ── Why this file exists ─────────────────────────────────────────────────────
// The gate sits on the path that decides what the companions carry between sessions. Three
// modes, and the invariant that matters most is the one about FAILING OPEN: a Jev outage must
// land on today's generative judge, never on silence. `shadowLog` is injected in every test so
// the default /app/logs path is never touched.

const OWNER = { name: "Raziel", isOwner: true as const, ownerName: "Raziel" };

/** Content that clears `meetsNoteThreshold` so the legacy judge actually reaches the model. */
const USER_MSG = "I decided to stop the project and I ate something";
const REPLY = "That lands. Good.";

function fakeLibrarian() {
  const calls: Array<[string, unknown]> = [];
  const lib: WritebackLibrarian = {
    addCompanionNote: async (c, ch) => { calls.push(["addCompanionNote", [c, ch]]); },
    writeWmNote: async (c, ch) => { calls.push(["writeWmNote", [c, ch]]); },
    witnessLog: async (c, ch) => { calls.push(["witnessLog", [c, ch]]); },
    addLiveThread: async (p) => { calls.push(["addLiveThread", p]); },
  };
  return { lib, calls, names: () => calls.map((c) => c[0]) };
}

function fakeInference(reply: string | null) {
  const prompts: string[] = [];
  const adapter: InferenceAdapter = {
    generate: async (_system, messages) => {
      prompts.push(messages.map((m) => m.content).join("\n"));
      return reply;
    },
  };
  return { adapter, prompts };
}

/** Runs the queued fn immediately so assertions do not have to await a real write queue. */
function immediateEnqueue() {
  const labels: string[] = [];
  const done: Array<Promise<void>> = [];
  const enqueue = (label: string, fn: () => Promise<void>) => {
    labels.push(label);
    done.push(fn());
  };
  return { enqueue, labels, settle: () => Promise.all(done) };
}

function answers(over: Record<string, unknown> = {}): JevAnswers {
  return {
    worth_remembering: { type: "noul", noul: 0.9 },
    kind: { type: "choice", choice: "companion_note", confidence: 1, probabilities: { companion_note: 0.9, none: 0.1 } },
    salience: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} },
    affective_weight: { type: "score", score: 2, confidence: 1, legend: {}, probabilities: {} },
    recurring_thread: { type: "noul", noul: 0.2 },
    lane_drift: { type: "noul", noul: 0.05 },
    ...over,
  } as JevAnswers;
}

function jevOk(over: Record<string, unknown> = {}) {
  return jest.fn(async () => ({ ok: true as const, answers: answers(over), latency_ms: 30, wall_ms: 35 }));
}

const CLEAN_ENV = {} as NodeJS.ProcessEnv;

function ctx(over: Record<string, unknown>) {
  return {
    companionId: "cypher",
    speaker: OWNER,
    userMessage: USER_MSG,
    assistantResponse: REPLY,
    channelId: "chan-1",
    messageId: "msg-1",
    env: CLEAN_ENV,
    ...over,
  } as Parameters<typeof runWritebackGate>[0];
}

let warnSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------

describe("runWritebackGate() -- legacy mode", () => {
  it("dispatches a companion_note to both the journal and the wm note, as today", async () => {
    const { lib, calls, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: companion_note\nCONTENT: Something shifted between us.");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();
    const jevEval = jest.fn();

    await runWritebackGate(ctx({
      mode: "legacy", inference: adapter, librarian: lib, enqueue: q.enqueue,
      shadowLog, jevEval: jevEval as never,
    }));
    await q.settle();

    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
    expect(calls[0][1]).toEqual(["Something shifted between us.", "chan-1"]);
    expect(calls[1][1]).toEqual(["[discord:observation] Something shifted between us.", "chan-1"]);
    expect(q.labels).toEqual(["writeback:chan-1"]);
    expect(jevEval).not.toHaveBeenCalled();
    expect(shadowLog).not.toHaveBeenCalled();
  });

  it("dispatches a witness_log", async () => {
    const { lib, calls, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: witness_log\nCONTENT: They ate.");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({ mode: "legacy", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn() }));
    await q.settle();
    expect(names()).toEqual(["witnessLog"]);
    expect(calls[0][1]).toEqual(["They ate.", "chan-1"]);
  });

  it("dispatches a thread_open", async () => {
    const { lib, calls, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: thread_open\nCONTENT: This keeps surfacing.\nTHREAD_NAME: the project");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({ mode: "legacy", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn() }));
    await q.settle();
    expect(names()).toEqual(["addLiveThread"]);
    expect(calls[0][1]).toEqual({ name: "the project", notes: "This keeps surfacing." });
  });

  it("writes nothing when the judge skips", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: skip\nCONTENT:");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({ mode: "legacy", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn() }));
    await q.settle();
    expect(names()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("runWritebackGate() -- jev-shadow mode", () => {
  it("writes the judge's result and logs exactly one shadow line", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: companion_note\nCONTENT: A read that held.");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();
    const jevEval = jevOk();

    await runWritebackGate(ctx({
      mode: "jev-shadow", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog, jevEval,
      now: () => 1_700_000_000_000,
    }));
    await q.settle();

    // Writes are unchanged in shadow.
    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
    expect(jevEval).toHaveBeenCalledTimes(1);
    expect(shadowLog).toHaveBeenCalledTimes(1);

    const line = shadowLog.mock.calls[0][0] as Record<string, unknown>;
    for (const k of [
      "ts", "mode", "companion", "channel_id", "message_id", "speaker", "speaker_name",
      "judge", "jev_ok", "worth", "kind", "kind_probs", "salience", "affect", "recurring",
      "drift", "drift_flag", "would_write", "would_promote", "latency_ms", "wall_ms",
    ]) {
      expect(Object.keys(line)).toContain(k);
    }
    expect(line).toMatchObject({
      mode: "jev-shadow", companion: "cypher", channel_id: "chan-1", message_id: "msg-1",
      speaker: "owner", speaker_name: "Raziel", judge: "companion_note", jev_ok: true,
      worth: 0.9, kind: "companion_note", salience: 3, affect: 2, recurring: 0.2,
      drift: 0.05, drift_flag: false, would_write: true, would_promote: true,
      latency_ms: 30, wall_ms: 35,
    });
    expect(line.ts).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("records a Jev failure without touching the write path", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: companion_note\nCONTENT: Still written.");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();
    const jevEval = jest.fn(async () => ({ ok: false as const, reason: "http_502", status: 502, wall_ms: 12 }));

    await runWritebackGate(ctx({
      mode: "jev-shadow", inference: adapter, librarian: lib, enqueue: q.enqueue,
      shadowLog, jevEval: jevEval as never,
    }));
    await q.settle();

    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
    expect(shadowLog).toHaveBeenCalledTimes(1);
    expect(shadowLog.mock.calls[0][0]).toMatchObject({ jev_ok: false, reason: "http_502" });
  });

  it("warns when the reply drifted out of the companion's lane", async () => {
    const { lib } = fakeLibrarian();
    const { adapter } = fakeInference("ACTION: skip\nCONTENT:");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({
      mode: "jev-shadow", inference: adapter, librarian: lib, enqueue: q.enqueue,
      shadowLog: jest.fn(), jevEval: jevOk({ lane_drift: { type: "noul", noul: 0.8 } }),
    }));
    await q.settle();
    const drift = warnSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("[jev-gate] drift"));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("companion=cypher");
    expect(drift[0]).toContain("message=msg-1");
  });
});

// ---------------------------------------------------------------------------

describe("runWritebackGate() -- jev mode", () => {
  it("spends no generative call at all when Jev says the exchange is not worth remembering", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter, prompts } = fakeInference("ACTION: companion_note\nCONTENT: should never run");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();

    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog,
      jevEval: jevOk({ worth_remembering: { type: "noul", noul: 0.2 } }),
    }));
    await q.settle();

    expect(prompts).toHaveLength(0);
    expect(names()).toEqual([]);
    expect(shadowLog).toHaveBeenCalledTimes(1);
    expect(shadowLog.mock.calls[0][0]).toMatchObject({ decided: "skip", would_write: false });
  });

  it("authors with the decided kind and no ACTION menu, then dispatches", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter, prompts } = fakeInference("CONTENT: We named the thing.");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();

    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog, jevEval: jevOk(),
    }));
    await q.settle();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("ACTION:");
    expect(prompts[0]).not.toContain("- skip: nothing worth logging.");
    expect(prompts[0]).toContain("You have decided this exchange deserves a companion_note. Write it.");
    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
    expect(shadowLog.mock.calls[0][0]).toMatchObject({ decided: "companion_note" });
  });

  it("keeps a below-notable note out of wm_continuity_notes", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter } = fakeInference("CONTENT: A small thing.");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn(),
      jevEval: jevOk({ salience: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } }),
    }));
    await q.settle();
    expect(names()).toEqual(["addCompanionNote"]);
  });

  it("promotes a notable note to wm_continuity_notes", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter } = fakeInference("CONTENT: A big thing.");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn(),
      jevEval: jevOk({ salience: { type: "score", score: 4, confidence: 1, legend: {}, probabilities: {} } }),
    }));
    await q.settle();
    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
  });

  it("tells the author not to carry a drifted register into the memory", async () => {
    const { lib } = fakeLibrarian();
    const { adapter, prompts } = fakeInference("CONTENT: What actually happened.");
    const q = immediateEnqueue();
    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog: jest.fn(),
      jevEval: jevOk({ lane_drift: { type: "noul", noul: 0.95 } }),
    }));
    await q.settle();
    expect(prompts[0]).toContain("drifted out of your own register");
  });

  it("falls open to the legacy judge when Jev is unreachable", async () => {
    const { lib, names } = fakeLibrarian();
    const { adapter, prompts } = fakeInference("ACTION: companion_note\nCONTENT: Written anyway.");
    const q = immediateEnqueue();
    const shadowLog = jest.fn();
    const jevEval = jest.fn(async () => ({ ok: false as const, reason: "no_halseth_env", wall_ms: 0 }));

    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue,
      shadowLog, jevEval: jevEval as never,
    }));
    await q.settle();

    // The legacy ACTION prompt, not the authoring prompt.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("ACTION: <one of the above>");
    expect(names()).toEqual(["addCompanionNote", "writeWmNote"]);
    const fb = warnSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("fallback=legacy"));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toContain("reason=no_halseth_env");
    expect(shadowLog.mock.calls[0][0]).toMatchObject({ jev_ok: false, fallback: "legacy" });
  });

  it("writes nothing when the authoring call fails", async () => {
    const { lib, names } = fakeLibrarian();
    const adapter: InferenceAdapter = { generate: async () => { throw new Error("gateway down"); } };
    const q = immediateEnqueue();
    const shadowLog = jest.fn();
    await runWritebackGate(ctx({
      mode: "jev", inference: adapter, librarian: lib, enqueue: q.enqueue, shadowLog, jevEval: jevOk(),
    }));
    await q.settle();
    expect(names()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(shadowLog.mock.calls[0][0]).toMatchObject({ decided: "author_failed" });
  });
});

// KEYED JUDGE WRITES (2026-09-26). The memory-judge's companion_note went through the Librarian NL
// path, which cannot set external_id, so its rows were unkeyed: the note memorialising Drevan's
// fabricated 187 had to be found by content and archived by hand. Now the judge journals through
// the same REST path speech uses, keyed `judge:<user message id>`, and the promoted wm note carries
// the same key as correlation_id, so `<prefix>: retract` can reach both.
describe("dispatchWriteback -- keyed judge writes", () => {
  it("uses journalJudgeNote with the message id when the librarian offers it, and keys the wm note", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const lib: WritebackLibrarian = {
      addCompanionNote: async (...a) => { calls.push(["addCompanionNote", a]); },
      journalJudgeNote: async (...a) => { calls.push(["journalJudgeNote", a]); },
      writeWmNote: async (...a) => { calls.push(["writeWmNote", a]); },
      witnessLog: async (...a) => { calls.push(["witnessLog", a]); },
      addLiveThread: async (p) => { calls.push(["addLiveThread", [p]]); },
    };
    await dispatchWriteback({ type: "companion_note", content: "he said 208" }, lib, { promoteToWm: true, channelId: "chan", messageId: "M1" });
    expect(calls.map(c => c[0])).toEqual(["journalJudgeNote", "writeWmNote"]);
    expect(calls[0]![1]).toEqual(["he said 208", "chan", "M1"]);
    expect(calls[1]![1][3]).toBe("judge:M1");
  });
  it("falls back to addCompanionNote when the librarian has no keyed writer (older fakes, other callers)", async () => {
    const { lib, calls } = fakeLibrarian();
    await dispatchWriteback({ type: "companion_note", content: "x" }, lib, { promoteToWm: false, channelId: "chan", messageId: "M1" });
    expect(calls.map(c => c[0])).toEqual(["addCompanionNote"]);
  });
});
