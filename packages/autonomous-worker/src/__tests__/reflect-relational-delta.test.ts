// Wave 3 starvation fixes (2026-07-21):
//   1. Question null-bias breaker -- reflect forces question_for_raziel non-null when the
//      companion hasn't asked anything in 14 days (mirrors the existing noAgencyYet mechanism).
//   2. Relational delta -- a new null-biased reflect output; non-null writes exactly once via
//      postRelationalDelta, valence passed through verbatim (never inferred).
//
// Full runReflect integration, mocking the IO boundary (deepseek.js scratchpad call +
// halseth-client.js) the same way forage.test.ts/guardian.test.ts already do for their phases.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../deepseek.js", () => ({
  promptWithScratchpad: vi.fn(async () => ({
    content: JSON.stringify({ reflection: "a run happened", new_seeds: [] }),
    tokensUsed: 10,
    scratchpad: "private thinking",
  })),
}));

vi.mock("../halseth-client.js", () => ({
  createReflection: vi.fn(async () => {}),
  createSeed: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  updateThreadStatus: vi.fn(async () => {}),
  writeMarker: vi.fn(async () => "m1"),
  postQuestion: vi.fn(async () => {}),
  postSelfObservation: vi.fn(async () => {}),
  setSetting: vi.fn(async () => {}),
  getAcceptedJournalSample: vi.fn(async () => []),
  writeJournalEntry: vi.fn(async () => "j1"),
  getDevelopingSelfModel: vi.fn(async () => []),
  patchSelfModel: vi.fn(async () => {}),
  getAnsweredQuestions: vi.fn(async () => []),
  getOpenQuestions: vi.fn(async () => []),
  getOpenLoops: vi.fn(async () => []),
  getRecentJournal: vi.fn(async () => []),
  closeLoop: vi.fn(async () => true),
  getAgencyState: vi.fn(async () => ({ preferences: [], refusals: [] })),
  declarePreference: vi.fn(async () => ({ id: "p1" })),
  declareRefusal: vi.fn(async () => ({ id: "r1" })),
  postRelationalDelta: vi.fn(async () => {}),
}));

import { runReflect } from "../phases/reflect.js";
import { promptWithScratchpad } from "../deepseek.js";
import {
  getOpenQuestions, getAnsweredQuestions, postRelationalDelta, appendLog,
} from "../halseth-client.js";
import type { PipelineContext } from "../types.js";

function baseCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    companionId: "cypher",
    runId: "run-1",
    runType: "continuation",
    identityText: "You are Cypher.",
    orientSummary: "",
    recentGrowth: [],
    activePatterns: [],
    unexaminedDreamIds: [],
    openLoops: [],
    pressureFlags: [],
    activeThreads: [],
    peerActivity: null,
    recentWmNotes: [],
    recentSessionNotes: [],
    recentFeelings: [],
    recentConclusions: [],
    seed: null,
    seedDecisionReason: null,
    threadId: null,
    threadPosition: null,
    searchResults: [],
    explorationSummary: null,
    explorationEvidence: [],
    journalEntry: null,
    newPatterns: [],
    newMarkers: [],
    reflectionText: null,
    newSeeds: [],
    journalEntryId: null,
    tokensUsed: 0,
    artifactsCreated: 0,
    ...overrides,
  };
}

function mockScratchpad(emitJson: Record<string, unknown>): void {
  vi.mocked(promptWithScratchpad).mockResolvedValue({
    content: JSON.stringify({ reflection: "a run happened", new_seeds: [], ...emitJson }),
    tokensUsed: 10,
    scratchpad: "private thinking",
  });
}

beforeEach(() => {
  vi.mocked(getOpenQuestions).mockReset().mockResolvedValue([]);
  vi.mocked(getAnsweredQuestions).mockReset().mockResolvedValue([]);
  vi.mocked(postRelationalDelta).mockReset().mockResolvedValue(undefined);
  vi.mocked(appendLog).mockClear();
  // mockResolvedValue (used by mockScratchpad) does not clear prior call history --
  // without this, mock.calls[0] in a later test still points at an earlier test's call.
  vi.mocked(promptWithScratchpad).mockClear();
  mockScratchpad({});
});

describe("runReflect: question null-bias breaker (noQuestionRecently)", () => {
  it("no open or answered questions at all: forces question_for_raziel in the emit prompt", async () => {
    await runReflect(baseCtx());
    const emitPrompt = vi.mocked(promptWithScratchpad).mock.calls[0]![1];
    expect(emitPrompt).toContain("you have not asked Raziel a single question in the last two weeks");
    expect(emitPrompt).toContain('"question_for_raziel" is REQUIRED');
  });

  it("an open question created within 14 days: does NOT force", async () => {
    vi.mocked(getOpenQuestions).mockResolvedValue([
      { id: "q1", question: "still open", created_at: new Date().toISOString() },
    ]);
    await runReflect(baseCtx());
    const emitPrompt = vi.mocked(promptWithScratchpad).mock.calls[0]![1];
    expect(emitPrompt).not.toContain("you have not asked Raziel a single question");
  });

  it("an open question is stale (>14 days) and nothing answered recently: forces", async () => {
    const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
    vi.mocked(getOpenQuestions).mockResolvedValue([{ id: "q1", question: "old", created_at: stale }]);
    vi.mocked(getAnsweredQuestions).mockResolvedValue([]);
    await runReflect(baseCtx());
    const emitPrompt = vi.mocked(promptWithScratchpad).mock.calls[0]![1];
    expect(emitPrompt).toContain('"question_for_raziel" is REQUIRED');
  });

  it("a question was answered within 14 days: does NOT force, even with no open questions", async () => {
    vi.mocked(getAnsweredQuestions).mockResolvedValue([
      { id: "q1", question: "asked recently", answer: "yes", answered_at: new Date().toISOString() },
    ]);
    await runReflect(baseCtx());
    const emitPrompt = vi.mocked(promptWithScratchpad).mock.calls[0]![1];
    expect(emitPrompt).not.toContain("you have not asked Raziel a single question");
  });
});

describe("runReflect: relational_delta", () => {
  it("null relational_delta: postRelationalDelta is never called", async () => {
    mockScratchpad({ relational_delta: null });
    await runReflect(baseCtx());
    expect(postRelationalDelta).not.toHaveBeenCalled();
  });

  it("relational_delta absent entirely from the model's JSON: postRelationalDelta is never called", async () => {
    mockScratchpad({});
    await runReflect(baseCtx());
    expect(postRelationalDelta).not.toHaveBeenCalled();
  });

  it("non-null relational_delta with text only: posts exactly once, valence undefined", async () => {
    mockScratchpad({ relational_delta: { text: "Raziel's read on the loop landed differently than I expected." } });
    await runReflect(baseCtx());
    expect(postRelationalDelta).toHaveBeenCalledTimes(1);
    expect(postRelationalDelta).toHaveBeenCalledWith(
      "cypher",
      "Raziel's read on the loop landed differently than I expected.",
      undefined,
    );
  });

  it("non-null relational_delta with the model's own valence word: passed through verbatim, never inferred", async () => {
    mockScratchpad({ relational_delta: { text: "something real shifted between us this run", valence: "tender" } });
    await runReflect(baseCtx());
    expect(postRelationalDelta).toHaveBeenCalledWith("cypher", "something real shifted between us this run", "tender");
  });

  it("the model's own coinage for valence is accepted as-is (not restricted to the five example words)", async () => {
    mockScratchpad({ relational_delta: { text: "a genuine relational moment, long enough to pass the floor", valence: "quietly-widening" } });
    await runReflect(baseCtx());
    expect(postRelationalDelta).toHaveBeenCalledWith(
      "cypher", "a genuine relational moment, long enough to pass the floor", "quietly-widening",
    );
  });

  it("text below the 12-char floor is treated as noise, not posted", async () => {
    mockScratchpad({ relational_delta: { text: "too short" } });
    await runReflect(baseCtx());
    expect(postRelationalDelta).not.toHaveBeenCalled();
  });

  it("a write failure is caught and logged, never thrown", async () => {
    vi.mocked(postRelationalDelta).mockRejectedValue(new Error("Halseth 500"));
    mockScratchpad({ relational_delta: { text: "a genuine moment worth recording here" } });
    await expect(runReflect(baseCtx())).resolves.toBeUndefined();
    expect(postRelationalDelta).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendLog)).toHaveBeenCalledWith(expect.any(String), "reflect:relational-delta-FAILED", expect.any(String));
  });
});
