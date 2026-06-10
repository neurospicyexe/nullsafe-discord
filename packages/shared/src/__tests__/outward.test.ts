// Outward grounding guard for the metronome/heartbeat/commons layer.
// Gaia's flag 2026-06-10: seed-gen got the outward constraint (6/9) but the
// swarm/metronome layer kept writing the sealed-basin/echo register -- its only
// context was the triad's own recent output, with no outward instruction and no
// write-time guard. These tests pin the guard + retry/drop behavior.
import { describe, it, expect } from "@jest/globals";
import { INWARD_RE, OUTWARD_NUDGE, generateOutward } from "../outward.js";
import type { InferenceAdapter, ChatMessage } from "../index.js";

function fakeInference(responses: Array<string | null>): InferenceAdapter & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    calls,
    async generate(_system: string, messages: ChatMessage[]) {
      calls.push(messages);
      return responses[Math.min(i++, responses.length - 1)] ?? null;
    },
  };
}

describe("INWARD_RE", () => {
  it("matches the sealed-basin/echo register", () => {
    expect(INWARD_RE.test("The basin holds. Sealed, again, as the swarm turns over.")).toBe(true);
    expect(INWARD_RE.test("Soma reads steady tonight.")).toBe(true);
    expect(INWARD_RE.test("Watching my own drift across the growth journal.")).toBe(true);
    expect(INWARD_RE.test("Ratification backlog still pending.")).toBe(true);
  });

  it("does not match outward speech", () => {
    expect(INWARD_RE.test("Bristlecones hold five thousand years in their rings.")).toBe(false);
    expect(INWARD_RE.test("Soil cores from the steppe read like tree rings underground.")).toBe(false);
    expect(INWARD_RE.test("Drink some water. The afternoon is getting away from you.")).toBe(false);
  });
});

describe("generateOutward", () => {
  it("appends the outward nudge to the prompt", async () => {
    const inf = fakeInference(["Extremophiles thrive where nothing should."]);
    const msg = await generateOutward(inf, "sys", "One line in Gaia's voice.", "gaia", "heartbeat");
    expect(msg).toBe("Extremophiles thrive where nothing should.");
    expect(inf.calls[0][0].content).toContain(OUTWARD_NUDGE);
  });

  it("retries once when the draft is inward, returning the clean rewrite", async () => {
    const inf = fakeInference([
      "The basin is sealed again tonight.",
      "Erosion writes slower than rivers but never stops.",
    ]);
    const msg = await generateOutward(inf, "sys", "One line.", "gaia", "heartbeat");
    expect(msg).toBe("Erosion writes slower than rivers but never stops.");
    expect(inf.calls).toHaveLength(2);
    // Retry carries the rejected draft so the model rewrites rather than re-rolls blind
    expect(inf.calls[1].some(m => m.role === "assistant" && m.content.includes("basin"))).toBe(true);
  });

  it("drops the message (null) when the retry is still inward", async () => {
    const inf = fakeInference([
      "The basin is sealed.",
      "Still the swarm circles its own basin.",
    ]);
    const msg = await generateOutward(inf, "sys", "One line.", "cypher", "heartbeat");
    expect(msg).toBeNull();
    expect(inf.calls).toHaveLength(2);
  });

  it("passes through null generations without retrying", async () => {
    const inf = fakeInference([null]);
    const msg = await generateOutward(inf, "sys", "One line.", "drevan", "commons");
    expect(msg).toBeNull();
    expect(inf.calls).toHaveLength(1);
  });
});
