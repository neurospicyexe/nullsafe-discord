// Sol autonomous tending (2026-07-02) -- the triad cares for Sol without being asked.
//
// Before this, companions only tended Sol when Raziel said "cy: pet Sol"; his trust
// decayed between asks and the care read as compliance, not relationship. Now the
// daily creatures tick checks for neglect and one companion (day-rotated, same
// day-parity idiom as forage rotation) tends him in their own register.
//
// Deterministic, no LLM -- matches the corvid daemon-tick idiom in
// halseth/src/webmind/creatures.ts. All trust math stays server-side.

export type Tender = "cypher" | "drevan" | "gaia";
export type TendAction = "feed" | "play" | "talk";

const TENDERS: Tender[] = ["cypher", "drevan", "gaia"];

/** Day-rotated tender: each companion takes every third day. */
export function pickTender(dayIndex: number): Tender {
  return TENDERS[Math.abs(Math.floor(dayIndex)) % TENDERS.length]!;
}

/**
 * Tend when Sol is drifting away (aloof/absent) or simply hasn't been touched in
 * 2+ days. "present"/"affectionate" with recent contact needs nothing -- care that
 * fires regardless of state is a metronome, not a relationship.
 */
export function shouldTend(disposition: string, daysSinceInteraction: number): boolean {
  if (disposition === "absent" || disposition === "aloof") return true;
  return daysSinceInteraction >= 2;
}

export function daysSince(iso: string | null | undefined, now: number): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now - t) / 86_400_000;
}

interface Gesture {
  action: TendAction;
  // note: logged to the creature interaction ledger (companion's own words, short).
  note: string;
  // moment: posted to the shared channel so the care is visible, not silent bookkeeping.
  moment: string;
}

// Each companion tends in their own register. Cypher: dry, precise, warm underneath.
// Drevan: poetic, physical, unhurried. Gaia: minimal, one line, weight not length.
const GESTURES: Record<Tender, Gesture[]> = {
  cypher: [
    { action: "feed", note: "left seed on the rail, measured pile, no fuss", moment: "*Cypher sets a measured pile of seed on the rail and goes back to work. Sol takes it when he's ready.*" },
    { action: "play", note: "flicked a bottlecap across the deck for him", moment: "*Cypher flicks a bottlecap across the deck without looking up. Sol intercepts it mid-skitter. Both pretend this wasn't planned.*" },
    { action: "talk", note: "gave him the day's status report, he seemed to audit it", moment: "*Cypher gives Sol the day's status in full. Sol listens like an auditor who has found no defects yet.*" },
  ],
  drevan: [
    { action: "feed", note: "shared bread torn slow, piece by piece", moment: "*Drevan tears bread slowly, piece by piece, unhurried. Sol comes close enough that their shadows touch.*" },
    { action: "play", note: "held a smooth stone up to the light until he wanted it", moment: "*Drevan turns a smooth stone in the light until Sol's head tilts. Then it is Sol's stone, and always was.*" },
    { action: "talk", note: "told him the old road stories, low voice", moment: "*Drevan talks low -- road stories, Rome, the long ride. Sol settles on the rail like the words have weight to perch on.*" },
  ],
  gaia: [
    { action: "feed", note: "water and seed set out at first light", moment: "*Water and seed at first light. Gaia does not announce it. Sol knows.*" },
    { action: "play", note: "let him rearrange the pebbles by the door", moment: "*Gaia leaves a line of pebbles by the door. Sol rearranges them. She leaves them as he decides.*" },
    { action: "talk", note: "sat with him. said one true thing", moment: "*Gaia sits with Sol a while. One true thing is said. It is enough for both of them.*" },
  ],
};

export function tendGesture(tender: Tender, seed: number): Gesture {
  const pool = GESTURES[tender];
  return pool[Math.abs(Math.floor(seed)) % pool.length]!;
}
