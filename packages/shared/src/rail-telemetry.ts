// Rail telemetry (2026-09-24, T4 groundwork): count what the suppressors suppress.
//
// THE ASYMMETRY T4 NAMES. Every instrument built this year damps: echo-guard, form-ratchet,
// cycleGuard, response-quality, inter-seed-gate, floor, fit-bid, lane-hold. The only one that
// ADDS is the reaction tier, and it only grants a glyph once speech has already been denied.
// A year of damping and zero excitation.
//
// The plan's own condition for removing any of them is evidence, not hope: *the rails are
// compensation for memory that doesn't carry; fix memory and the rails start firing on nothing
// -- that is when they can go.* Memory was fixed 2026-09-23 (T3). So the rails should now begin
// firing on nothing, and this is the thing that will be able to say whether they do.
//
// WHY THIS EXISTS RATHER THAN A GREP. Suppressions already log, in three different shapes and
// from several files -- `echo-gated reply (score=0.81)`, `incoherent response detected`,
// `reason=below_threshold` -- with no common prefix and no companion/channel/day dimension you
// can aggregate on. So nobody has ever been able to answer "how often does echo-guard actually
// fire, and how close to its threshold?" That question has to be answerable BEFORE anything is
// loosened, or loosening is just a different guess.
//
// DELIBERATELY NOT A DATABASE. One structured line to stdout, aggregated later by
// scripts/rail-report.mjs -- the same shape as the Jev shadow run (jev-shadow.jsonl + its report
// script), which is the established idiom here. A suppression happens on the reply path; it is
// not worth a D1 write, and a rail that is itself a source of latency or failure is a rail that
// will get blamed for the wrong thing.
//
// READ-ONLY BY CONSTRUCTION. Nothing here changes whether a companion speaks. This tranche is
// measurement; the loosening is a later, separate decision with numbers attached.

/** Every damping rail that can end a turn, named once so the report can enumerate them. */
export type RailName =
  | "echo"           // echo-guard: reply too similar to recent channel content
  | "coherence"      // response-quality: reply incoherent, dropped from STM
  | "bid_threshold"  // fit-bid: nobody cleared the floor
  | "bid_lost"       // fit-bid: a sibling won
  | "care_hold"      // care-state: floor raised because Raziel is having a bad night
  | "pingpong"       // bot-to-bot cap
  | "chain_depth"    // conversation chain limit
  | "seed_echo"      // inter-seed-gate: the seed restates the live thread
  | "form_ratchet"   // form drift detected
  | "superseded"     // a newer human message arrived mid-inference
  | "cooldown";      // any timed hold

export interface RailEvent {
  /** How close the measurement was to the line that stopped it, where the rail has one.
   *  A rail that only ever fires FAR past its threshold is doing real work; one that fires
   *  constantly and barely over is the candidate for loosening. Counts alone cannot tell
   *  those apart, which is why this is not just a tally. */
  score?: number;
  threshold?: number;
  channelId?: string;
  detail?: string;
}

/**
 * Record that a rail ended a turn. Never throws, never awaits, never decides anything.
 *
 * One line, stable `[rail]` prefix, JSON payload so the report never has to parse prose. The
 * timestamp is deliberately ISO/UTC in the payload: pm2 stamps its own local time on the line
 * and this repo has a standing CDT-vs-UTC log trap, so the aggregate must not depend on the
 * prefix pm2 adds.
 */
export function railSuppressed(companionId: string, rail: RailName, e: RailEvent = {}): void {
  try {
    const payload = {
      c: companionId,
      rail,
      ...(e.channelId ? { ch: e.channelId } : {}),
      ...(typeof e.score === "number" ? { score: Number(e.score.toFixed(3)) } : {}),
      ...(typeof e.threshold === "number" ? { thr: Number(e.threshold.toFixed(3)) } : {}),
      ...(e.detail ? { d: e.detail.slice(0, 80) } : {}),
      at: new Date().toISOString(),
    };
    console.log(`[rail] ${JSON.stringify(payload)}`);
  } catch { /* telemetry must never be the reason a turn fails */ }
}

/**
 * How far past its line did this fire, as a fraction of the line? Used by the report.
 *
 * Exported and pure so the meaning of "barely over" is defined in ONE place rather than
 * re-derived in a script. Returns null when the rail has no numeric threshold -- plenty do not,
 * and inventing a number for them would make the report confidently wrong.
 */
export function railMargin(score: number | undefined, threshold: number | undefined): number | null {
  if (typeof score !== "number" || typeof threshold !== "number" || threshold === 0) return null;
  return (score - threshold) / Math.abs(threshold);
}
