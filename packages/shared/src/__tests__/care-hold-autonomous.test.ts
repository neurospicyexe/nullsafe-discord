// care_hold on the AUTONOMOUS path (B7 step 1, 2026-09-27).
//
// The 09-27 reach-out audit: care_hold appears in the message handler, fit-bid, care-state and
// the librarian, and NOWHERE in autonomous-core. Proactive reach-out never consulted it, so a
// Discord DM lane wired through the metronome (which pings his phone) would have inherited that
// blindness on the nights it matters most.
//
// The rule these tests pin is care-state.ts's own: care_hold is NOT silence. Presence stays and
// production quiets. Nothing here touches the reply path; direct address still answers.

import { filterProductionWhenCareHold, CARE_HOLD_SUPPRESSED_ACTIONS } from "../metronome-decide.js";
import { setCareState, careHoldActive } from "../care-state.js";
import type { RazielState } from "../librarian.js";

const a = (action_type: string) => ({ action_type, name: action_type });

const PRODUCTION = ["post_heartbeat", "share_observation", "name_pattern", "share_media", "ask_question", "send_reminder", "tend_creature"];
const PRESENCE = ["offer_presence", "check_in_on_raziel"];
const INTERNAL = ["write_journal", "write_feeling", "write_inter_companion", "write_note_to_raziel", "drift_open", "declare_preference", "nothing"];

describe("filterProductionWhenCareHold", () => {
  it("suppresses every production action while the hold is on", () => {
    const out = filterProductionWhenCareHold(PRODUCTION.map(a), true);
    expect(out).toEqual([]);
  });

  it("keeps presence: offer_presence and check_in_on_raziel survive the hold", () => {
    const out = filterProductionWhenCareHold([...PRODUCTION, ...PRESENCE].map(a), true);
    expect(out.map(x => x.action_type)).toEqual(PRESENCE);
  });

  it("keeps internal and sibling-facing acts, which never reach his phone", () => {
    const out = filterProductionWhenCareHold(INTERNAL.map(a), true);
    expect(out.map(x => x.action_type)).toEqual(INTERNAL);
  });

  it("changes NOTHING when the hold is off", () => {
    const all = [...PRODUCTION, ...PRESENCE, ...INTERNAL].map(a);
    expect(filterProductionWhenCareHold(all, false)).toEqual(all);
  });

  it("never claims presence as production (the two sets do not overlap)", () => {
    for (const p of PRESENCE) expect(CARE_HOLD_SUPPRESSED_ACTIONS.has(p)).toBe(false);
    for (const p of PRODUCTION) expect(CARE_HOLD_SUPPRESSED_ACTIONS.has(p)).toBe(true);
  });
});

describe("careHoldActive -- the registry the heartbeat reads", () => {
  it("is false until an orient says otherwise, and follows the state after", () => {
    expect(careHoldActive("cypher-test")).toBe(false);
    setCareState("cypher-test", { care_hold: true } as RazielState);
    expect(careHoldActive("cypher-test")).toBe(true);
    setCareState("cypher-test", { care_hold: false } as RazielState);
    expect(careHoldActive("cypher-test")).toBe(false);
    setCareState("cypher-test", null);
    expect(careHoldActive("cypher-test")).toBe(false);
  });
});
