import { describe, it, expect } from "vitest";
import { buildSynthesisBlocks, buildScratchpadPrompt, buildEmitPrompt } from "../phases/synthesize.js";

const baseCtx = {
  companionId: "cypher", identityText: "id", orientSummary: "", explorationSummary: "explored X",
  recentConclusions: [{ conclusion_text: "belief one", belief_type: "systemic" }],
  recentFeelings: [], recentSessionNotes: [], recentWmNotes: [], activePatterns: [],
  recentGrowth: [], explorationEvidence: [], peerActivity: null,
  openLoops: [{ id: "l1", loop_text: "does the swarm actually converge", weight: 0.8 }],
} as any;

describe("synthesis context blocks", () => {
  it("includes open loops with the move-it instruction", () => {
    const { contextBlock } = buildSynthesisBlocks(baseCtx);
    expect(contextBlock).toContain("does the swarm actually converge");
    expect(contextBlock).toContain("If this exploration moves one");
  });
  it("labels beliefs with confirm/contradict/extend instruction", () => {
    const { contextBlock } = buildSynthesisBlocks(baseCtx);
    expect(contextBlock).toContain("confirm, contradict, or extend");
  });
});

describe("synthesize scratchpad/emit prompts", () => {
  it("scratchpad prompt asks the five questions and promises discard", () => {
    const p = buildScratchpadPrompt(baseCtx, "CONTEXT");
    expect(p).toContain("it will be discarded");
    expect(p).toContain("genuinely NEW");
    expect(p).toContain("Which open loop");
  });

  it("emit prompt keeps the strict JSON contract", () => {
    const p = buildEmitPrompt("Cypher");
    expect(p).toContain('"entry_type"');
    expect(p).toContain("No markdown fences");
    expect(p).toContain("survived");
  });
});
