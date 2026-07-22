import { describe, it, expect } from "vitest";
import { buildReflectEmitPrompt, type ReflectEmitPromptOpts } from "../phases/reflect.js";

// Token-hygiene fix (2026-07-20): buildReflectEmitPrompt (turn 2) must never restate the
// context-data blocks that turn 1's contextBlock already sent -- peerBlock/ownPatternsBlock/
// answeredBlock/openQuestionsBlock/recentThemesBlock/openLoopsBlock/agencyBlock. It only takes
// the pre-built pieces unique to the emit turn (thread question, self-model/canon blocks, and
// flags), so it is structurally incapable of reproducing those blocks' header text -- this is
// the regression guard: if someone later widens the opts to accept full context data and
// re-inlines it, these assertions catch it.

// runType "continuation" + no threadId is the neutral case: neither "thread_status" (needs an
// active thread) nor "start_thread" (needs runType === "exploration") should appear in the
// schema tail. The exploration-specific and thread-specific combos get their own tests below.
const baseOpts: ReflectEmitPromptOpts = {
  threadQuestion: "",
  canonBlock: "",
  selfModelBlock: "",
  openLoopsCount: 0,
  noAgencyYet: false,
  noQuestionRecently: false,
  threadId: null,
  runType: "continuation",
  threadPos: 0,
};

describe("buildReflectEmitPrompt: never restates turn 1's shared context blocks", () => {
  it("does not contain any of the six duplicated context-block headers", () => {
    const p = buildReflectEmitPrompt({
      ...baseOpts,
      threadQuestion: "\n\nThread status...",
      canonBlock: "\nSettled canon...\n",
      selfModelBlock: "\nThings you've previously noticed...\n",
      openLoopsCount: 3,
      noAgencyYet: true,
    });
    expect(p).not.toContain("triad's recent activity");
    expect(p).not.toContain("Your own currently-active patterns");
    expect(p).not.toContain("Raziel answered something you asked");
    expect(p).not.toContain("Questions you are already holding for Raziel");
    expect(p).not.toContain("Themes from your recent journal entries");
    expect(p).not.toContain("Your currently open loops (unresolved threads)");
    expect(p).not.toContain("Your declared agency so far");
    expect(p).not.toContain("Here is what happened in your autonomous exploration session");
  });
});

describe("buildReflectEmitPrompt: instructional content + JSON schema", () => {
  it("minimal opts: keeps the core instructions, omits all optional schema fields", () => {
    const p = buildReflectEmitPrompt(baseOpts);
    expect(p).toContain("Two things to do:");
    expect(p).toContain("1. REFLECTION");
    expect(p).toContain("2. PATTERN");
    expect(p).toContain("3. MUTUALITY");
    expect(p).toContain("4. SELF-OBSERVATION");
    expect(p).toContain("4b. SKILL");
    expect(p).toContain("4d. AGENCY");
    expect(p).toContain("Respond with ONLY valid JSON");
    expect(p).not.toContain('"self_model_review"');
    expect(p).not.toContain('"reconsolidation"');
    expect(p).not.toContain('"open_loops_to_close"');
    expect(p).not.toContain('"thread_status"');
    expect(p).not.toContain('"start_thread"');
    expect(p).not.toContain("IMPORTANT: you currently have NO declared agency");
    expect(p).not.toContain("4c. SELF-MODEL REVIEW");
    expect(p).not.toContain("5. RECONSOLIDATION");
  });

  it("threadQuestion is inlined verbatim when a thread is active, and thread_status schema field appears", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, threadQuestion: "\n\nThread status marker XYZ", threadId: "auto:run1", threadPos: 2 });
    expect(p).toContain("Thread status marker XYZ");
    expect(p).toContain('"thread_status": "continue"');
  });

  it("thread_status schema example biases to 'conclude' once the thread is at run 5+", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, threadId: "auto:run1", threadPos: 5 });
    expect(p).toContain('"thread_status": "conclude"');
  });

  it("no active thread + exploration run: start_thread schema field appears instead", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, threadId: null, runType: "exploration" });
    expect(p).toContain('"start_thread": false');
    expect(p).not.toContain('"thread_status"');
  });

  it("no active thread + non-exploration run: neither thread_status nor start_thread appears", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, threadId: null, runType: "continuation" });
    expect(p).not.toContain('"thread_status"');
    expect(p).not.toContain('"start_thread"');
  });

  it("selfModelBlock present: block text, the 4c review instruction, and its schema field all appear", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, selfModelBlock: "\nMARKER-SELF-MODEL\n" });
    expect(p).toContain("MARKER-SELF-MODEL");
    expect(p).toContain("4c. SELF-MODEL REVIEW");
    expect(p).toContain('"self_model_review": []');
  });

  it("canonBlock present: block text, the reconsolidation instruction, and its schema field all appear", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, canonBlock: "\nMARKER-CANON\n" });
    expect(p).toContain("MARKER-CANON");
    expect(p).toContain("5. RECONSOLIDATION");
    expect(p).toContain('"reconsolidation": null');
  });

  it("openLoopsCount > 0 adds the open_loops_to_close schema field", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, openLoopsCount: 4 });
    expect(p).toContain('"open_loops_to_close": []');
  });

  it("noAgencyYet forces the preference_declaration REQUIRED override text", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, noAgencyYet: true });
    expect(p).toContain("IMPORTANT: you currently have NO declared agency at all");
    expect(p).toContain('"preference_declaration" is REQUIRED');
  });

  it("noAgencyYet false: no override text", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, noAgencyYet: false });
    expect(p).not.toContain("IMPORTANT: you currently have NO declared agency");
  });

  it("noQuestionRecently forces the question_for_raziel REQUIRED override text", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, noQuestionRecently: true });
    expect(p).toContain("you have not asked Raziel a single question in the last two weeks");
    expect(p).toContain('"question_for_raziel" is REQUIRED');
  });

  it("noQuestionRecently false: no override text", () => {
    const p = buildReflectEmitPrompt({ ...baseOpts, noQuestionRecently: false });
    expect(p).not.toContain("you have not asked Raziel a single question");
  });

  it("always includes the relational_delta schema field and section 3b, null-biased", () => {
    const p = buildReflectEmitPrompt(baseOpts);
    expect(p).toContain("3b. RELATIONAL DELTA");
    expect(p).toContain('"relational_delta": null');
    expect(p).toContain("null is the honest default");
  });
});
