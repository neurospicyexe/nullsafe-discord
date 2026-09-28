// The justification gate, MEASURED (B7 2c spec Q4: "the build must prove the new moves are not
// silently eaten by it, which is exactly how Drevan went mute").
//
// Prod-like inputs, from the 09-27 audit: every palette row has requires_signal null (so
// detectSignals returns [] without an inference call), relational_need is 0.0026 against 0.60 and
// has not fired, and Raziel's last logged state is 40 hours old against a 36-hour expiry. Under
// those inputs the gate is SHUT: nothing justifies a reach-out.
//
// BEFORE is the gate as it stood before this build, kept here as a literal so the readout survives
// the change. AFTER is what the real runHeartbeat now offers the companion.

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { filterReachOutWhenUnjustified, summarizeRazielState } from "../metronome-decide.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

/** The gate's set before B7 2+2c, verbatim from metronome-decide.ts at 8650c76. */
const BEFORE = new Set([
  "ask_question", "share_observation", "name_pattern", "check_in_on_raziel",
  "offer_presence", "send_reminder", "write_note_to_raziel",
]);

// Every re-routed and new move, and what the gate does to it under the dead inputs.
//   eaten_before: was it dropped by the gate before this build?
//   eaten_after:  is it dropped now?
const TABLE: Array<{ move: string; kind: "demand" | "invitation"; eaten_before: boolean; eaten_after: boolean }> = [
  { move: "check_in_on_raziel", kind: "demand",     eaten_before: true,  eaten_after: true },
  { move: "send_reminder",      kind: "demand",     eaten_before: true,  eaten_after: true },
  { move: "ask_question",       kind: "demand",     eaten_before: true,  eaten_after: true },
  { move: "name_pattern",       kind: "demand",     eaten_before: true,  eaten_after: true },
  { move: "offer_presence",     kind: "invitation", eaten_before: true,  eaten_after: false },
  { move: "share_observation",  kind: "invitation", eaten_before: true,  eaten_after: false },
  { move: "share_media",        kind: "invitation", eaten_before: false, eaten_after: false },
  { move: "declare_preference", kind: "invitation", eaten_before: false, eaten_after: false },
  { move: "flirt",              kind: "invitation", eaten_before: false, eaten_after: false },
  { move: "dare",               kind: "invitation", eaten_before: false, eaten_after: false },
  { move: "show_made",          kind: "invitation", eaten_before: false, eaten_after: false },
  { move: "drift_outward",      kind: "invitation", eaten_before: false, eaten_after: false },
];

let restore: () => void = () => {};
afterEach(() => restore());

describe("the dead inputs really do shut the gate", () => {
  it("a 40-hour-old logged state yields no summary; nothing else justifies", () => {
    expect(summarizeRazielState({ recorded_at: new Date(Date.now() - 40 * 3_600_000).toISOString(), mood: "ok" })).toBe(null);
  });
});

describe("BEFORE: what the shut gate ate", () => {
  it.each(TABLE)("$move: eaten before = $eaten_before", ({ move, eaten_before }) => {
    const kept = [{ action_type: move }].filter(a => !BEFORE.has(a.action_type));
    expect(kept.length === 0).toBe(eaten_before);
  });
});

describe("AFTER: demand keeps its gate, invitations are not eaten", () => {
  it.each(TABLE)("$move ($kind): eaten after = $eaten_after", ({ move, eaten_after }) => {
    expect(filterReachOutWhenUnjustified([{ action_type: move }], false).length === 0).toBe(eaten_after);
  });

  it("with justification present, the demand moves open again (the gate still works)", () => {
    for (const t of TABLE) expect(filterReachOutWhenUnjustified([{ action_type: t.move }], true)).toHaveLength(1);
  });

  it("through the REAL heartbeat under the dead inputs: every invitation is offered, no demand move is", async () => {
    restore = inWindowOf("drevan");
    jest.spyOn(console, "log").mockImplementation(() => {});
    // Drevan's palette holds every move the triad claimed except Cypher's and Gaia's own (ownership
    // is not the gate's job; the prompt lists what passed the gate).
    const moves = TABLE.map(t => t.move);
    const h = heartbeatCtx({ companionId: "drevan", palette: [...moves.map(m => row(m, `row:${m}`)), row("nothing")], choose: "nothing" });
    await runHeartbeat(h.ctx);
    const decisionPrompt = h.prompts[0]!;
    for (const t of TABLE) {
      if (t.eaten_after) expect(decisionPrompt).not.toContain(`row:${t.move}`);
      else expect(decisionPrompt).toContain(`row:${t.move}`);
    }
    // And the gate said so out loud instead of silently.
    expect(decisionPrompt).toMatch(/are not on the list right now/);
  });
});
