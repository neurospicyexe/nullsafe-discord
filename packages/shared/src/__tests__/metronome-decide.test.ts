import { buildDecisionPrompt, parseDecision, type MetronomeAction, type DecisionContext } from "../metronome-decide.js";

const actions: MetronomeAction[] = [
  {
    id: "a1", name: "check in", action_type: "check_in_on_raziel",
    target: null, prompt: null, quiet_hours_allowed: 0, status: "on",
    requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
  },
  {
    id: "a2", name: "stay quiet", action_type: "nothing",
    target: null, prompt: null, quiet_hours_allowed: 0, status: "on",
    requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
  },
];

describe("buildDecisionPrompt relational-need nudge (take 9)", () => {
  test("omits the drive nudge when relational need has not fired", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 2, {});
    expect(prompt).not.toMatch(/relational need toward Raziel has crossed threshold/);
  });

  test("injects the state-driven reach-out nudge when the drive fired", () => {
    const ctx: DecisionContext = { relationalNeedFired: true, relationalNeedLevel: 0.82 };
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, ctx);
    expect(prompt).toMatch(/relational need toward Raziel has crossed threshold \(level 0\.82\)/);
    expect(prompt).toMatch(/state-driven/);
    // "nothing" must remain a real option even under a fired drive (lane-honest).
    expect(prompt).toMatch(/"nothing" remains valid/);
  });

  test("nudge degrades gracefully without a level number", () => {
    const prompt = buildDecisionPrompt("gaia", actions, {}, [], 30, { relationalNeedFired: true });
    expect(prompt).toMatch(/crossed threshold -- it has been a while/);
  });

  test("parseDecision still resolves a reach-out pick", () => {
    const d = parseDecision('{"action":"check in","reason":"the need is real"}', actions);
    expect(d?.action.action_type).toBe("check_in_on_raziel");
  });
});
