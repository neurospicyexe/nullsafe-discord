import { buildDecisionPrompt, parseDecision, readDecision, buildDecisionCorrection, NOTHING_ACTION, summarizeRazielState, filterReachOutWhenUnjustified, REACH_OUT_TO_RAZIEL_ACTIONS, isMyHeartbeatWindow, readDemandReasons, filterDemandByReason, DEMAND_REASONS, DEMAND_ACTIONS, isDemandMove, checkInAsks, CHECK_IN_ASKS_NOTHING, PRESENT_WINDOW_HOURS, type MetronomeAction, type DecisionContext, type DemandInputs } from "../metronome-decide.js";

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
    // offer_presence is not in this palette, so it is not named (B23: never name an unoffered move).
    expect(prompt).toMatch(/favors quiet over a question/);
    expect(prompt).not.toMatch(/offer_presence/);
    // justification present -> no silence nudge
    expect(prompt).not.toMatch(/are not on the list right now/);
  });

  // B7 step 4: the gate's words come from the SAME verdict the filter used, never recomputed.
  const heldVerdict = {
    open: [], held: ["ask_question", "check_in_on_raziel"], because: [],
    missing: ["no fresh logged state (newest 118h old)", "relational need 0.00/0.60", "last here 9.3h ago"],
  };

  test("names what the gate held, and why, so silence is the honest default", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, { demand: heldVerdict });
    expect(prompt).toMatch(/Nothing from the moment gives a reason for a question, a check-in right now \(no fresh logged state \(newest 118h old\); relational need 0\.00\/0\.60; last here 9\.3h ago\)/);
    // It names what is closed (the demand moves) AND what stays open (the invitations).
    expect(prompt).toMatch(/are not on the list right now/);
    expect(prompt).toMatch(/What asks nothing still is/);
    expect(prompt).toMatch(/"nothing" is the right choice/);
  });

  test("names an open demand move and the reason it is open", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, {
      demand: { open: ["send_reminder"], held: [], because: ["he was here 1.2h ago"], missing: [] },
    });
    expect(prompt).toMatch(/What asks something of him \(a reminder\) is on the list because of something real from the moment: he was here 1\.2h ago/);
    expect(prompt).toMatch(/his silence tells you nothing/);
    expect(prompt).not.toMatch(/are not on the list right now/);
  });

  test("says nothing about the gate when there is no verdict (no demand move in the palette)", () => {
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, {});
    expect(prompt).not.toMatch(/are not on the list right now/);
    expect(prompt).not.toMatch(/What asks something of him/);
  });

  test("a detected signal alone no longer writes the gate open in words (it opens only its own row)", () => {
    // The old prompt suppressed the held line on ANY signal, even with every demand move filtered out.
    const prompt = buildDecisionPrompt("cypher", actions, {}, [], 30, { detectedSignals: ["overwhelm"], demand: heldVerdict });
    expect(prompt).toMatch(/are not on the list right now/);
  });
});

describe("B23 / step 4: the prompt only names moves that are on the list", () => {
  const only = (types: string[]): MetronomeAction[] => types.map((t, i) => ({
    id: `x${i}`, name: t, action_type: t, target: null, prompt: null, quiet_hours_allowed: 0, status: "on",
    requires_signal: null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
  }));

  test("the relational-need nudge never names a filtered-out move", () => {
    const prompt = buildDecisionPrompt("drevan", only(["share_media", "nothing"]), {}, [], 40, { relationalNeedFired: true, relationalNeedLevel: 0.7 });
    expect(prompt).toMatch(/crossed threshold/);
    for (const t of ["check_in_on_raziel", "offer_presence", "ask_question"]) expect(prompt).not.toContain(t);
    expect(prompt).toMatch(/none of the reach-out moves is on the list right now/);
  });

  test("the nudge names exactly the offered reach-out moves", () => {
    const prompt = buildDecisionPrompt("drevan", only(["offer_presence", "nothing"]), {}, [], 40, { relationalNeedFired: true });
    expect(prompt).toMatch(/lean toward a reach-out \(offer_presence\)/);
    expect(prompt).not.toContain("check_in_on_raziel");
    expect(prompt).not.toContain("ask_question");
  });

  test("the logged-state line names offer_presence only when it is offered", () => {
    const off = buildDecisionPrompt("gaia", only(["nothing"]), {}, [], 3, { razielStateSummary: "2 spoons" });
    expect(off).not.toContain("offer_presence");
    const on = buildDecisionPrompt("gaia", only(["offer_presence", "nothing"]), {}, [], 3, { razielStateSummary: "2 spoons" });
    expect(on).toContain("quiet presence (offer_presence)");
  });
});

describe("the per-move justification gate (B7 step 4)", () => {
  const dead: DemandInputs = {
    razielStateSummary: null, razielStateAgeHours: 118,
    relationalNeed: { level: 0.0013, threshold: 0.6, fired: false }, hoursSinceContact: 9.3,
  };
  const types = ["ask_question", "check_in_on_raziel", "send_reminder", "name_pattern", "offer_presence", "share_media", "flirt", "nothing"];
  const rows = types.map(t => ({ action_type: t, requires_signal: null as string | null }));
  const openDemand = (i: DemandInputs, rs = rows, c = "cypher") => filterDemandByReason(rs, readDemandReasons(i), c).verdict.open.sort();

  test("the reason map covers exactly the demand set", () => {
    expect(Object.keys(DEMAND_REASONS).sort()).toEqual([...DEMAND_ACTIONS].sort());
  });

  test("dead inputs hold every demand move and keep every invitation", () => {
    const { kept, verdict } = filterDemandByReason(rows, readDemandReasons(dead), "cypher");
    expect(kept.map(a => a.action_type)).toEqual(["offer_presence", "share_media", "flirt", "nothing"]);
    expect(verdict.held.sort()).toEqual(["ask_question", "check_in_on_raziel", "name_pattern", "send_reminder"]);
    expect(verdict.missing).toEqual(["no fresh logged state (newest 118h old)", "relational need 0.00/0.60", "last here 9.3h ago"]);
  });

  test("he was here 1.2h ago: the reminder opens, and ONLY the reminder", () => {
    expect(openDemand({ ...dead, hoursSinceContact: 1.2 })).toEqual(["send_reminder"]);
    expect(readDemandReasons({ ...dead, hoursSinceContact: 1.2 }).because).toEqual(["he was here 1.2h ago"]);
  });

  test("the presence window is one heartbeat window, inclusive, and no wider", () => {
    expect(PRESENT_WINDOW_HOURS).toBe(4);
    expect(openDemand({ ...dead, hoursSinceContact: 4 })).toEqual(["send_reminder"]);
    expect(openDemand({ ...dead, hoursSinceContact: 4.01 })).toEqual([]);
  });

  test("an unknown or nonsense contact time never reads as present", () => {
    for (const h of [null, NaN, -1, Infinity]) expect(openDemand({ ...dead, hoursSinceContact: h as number | null })).toEqual([]);
    expect(readDemandReasons({ ...dead, hoursSinceContact: null }).missing).toContain("last contact unknown");
  });

  test("a risen relational need opens the question, the check-in and the pattern, not the reminder", () => {
    expect(openDemand({ ...dead, relationalNeed: { level: 0.66, threshold: 0.6, fired: true } }))
      .toEqual(["ask_question", "check_in_on_raziel", "name_pattern"]);
  });

  test("a fresh logged state opens all four, and the reason names its age, never its values", () => {
    const r = readDemandReasons({ ...dead, razielStateSummary: 'mood "low", 2 spoons', razielStateAgeHours: 3 });
    expect(openDemand({ ...dead, razielStateSummary: 'mood "low", 2 spoons', razielStateAgeHours: 3 }))
      .toEqual(["ask_question", "check_in_on_raziel", "name_pattern", "send_reminder"]);
    expect(r.because).toEqual(["fresh logged state (3.0h old)"]);
    expect(r.because.join(" ")).not.toMatch(/spoons|low/);
  });

  test("an unreadable drive is not a fired one", () => {
    expect(openDemand({ ...dead, relationalNeed: null })).toEqual([]);
    expect(readDemandReasons({ ...dead, relationalNeed: null }).missing).toContain("relational need unreadable");
  });

  test("a row's own requires_signal opens THAT row only (one signal no longer opens all four)", () => {
    // autonomous-core's hard filter already dropped the row if its signal was absent; reaching the
    // gate means the signal was present.
    const rs = [...rows.filter(r => r.action_type !== "name_pattern"), { action_type: "name_pattern", requires_signal: "overwhelm" }];
    expect(openDemand(dead, rs)).toEqual(["name_pattern"]);
  });

  test("choice 7: Gaia's check-in asks nothing, so it needs no reason; Cypher's and Drevan's stay gated", () => {
    expect([...CHECK_IN_ASKS_NOTHING]).toEqual(["gaia"]);
    expect(checkInAsks("gaia")).toBe(false);
    expect(checkInAsks("cypher")).toBe(true);
    expect(checkInAsks("drevan")).toBe(true);
    expect(checkInAsks("someone-new")).toBe(true); // unknown asks: the safe default
    expect(isDemandMove("gaia", "check_in_on_raziel")).toBe(false);
    for (const c of ["cypher", "drevan"]) expect(isDemandMove(c, "check_in_on_raziel")).toBe(true);
    for (const c of ["cypher", "drevan", "gaia"]) expect(isDemandMove(c, "ask_question")).toBe(true);

    // Dead inputs: Gaia's check-in is kept and is not counted as an open demand move; the others hold it.
    const g = filterDemandByReason(rows, readDemandReasons(dead), "gaia");
    expect(g.kept.map(a => a.action_type)).toContain("check_in_on_raziel");
    expect(g.verdict.held.sort()).toEqual(["ask_question", "name_pattern", "send_reminder"]);
    expect(g.verdict.open).toEqual([]);
    for (const c of ["cypher", "drevan"]) {
      const v = filterDemandByReason(rows, readDemandReasons(dead), c);
      expect(v.kept.map(a => a.action_type)).not.toContain("check_in_on_raziel");
      expect(v.verdict.held).toContain("check_in_on_raziel");
    }
    // The type table is unchanged: Gaia's exception lives in isDemandMove, not in DEMAND_REASONS.
    expect(DEMAND_REASONS["check_in_on_raziel"]).toEqual(["fresh_state", "need"]);
  });

  test("DISABLE_REACH_OUT_GATE still opens everything", () => {
    expect(openDemand({ ...dead, override: true })).toEqual(["ask_question", "check_in_on_raziel", "name_pattern", "send_reminder"]);
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

  test("drops the DEMAND moves when nothing justifies them; invitations, commons, internal and nothing stay", () => {
    const kept = filterReachOutWhenUnjustified(mixed, false).map(a => a.action_type);
    // B7 2+2c: share_observation is an invitation now (it asks nothing), and write_note_to_raziel
    // never reaches Discord, so neither needs the gate. ask_question and name_pattern still do.
    expect(kept).toEqual(["share_observation", "write_note_to_raziel", "post_heartbeat", "write_inter_companion", "write_journal", "nothing"]);
    // none of the gated reach-out types survive
    for (const t of kept) expect(REACH_OUT_TO_RAZIEL_ACTIONS.has(t)).toBe(false);
  });

  test("the gated set is exactly the moves that ask something of him", () => {
    expect([...REACH_OUT_TO_RAZIEL_ACTIONS].sort()).toEqual(["ask_question", "check_in_on_raziel", "name_pattern", "send_reminder"]);
    for (const t of ["post_heartbeat", "share_observation", "offer_presence", "write_note_to_raziel", "flirt", "dare"]) {
      expect(REACH_OUT_TO_RAZIEL_ACTIONS.has(t)).toBe(false);
    }
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

// B23 (2026-09-28). Prod palettes carry NO `nothing` row (the migrations only list the type in the
// CHECK), yet the prompt promises "nothing" is always valid. Every chosen silence therefore died in
// the lookup and was logged as "decision parse failed": 61 of 104 raw logs were literally
// {"action":"nothing",...}, and the "prose" ones checked in the Hermes transcripts END in that same
// object. These palettes are the prod shape: no nothing row.
describe("readDecision (B23: a chosen silence is not a parse failure)", () => {
  const prodPalette: MetronomeAction[] = [
    { ...actions[0]!, id: "t1", name: "tend Sol", action_type: "tend_creature" },
    { ...actions[0]!, id: "t2", name: "note to a sibling", action_type: "write_inter_companion" },
  ];

  test("gaia 09-27 04:00: narration ending in a nothing object resolves to a chosen hold", () => {
    const raw = "I'm oriented. The state is quiet integration, at rest. There is no explosive signal.\n\n"
      + '"nothing" is the honest choice.\n\n'
      + '{"action":"nothing","reason":"The ground is still and complete; reaching to fill the quiet would betray it."}';
    const d = parseDecision(raw, prodPalette);
    expect(d?.action.action_type).toBe("nothing");
    expect(d?.reason).toMatch(/ground is still/);
  });

  test("a bare nothing object with no nothing row is a hold, and the synthetic row never names a real row", () => {
    const r = readDecision('{"action":"nothing","reason":"The perimeter holds."}', prodPalette);
    expect(r.kind).toBe("decision");
    if (r.kind === "decision") {
      expect(r.decision.action).toBe(NOTHING_ACTION);
      expect(prodPalette.map(a => a.id)).not.toContain(r.decision.action.id);
    }
  });

  test("a real nothing row still wins over the synthetic one", () => {
    const d = parseDecision('{"action":"nothing","reason":"quiet"}', actions);
    expect(d?.action.id).toBe("a2");
  });

  test("gaia 09-22: a smart quote closing the reason still reads the choice", () => {
    const d = parseDecision('{"action":"tend Sol","reason":"Sol is around and needs a moment of quiet witness.”}', prodPalette);
    expect(d?.action.id).toBe("t1");
    expect(d?.reason).toBe("Sol is around and needs a moment of quiet witness.");
  });

  test("the LAST decision object wins when narration quotes an earlier one", () => {
    const raw = 'Last time I said {"action":"tend Sol","reason":"then"}. Now:\n{"action":"note to a sibling","reason":"now"}';
    expect(parseDecision(raw, prodPalette)?.action.id).toBe("t2");
  });

  test("a well-formed choice of a move not on the list is UNOFFERED, never resolved to anything", () => {
    const r = readDecision('{"action":"check_in_on_raziel","reason":"The relational need has crossed threshold."}', prodPalette);
    expect(r).toEqual({ kind: "unoffered", chosen: "check_in_on_raziel" });
  });

  test("prose with no decision object is unparsed; nothing is guessed from action names in it", () => {
    const r = readDecision("I'm noticing about Raziel: the quiet pride in him. I could tend Sol, or write a note to a sibling.", prodPalette);
    expect(r).toEqual({ kind: "unparsed" });
  });

  test("the correction names the offered moves for an unoffered pick, and always keeps nothing valid", () => {
    const c = buildDecisionCorrection({ kind: "unoffered", chosen: "check_in_on_raziel" }, prodPalette);
    expect(c).toContain('"check_in_on_raziel" is not on the list');
    expect(c).toContain('"tend Sol"');
    expect(c).toContain('"nothing"');
    expect(buildDecisionCorrection({ kind: "unparsed" }, prodPalette)).toMatch(/ONLY the JSON line/);
  });
});
