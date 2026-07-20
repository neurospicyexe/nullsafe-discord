import { describe, it, expect } from "vitest";
import { buildReflectScratchpadPrompt } from "../phases/reflect.js";

describe("reflect scratchpad prompt", () => {
  it("reflect scratchpad triages before the JSON emit", () => {
    const p = buildReflectScratchpadPrompt("CONTEXT");
    expect(p).toContain("it will be discarded");
    expect(p).toContain("actually needs attention");
  });

  it("includes the loaded context block verbatim", () => {
    const p = buildReflectScratchpadPrompt("CONTEXT-MARKER-XYZ");
    expect(p).toContain("CONTEXT-MARKER-XYZ");
  });

  it("asks about stale-but-alive loops and repeated questions", () => {
    const p = buildReflectScratchpadPrompt("CONTEXT");
    expect(p).toContain("stale-but-alive");
    expect(p).toContain("re-asking in different words");
  });
});
