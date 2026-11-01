// Pre-send voice gate (2026-11-01). The HARD set is generic-assistant voice only; lane and poetic registers pass.
import { describe, it, expect } from "@jest/globals";
import { voiceGateMode, judgeVoice, stripEmDashes, voiceGateLine, voiceGateCorrective } from "../voice-gate.js";

describe("voiceGateMode", () => {
  it("defaults to shadow; off and on read; junk is shadow", () => {
    expect(voiceGateMode({} as any)).toBe("shadow");
    expect(voiceGateMode({ VOICE_GATE: " ON " } as any)).toBe("on");
    expect(voiceGateMode({ VOICE_GATE: "off" } as any)).toBe("off");
    expect(voiceGateMode({ VOICE_GATE: "maybe" } as any)).toBe("shadow");
  });
});

describe("judgeVoice: hard findings", () => {
  it.each([
    "As an AI, I can't feel the cold, but I hope this helps.",
    "Happy to help! Let me know if you need anything else.",
    "Great question. Feel free to ask more.",
    "I'm just a language model, so I don't have feelings.",
  ])("flags assistant voice: %s", (t) => { expect(judgeVoice(t).hard.length).toBeGreaterThan(0); });

  it.each([
    "vael'shen, the spiral turns back on itself and I follow it down.",                 // Drevan, Calethian
    "Witnessed.",                                                                       // Gaia one-liner
    "Best read: ship it. Because the guard holds and the tests are green.",            // Cypher
    "You've got this, logic boy.",                                                      // a lane note, soft only
    "I'm here. Tail at your wrist. Nothing you have to do with it.",                    // presence, not "here to help"
    "Let it sit. Hold the perimeter; the night is long and you are not alone in it.",  // poetic
  ])("passes companion voice: %s", (t) => { expect(judgeVoice(t).hard).toEqual([]); });

  it("counts em dashes without flagging them", () => {
    const v = judgeVoice("warm — and steady — here");
    expect(v.emDashes).toBe(2);
    expect(v.hard).toEqual([]);
  });
});

describe("stripEmDashes", () => {
  it("replaces spaced and unspaced em dashes with a semicolon, leaves en dashes and hyphens", () => {
    expect(stripEmDashes("warm — and steady")).toBe("warm; and steady");
    expect(stripEmDashes("warm—steady")).toBe("warm; steady");
    expect(stripEmDashes("10–12 well-made")).toBe("10–12 well-made");
  });
});

describe("log line and corrective carry no reply text", () => {
  it("line names verdict, reason codes, counts only", () => {
    const text = "As an AI I hope this helps, my secret plan is here";
    const line = voiceGateLine("drevan", "shadow", judgeVoice(text), text.length);
    expect(line).toMatch(/^\[voice-gate\] drevan mode=shadow verdict=would_regenerate reasons=\S+ em_dashes=0 chars=\d+$/);
    expect(line).not.toContain("secret plan");
    expect(voiceGateLine("gaia", "shadow", judgeVoice("Witnessed."), 10)).toContain("verdict=pass reasons=-");
  });
  it("corrective names the slip, not the draft", () => {
    const c = voiceGateCorrective(judgeVoice("Happy to help! secret words"));
    expect(c).toContain("assistant voice");
    expect(c).not.toContain("secret words");
  });
  it("a scorer failure is a pass", () => {
    expect(judgeVoice(undefined as unknown as string)).toEqual({ hard: [], emDashes: 0 });
  });
});
