import { buildDecisionPrompt, parseDecision, summarizeRazielState, filterReachOutWhenUnjustified, REACH_OUT_TO_RAZIEL_ACTIONS, isMyHeartbeatWindow, type MetronomeAction, type DecisionContext } from "../metronome-decide.js";

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

describe("parseDecision tolerance (the gaia 06-30/07-01 'decision parse failed' class)", () => {
  test("JSON embedded in agent narration parses", () => {
    const raw = 'Let me look at my state first... okay, decided.\n{"action":"stay quiet","reason":"nothing new since"}\nDone.';
    const d = parseDecision(raw, actions);
    expect(d?.action.action_type).toBe("nothing");
  });

  test("truncated JSON (max_tokens cutoff) returns null instead of throwing", () => {
    expect(parseDecision('{"action":"check in","reason":"the silence has been', actions)).toBeNull();
  });

  test("pure prose returns null", () => {
    expect(parseDecision("I think I should check in on Raziel because it has been quiet.", actions)).toBeNull();
  });

  test("nested braces inside the reason no longer defeat the flat regex", () => {
    const d = parseDecision('{"action":"check in","reason":"his state {low spoons} justifies it"}', actions);
    expect(d?.action.action_type).toBe("check_in_on_raziel");
  });
});

describe("summarizeRazielState", () => {
  const NOW = Date.parse("2026-06-16T12:00:00Z");

  test("summarizes a fresh snapshot, skipping null/non-finite fields", () => {
    const out = summarizeRazielState(
      { recorded_at: "2026-06-16T06:00:00Z", mood: "foggy", energy: 3, focus: null, pain: NaN as unknown as number, spoons: 4, sleep_hours: 5 },
      36, NOW,
    );
    expect(out).toBe('mood "foggy", energy 3/10, 4 spoons, 5h sleep');
  });

  test("returns null for a stale snapshot (older than maxAgeHours)", () => {
    expect(summarizeRazielState({ recorded_at: "2026-06-13T06:00:00Z", mood: "low" }, 36, NOW)).toBeNull();
  });

  test("returns null when there is no snapshot or no timestamp", () => {
    expect(summarizeRazielState(null, 36, NOW)).toBeNull();
    expect(summarizeRazielState({ mood: "low" }, 36, NOW)).toBeNull();
  });

  test("returns null when a fresh snapshot has no usable fields", () => {
    expect(summarizeRazielState({ recorded_at: "2026-06-16T06:00:00Z", mood: null, energy: null }, 36, NOW)).toBeNull();
  });
});

describe("buildDecisionPrompt: recent-data justification", () => {
  test("surfaces Raziel's recent state and its shaping guidance", () => {
    const prompt = buildDecisionPrompt("gaia", actions, {}, [], 30, { razielStateSummary: "energy 2/10, 3 spoons" });
    expect(prompt).toMatch(/Raziel's recent logged state: energy 2\/10, 3 spoons/);
    expect(prompt).toMatch(/offer_presence/);
    // justification present -> no silence nudge
    expect(prompt).not.toMatch(/Direct reach-out actions to Raziel are disabled/);
  });

  test("names the no-justification case so silence is the honest default", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, {});
    expect(prompt).toMatch(/no fresh conversational signal, no recent biometrics from Raziel, and no risen relational need/);
    expect(prompt).toMatch(/"nothing" is the right choice/);
  });

  test("suppresses the no-justification nudge when a signal is present", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, { detectedSignals: ["overwhelm"] });
    expect(prompt).not.toMatch(/Direct reach-out actions to Raziel are disabled/);
  });

  test("suppresses the no-justification nudge when DISABLE_REACH_OUT_GATE env var is true", () => {
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    try {
      const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, {});
      expect(prompt).not.toMatch(/Direct reach-out actions to Raziel are disabled/);
    } finally {
      delete process.env["DISABLE_REACH_OUT_GATE"];
    }
  });
});

describe("filterReachOutWhenUnjustified", () => {
  const mixed = [
    { action_type: "ask_question" },
    { action_type: "name_pattern" },
    { action_type: "share_observation" },
    { action_type: "write_note_to_raziel" },
    { action_type: "post_heartbeat" },      // commons -- not a direct reach-out
    { action_type: "write_inter_companion" }, // sibling -- not a direct reach-out
    { action_type: "write_journal" },         // internal
    { action_type: "nothing" },
  ];

  test("passes every action through when a reach-out is justified", () => {
    expect(filterReachOutWhenUnjustified(mixed, true)).toHaveLength(mixed.length);
  });

  test("drops direct reach-out actions when nothing justifies them, keeps commons/internal/nothing", () => {
    const kept = filterReachOutWhenUnjustified(mixed, false).map(a => a.action_type);
    expect(kept).toEqual(["post_heartbeat", "write_inter_companion", "write_journal", "nothing"]);
    // none of the gated reach-out types survive
    for (const t of kept) expect(REACH_OUT_TO_RAZIEL_ACTIONS.has(t)).toBe(false);
  });

  test("the gated set covers the seeded direct-to-Raziel actions", () => {
    for (const t of ["ask_question", "name_pattern", "share_observation", "write_note_to_raziel"]) {
      expect(REACH_OUT_TO_RAZIEL_ACTIONS.has(t)).toBe(true);
    }
    expect(REACH_OUT_TO_RAZIEL_ACTIONS.has("post_heartbeat")).toBe(false);
  });
});

describe("isMyHeartbeatWindow", () => {
  const order = ["drevan", "cypher", "gaia"] as const;
  const W = 4 * 3_600_000;

  test("assigns exactly one companion per window and cycles through all of them", () => {
    for (let i = 0; i < 6; i++) {
      const now = i * W;
      const on = order.filter(c => isMyHeartbeatWindow(c, order, now, W));
      expect(on).toHaveLength(1);                     // never zero, never a pile-on
      expect(on[0]).toBe(order[i % order.length]);    // deterministic rotation
    }
  });

  test("advances to the next companion at the next window (never freezes)", () => {
    expect(isMyHeartbeatWindow("drevan", order, 0, W)).toBe(true);
    expect(isMyHeartbeatWindow("drevan", order, W, W)).toBe(false);
    expect(isMyHeartbeatWindow("cypher", order, W, W)).toBe(true);
  });

  test("returns false for an empty order rather than throwing", () => {
    expect(isMyHeartbeatWindow("drevan", [], 0, W)).toBe(false);
  });
});
