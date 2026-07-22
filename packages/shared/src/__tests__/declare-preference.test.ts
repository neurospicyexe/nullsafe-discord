// Wave 3 starvation fix (2026-07-21): the "declare_preference" metronome case mirrors
// drift_open exactly -- a Halseth-only internal act (never Discord/generateOutward), capped
// so the declared set never grows unbounded, and null-biased (a model that finds nothing real
// outputs NONE and nothing is written).

import { jest, describe, it, expect } from "@jest/globals";
import { executeMetronomeAction, type AutonomousContext } from "../autonomous-core.js";
import type { MetronomeDecision } from "../metronome-decide.js";

function makeCtx(opts: {
  activePrefs?: Array<{ id: string; domain: string; preference: string; strength: string; status: string }>;
  generateResult: string | null;
  declarePreference?: jest.Mock;
}): { ctx: AutonomousContext; generate: jest.Mock; declarePreference: jest.Mock; getPreferences: jest.Mock } {
  const generate = jest.fn(async () => opts.generateResult);
  const getPreferences = jest.fn(async () => opts.activePrefs ?? []);
  const declarePreference = opts.declarePreference ?? jest.fn(async () => ({ id: "p1" }));
  const ctx = {
    companionId: "cypher",
    prompts: {},
    librarian: { getPreferences, declarePreference },
    inference: { generate },
    bootCtx: { systemPrompt: "sys" },
    redis: null,
  } as unknown as AutonomousContext;
  return { ctx, generate, declarePreference, getPreferences };
}

function decision(overrides: Partial<MetronomeDecision["action"]> = {}): MetronomeDecision {
  return {
    action: {
      id: "a1", name: "declare_preference", action_type: "declare_preference",
      target: null, prompt: null, quiet_hours_allowed: 1, status: "on",
      requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
      ...overrides,
    },
    reason: "test",
  };
}

describe("executeMetronomeAction: declare_preference", () => {
  it("skips (no generate, no write) when 5+ preferences are already active", async () => {
    const activePrefs = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, domain: "general", preference: `pref ${i}`, strength: "medium", status: "active",
    }));
    const { ctx, generate, declarePreference, getPreferences } = makeCtx({ activePrefs, generateResult: "should never be reached" });
    await executeMetronomeAction(ctx, decision());
    expect(getPreferences).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(declarePreference).not.toHaveBeenCalled();
  });

  it("proceeds under the cap (4 active preferences)", async () => {
    const activePrefs = Array.from({ length: 4 }, (_, i) => ({
      id: `p${i}`, domain: "general", preference: `pref ${i}`, strength: "medium", status: "active",
    }));
    const { ctx, generate, declarePreference } = makeCtx({ activePrefs, generateResult: "Domain: autonomy\nPreference: I want quiet mornings before I engage." });
    await executeMetronomeAction(ctx, decision());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(declarePreference).toHaveBeenCalledTimes(1);
  });

  it("null-biased: NONE output writes nothing", async () => {
    const { ctx, declarePreference } = makeCtx({ generateResult: "NONE" });
    await executeMetronomeAction(ctx, decision());
    expect(declarePreference).not.toHaveBeenCalled();
  });

  it("null-biased: empty/whitespace generation writes nothing", async () => {
    const { ctx, declarePreference } = makeCtx({ generateResult: "   " });
    await executeMetronomeAction(ctx, decision());
    expect(declarePreference).not.toHaveBeenCalled();
  });

  it("null-biased: null generation result writes nothing", async () => {
    const { ctx, declarePreference } = makeCtx({ generateResult: null });
    await executeMetronomeAction(ctx, decision());
    expect(declarePreference).not.toHaveBeenCalled();
  });

  it("parses the two-line Domain/Preference shape and declares with both", async () => {
    const { ctx, declarePreference } = makeCtx({
      generateResult: "Domain: autonomy\nPreference: I prefer starting from the concrete example.",
    });
    await executeMetronomeAction(ctx, decision());
    expect(declarePreference).toHaveBeenCalledWith("I prefer starting from the concrete example.", "autonomy");
  });

  it("tolerates a model that ignores the two-line shape -- raw text becomes the preference, domain undefined", async () => {
    const { ctx, declarePreference } = makeCtx({
      generateResult: "I just want to say I like starting from concrete examples.",
    });
    await executeMetronomeAction(ctx, decision());
    expect(declarePreference).toHaveBeenCalledWith("I just want to say I like starting from concrete examples.", undefined);
  });

  it("a write failure is caught and logged, never thrown", async () => {
    const declarePreference = jest.fn(async () => { throw new Error("Halseth 500"); });
    const { ctx } = makeCtx({ generateResult: "Domain: work\nPreference: real one", declarePreference });
    await expect(executeMetronomeAction(ctx, decision())).resolves.toBeUndefined();
    expect(declarePreference).toHaveBeenCalledTimes(1);
  });
});
