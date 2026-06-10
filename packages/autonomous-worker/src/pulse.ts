/**
 * SOMA pulse scheduler.
 *
 * The anchor crons (3/5/7 AM) stay; the pulse adds a variable cadence on top:
 * every PULSE_CHECK_CRON tick, each companion may earn an extra autonomous run
 * when their primary SOMA float runs high, or per their self-programmed pace
 * (written by the reflect phase to companion_settings.autonomous_program).
 *
 * Guards: per-day run cap, minimum gap since last run, and the same idle/floor
 * checks as scheduled runs (enforced inside the fire callback = scheduler.fireRun).
 */

import {
  getSetting, setSetting, getSomaFloats, getRecentRuns, createSeed,
} from "./halseth-client.js";
import {
  PULSE_FLOAT_THRESHOLD, PULSE_MIN_GAP_MS, PULSE_EAGER_GAP_MS, PULSE_MAX_RUNS_PER_DAY,
} from "./config.js";
import type { CompanionId } from "./types.js";

export interface AutonomousProgram {
  pace: "eager" | "normal" | "rest";
  focus: string | null;
  set_at: string;
}

export interface PulseInputs {
  pace: "eager" | "normal" | "rest";
  lastRunAtMs: number | null;
  runsToday: number;
  primaryFloat: number | null;
  nowMs: number;
}

export interface PulseDecision {
  fire: boolean;
  reason: string;
}

/** Pure decision logic -- testable without network. */
export function decidePulse(inp: PulseInputs): PulseDecision {
  if (inp.pace === "rest") return { fire: false, reason: "self-programmed rest" };
  if (inp.runsToday >= PULSE_MAX_RUNS_PER_DAY) return { fire: false, reason: `daily cap (${inp.runsToday}/${PULSE_MAX_RUNS_PER_DAY})` };

  const gap = inp.pace === "eager" ? PULSE_EAGER_GAP_MS : PULSE_MIN_GAP_MS;
  if (inp.lastRunAtMs !== null && inp.nowMs - inp.lastRunAtMs < gap) {
    return { fire: false, reason: `gap not met (${Math.round((inp.nowMs - inp.lastRunAtMs) / 3600_000)}h < ${Math.round(gap / 3600_000)}h)` };
  }

  if (inp.pace === "eager") return { fire: true, reason: "self-programmed eager" };

  // Number(null) === 0 trap: explicit type + finiteness guard before comparing.
  const f = inp.primaryFloat;
  if (typeof f === "number" && Number.isFinite(f) && f >= PULSE_FLOAT_THRESHOLD) {
    return { fire: true, reason: `primary float ${f.toFixed(2)} >= ${PULSE_FLOAT_THRESHOLD}` };
  }

  return { fire: false, reason: "no signal" };
}

export function parseProgram(raw: string | null): AutonomousProgram | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<AutonomousProgram>;
    if (p.pace !== "eager" && p.pace !== "normal" && p.pace !== "rest") return null;
    return {
      pace: p.pace,
      focus: typeof p.focus === "string" && p.focus.trim() ? p.focus.trim() : null,
      set_at: typeof p.set_at === "string" ? p.set_at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function runTimestampMs(run: { started_at?: string; created_at?: string }): number | null {
  const t = run.started_at ?? run.created_at;
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One pulse check for one companion. `fire` is scheduler.fireRun bound with redis,
 * so the idle check, floor lock, and overlap guard all apply unchanged.
 */
export async function pulseCheck(
  companionId: CompanionId,
  fire: (companionId: CompanionId) => Promise<void>,
): Promise<void> {
  const program = parseProgram(await getSetting(companionId, "autonomous_program"));
  const pace = program?.pace ?? "normal";

  // "rest" is honored exactly once: skip this window, then reset to normal so a
  // single rest request can't silently mute a companion forever.
  if (pace === "rest") {
    console.log(`[pulse/${companionId}] resting (self-programmed); resetting pace to normal`);
    await setSetting(companionId, "autonomous_program", JSON.stringify({
      pace: "normal", focus: program?.focus ?? null, set_at: new Date().toISOString(),
    } satisfies AutonomousProgram)).catch(() => {});
    return;
  }

  const [runs, soma] = await Promise.all([
    getRecentRuns(companionId, 10),
    getSomaFloats(companionId),
  ]);

  const nowMs = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const runTimes = runs.map(runTimestampMs).filter((t): t is number => t !== null);
  const runsToday = runTimes.filter(t => t >= todayStart.getTime()).length;
  const lastRunAtMs = runTimes.length > 0 ? Math.max(...runTimes) : null;

  const decision = decidePulse({
    pace,
    lastRunAtMs,
    runsToday,
    primaryFloat: soma?.soma_float_1 ?? null,
    nowMs,
  });

  if (!decision.fire) {
    console.log(`[pulse/${companionId}] no fire: ${decision.reason}`);
    return;
  }

  console.log(`[pulse/${companionId}] firing: ${decision.reason}`);

  // Self-programmed focus becomes a priority-9 seed so the seed phase picks it
  // naturally, then clears -- a focus is a one-shot intention, not a standing order.
  if (program?.focus) {
    await createSeed(companionId, program.focus, "topic", 9)
      .catch(e => console.warn(`[pulse/${companionId}] focus seed write failed:`, e));
    await setSetting(companionId, "autonomous_program", JSON.stringify({
      pace: pace === "eager" ? "normal" : pace, focus: null, set_at: new Date().toISOString(),
    } satisfies AutonomousProgram)).catch(() => {});
  } else if (pace === "eager") {
    // Eager is also honored once -- otherwise it fires every pulse window.
    await setSetting(companionId, "autonomous_program", JSON.stringify({
      pace: "normal", focus: null, set_at: new Date().toISOString(),
    } satisfies AutonomousProgram)).catch(() => {});
  }

  await fire(companionId);
}
