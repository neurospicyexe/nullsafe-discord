import { jest } from "@jest/globals";
import { deriveStateHint, hasSomaValue, distillSessionOnInactive } from "../distillation.js";

// These two helpers encode the SOMA-handling logic that was inlined identically in all three
// bots' onChannelInactive (bots/<name>/src/index.ts). The bots differ ONLY in their SOMA field
// names (Cypher acuity/presence/warmth, Drevan heat/reach/weight, Gaia stillness/density/perimeter),
// so the logic must stay generic over keys. Pinned here against drift.

describe("deriveStateHint — builds the handoff state_hint from a SOMA object", () => {
  it("returns undefined when soma is absent (matches `ext.soma ? ... : undefined`)", () => {
    expect(deriveStateHint(undefined)).toBeUndefined();
  });

  it("joins non-empty fields as 'key: value', preserving order, dropping falsy values", () => {
    expect(deriveStateHint({ acuity: "sharp", presence: "", warmth: "warm" })).toBe("acuity: sharp, warmth: warm");
  });

  it("is generic over field names (Drevan schema)", () => {
    expect(deriveStateHint({ heat: "steady", reach: "landed", weight: "light" })).toBe("heat: steady, reach: landed, weight: light");
  });

  it("returns empty string for an all-falsy soma (preserves original join behavior)", () => {
    expect(deriveStateHint({ stillness: "", density: "" })).toBe("");
  });
});

describe("hasSomaValue — gate for whether to queue a state update", () => {
  it("false when soma is absent", () => {
    expect(hasSomaValue(undefined)).toBe(false);
  });

  it("false when every field is falsy", () => {
    expect(hasSomaValue({ acuity: "", presence: "" })).toBe(false);
  });

  it("true when at least one field has a value", () => {
    expect(hasSomaValue({ acuity: "", presence: "steady" })).toBe(true);
  });
});

describe("distillSessionOnInactive — tolerant structured extract (the daily 'structured extract parse failed')", () => {
  const makeCtx = (extractReply: string) => {
    const stmStore = {
      get: () => [{ role: "user", content: "hey cy" }, { role: "assistant", content: "here" }],
      clear: jest.fn(),
    };
    const librarian = {
      witnessLog: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      synthesizeSession: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updatePromptContext: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeWmNote: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      writeHandoff: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ask: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
    // synthesis call first, extract call second
    const generate = jest.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("a synthesis of the session")
      .mockResolvedValueOnce(extractReply);
    const queued: string[] = [];
    const wq = {
      fireAndForget: (name: string, fn: () => Promise<void>) => { queued.push(name); void fn().catch(() => {}); },
    };
    const prompts = { companionId: "cypher", synthesisPrompt: "synth", sessionExtractPrompt: "extract" };
    return { stmStore, librarian, generate, wq, queued, prompts };
  };

  const run = (c: ReturnType<typeof makeCtx>) =>
    distillSessionOnInactive("chan1", c.stmStore as any, c.librarian as any, { generate: c.generate } as any, c.wq as any, c.prompts as any);

  it("prose extract reply skips structured writes without throwing; synthesis writes still queued", async () => {
    const c = makeCtx("I noticed a few things about this session that feel worth saying in my own words.");
    await expect(run(c)).resolves.toBeUndefined();
    expect(c.queued).toEqual(expect.arrayContaining(["witnessLog:chan1", "synthesize:chan1", "promptCtx:chan1", "wmNote:chan1"]));
    expect(c.queued.find((k) => k.startsWith("handoff:"))).toBeUndefined();
    expect(c.stmStore.clear).toHaveBeenCalled();
  });

  it("extract JSON embedded in prose still queues handoff + soma + feeling", async () => {
    const c = makeCtx('Here you go:\n```json\n{"title":"T","soma":{"acuity":"sharp"},"emotion":"steady"}\n```');
    await run(c);
    expect(c.queued).toEqual(expect.arrayContaining(["handoff:chan1", "somaUpdate:chan1", "feeling:chan1"]));
  });

  it("truncated extract JSON (max_tokens cutoff) skips structured writes without throwing", async () => {
    const c = makeCtx('{"title":"A long session title that got cut', );
    await expect(run(c)).resolves.toBeUndefined();
    expect(c.queued.find((k) => k.startsWith("handoff:"))).toBeUndefined();
  });
});
