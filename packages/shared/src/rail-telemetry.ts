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
  | "verbatim"       // verbatim-copy rail: reply is a byte copy of a sibling's or my own recent message (09-26)
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

// ---------------------------------------------------------------------------
// Heartbeat tick outcomes (B7 step 1, 2026-09-27): make silence LEGIBLE.
//
// The 09-27 reach-out audit's sharpest finding: a companion choosing not to interrupt and a
// crashed turn are currently the same observable, which is nothing. The justification gate
// logged nothing per tick, and the readout caught two heartbeats dying on
// "decision parse failed, skipping" (a shrug, at warn level, indistinguishable from a chosen
// hold; B23 later found most of those WERE chosen holds, lost to a missing `nothing` row). Until those are separable we cannot say whether the system is exercising judgement or
// quietly broken, and the readout proves both happen.
//
// So: exactly ONE line per proactive tick, per companion, naming the outcome and its reason.
// Same shape as railSuppressed (one line, stable prefix, JSON payload, ISO/UTC timestamp in the
// payload because pm2 stamps its own local time and this repo has a standing CDT-vs-UTC trap).
// ---------------------------------------------------------------------------

/** Why a proactive tick ended the way it did. `chose_to_hold` is a SUCCESS, not an error. */
export type HeartbeatOutcome =
  | "chose_to_act"            // a metronome action ran
  | "chose_to_hold"           // the model decided silence; the right answer is often this
  | "suppressed_quiet_hours"  // the local-clock window is in force and nothing was quiet-hours-allowed
  | "suppressed_verdict_unknown" // no quiet-hours verdict available; treated as in force, which is NOT the same event
  | "suppressed_care_hold"    // care_hold: production quiets, presence stays
  | "no_eligible_actions"     // the palette had nothing eligible (cooldowns, caps, silence windows)
  | "no_reach_justified"      // the justification gate left only actions that could not fire
  | "signals_undetected"      // every eligible action required a signal that was not present
  | "conversation_active"     // he is mid-conversation somewhere
  | "recent_activity"         // activity within the last 15 minutes
  | "not_my_window"           // another companion owns this heartbeat window
  | "floor_held"              // a sibling holds the floor
  | "suppressed_triad_cap"    // B7 2+2c: every eligible move was a DM move the shared triad lane could not carry now
  | "held_dm"                 // B7 2+2c: a DM move was chosen and did not go out (cap race, a failed check, no DM); never re-sent
  | "suppressed_reach_dm_off" // REACH_DM is off and every eligible move was a DM move; NOT the same event as a closed lane
  | "decision_unparsed"       // B23: no decision could be read, even after the one re-ask; a DEFECT (was `parse_failed`)
  | "chose_unoffered"         // B23: a well-formed pick of a move not offered right now, after the re-ask; never run
  | "no_reply"                // B23: the decision call got no text at all (every provider failed); not re-asked
  | "error";                  // the action threw

export interface HeartbeatTickInfo {
  /** The action that ran or was chosen, when there was one. */
  action?: string;
  /** The model's own stated reason, or the rail's reason; trimmed for one-line greppability. */
  reason?: string;
  /** Local hour in the quiet-hours zone, when a quiet-hours verdict was available. */
  localHour?: number | null;
  tz?: string;
  /** REACH_DM off: how many DM moves the switch removed from this tick's palette (emitted as `dm_moves_off`). */
  dmMovesOff?: number;
  /** B23: the decision needed its one re-ask, and whether that re-ask produced a readable choice. */
  retry?: "recovered" | "unrecovered";
  /** B23: why the first reply was re-asked (emitted as `retry_cause`). */
  retryCause?: "unparsed" | "unoffered";
}

/**
 * Record how one proactive tick ended. Never throws, never awaits, never decides anything.
 * One line, stable `[tick]` prefix, so `grep '\[tick\]'` is the whole story of what the
 * metronome did and did not do.
 */
export function heartbeatTick(companionId: string, outcome: HeartbeatOutcome, info: HeartbeatTickInfo = {}): void {
  try {
    const payload = {
      c: companionId,
      outcome,
      ...(info.action ? { action: info.action } : {}),
      ...(info.reason ? { reason: info.reason.slice(0, 160) } : {}),
      ...(typeof info.localHour === "number" ? { hour: info.localHour } : {}),
      ...(info.tz ? { tz: info.tz } : {}),
      ...(typeof info.dmMovesOff === "number" && info.dmMovesOff > 0 ? { dm_moves_off: info.dmMovesOff } : {}),
      ...(info.retry ? { retry: info.retry } : {}),
      ...(info.retryCause ? { retry_cause: info.retryCause } : {}),
      at: new Date().toISOString(),
    };
    console.log(`[tick] ${JSON.stringify(payload)}`);
  } catch { /* telemetry must never be the reason a tick fails */ }
}
