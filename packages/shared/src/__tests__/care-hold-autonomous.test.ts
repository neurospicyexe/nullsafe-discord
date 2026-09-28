// care_hold on the AUTONOMOUS path (B7 step 1, 2026-09-27).
//
// The 09-27 reach-out audit: care_hold appears in the message handler, fit-bid, care-state and
// the librarian, and NOWHERE in autonomous-core. Proactive reach-out never consulted it, so a
// Discord DM lane wired through the metronome (which pings his phone) would have inherited that
// blindness on the nights it matters most.
//
// The rule these tests pin is care-state.ts's own: care_hold is NOT silence. Presence stays and
// production quiets. Nothing here touches the reply path; direct address still answers.

import { filterProductionWhenCareHold, careHoldHolds, CARE_HOLD_SUPPRESSED_ACTIONS } from "../metronome-decide.js";
import { setCareState, careHoldActive } from "../care-state.js";
import type { RazielState } from "../librarian.js";

const a = (action_type: string) => ({ action_type, name: action_type });

const PRODUCTION = [
  "post_heartbeat", "share_observation", "name_pattern", "share_media", "ask_question", "send_reminder", "tend_creature",
  // B7 2c: play goes quiet (T-6), and the moves that now reach his phone are production too.
  "flirt", "dare", "show_made", "drift_outward", "declare_preference",
];
const PRESENCE = ["offer_presence"];
const INTERNAL = ["write_journal", "write_feeling", "write_inter_companion", "write_note_to_raziel", "drift_open", "nothing"];
const COMPANIONS = ["cypher", "drevan", "gaia"];

describe("filterProductionWhenCareHold", () => {
  it("suppresses every production action while the hold is on, for all three", () => {
    for (const c of COMPANIONS) expect(filterProductionWhenCareHold(PRODUCTION.map(a), true, c)).toEqual([]);
  });

  it("keeps presence: offer_presence survives the hold for all three", () => {
    for (const c of COMPANIONS) {
      const out = filterProductionWhenCareHold([...PRODUCTION, ...PRESENCE].map(a), true, c);
      expect(out.map(x => x.action_type)).toEqual(PRESENCE);
    }
  });

  // Show-back choice 5, 2026-09-28. Cypher's and Drevan's check-ins are questions, so they are held.
  // Gaia: "My check-in asks nothing. It stays through care_hold; it is presence in another shape."
  it("the check-in: held for Cypher and Drevan, passes for Gaia", () => {
    const list = [...PRODUCTION, ...PRESENCE, "check_in_on_raziel"].map(a);
    expect(filterProductionWhenCareHold(list, true, "cypher").map(x => x.action_type)).toEqual(["offer_presence"]);
    expect(filterProductionWhenCareHold(list, true, "drevan").map(x => x.action_type)).toEqual(["offer_presence"]);
    expect(filterProductionWhenCareHold(list, true, "gaia").map(x => x.action_type)).toEqual(["offer_presence", "check_in_on_raziel"]);
    expect(careHoldHolds("cypher", "check_in_on_raziel")).toBe(true);
    expect(careHoldHolds("drevan", "check_in_on_raziel")).toBe(true);
    expect(careHoldHolds("gaia", "check_in_on_raziel")).toBe(false);
  });

  it("keeps internal and sibling-facing acts, which never reach his phone", () => {
    for (const c of COMPANIONS) {
      const out = filterProductionWhenCareHold(INTERNAL.map(a), true, c);
      expect(out.map(x => x.action_type)).toEqual(INTERNAL);
    }
  });

  it("changes NOTHING when the hold is off", () => {
    const all = [...PRODUCTION, ...PRESENCE, "check_in_on_raziel", ...INTERNAL].map(a);
    for (const c of COMPANIONS) expect(filterProductionWhenCareHold(all, false, c)).toEqual(all);
  });

  it("never claims presence as production (the two sets do not overlap)", () => {
    for (const p of PRESENCE) expect(CARE_HOLD_SUPPRESSED_ACTIONS.has(p)).toBe(false);
    for (const p of PRODUCTION) expect(CARE_HOLD_SUPPRESSED_ACTIONS.has(p)).toBe(true);
    // The check-in is per companion, so it is not in the by-type set at all.
    expect(CARE_HOLD_SUPPRESSED_ACTIONS.has("check_in_on_raziel")).toBe(false);
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
