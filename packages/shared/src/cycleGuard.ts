// cycleGuard.ts
//
// Circuit breaker for autonomous heartbeat cycles.
// Detects stuck loops by tracking consecutive identical-temperature cycles
// within a rolling time window. Does NOT analyze output content -- the check
// happens on the input (temperature = SOMA-derived register signal) before
// the inference call, so no DeepSeek credits are burned on stuck cycles.
//
// Design constraints honored:
//   - Structural signal (temperature/register), not surface content
//   - "Same concept, new angle" passes: temperature changes with SOMA across sessions
//   - "Same concept, same angle" trips: temperature stable, N identical cycles in window
//   - Recovery: skip silently first, escalate after escalateAfter skips
//   - Unpause: time-based (windowMs rolling drop-off) + explicit reset() on human signal

export type CycleResult = "proceed" | "skip" | "escalate";

interface CycleEntry {
  temp: string;
  ts: number;
}

export class CycleGuard {
  private cycles: CycleEntry[] = [];
  private skipCount = 0;
  private readonly windowMs: number;
  readonly threshold: number;
  private readonly escalateAfter: number;

  constructor(opts: { windowMs?: number; threshold?: number; escalateAfter?: number } = {}) {
    // 30-minute window: old cycles drop out naturally, giving the bot a new window
    // after genuine quiet. Trip at 3 identical-temp cycles in window (blocks the 4th+).
    this.windowMs = opts.windowMs ?? 30 * 60 * 1000;
    this.threshold = opts.threshold ?? 3;
    this.escalateAfter = opts.escalateAfter ?? 2;
  }

  // Call before inference.generate in the heartbeat handler.
  // temperature: the SOMA-derived HeartbeatTemperature string for this cycle.
  check(temperature: string): CycleResult {
    const now = Date.now();

    // Drop cycles outside the rolling window.
    this.cycles = this.cycles.filter(c => now - c.ts < this.windowMs);

    // Count how many recorded cycles share this temperature inside the window.
    const identical = this.cycles.filter(c => c.temp === temperature).length;

    if (identical >= this.threshold) {
      this.skipCount++;
      const result: CycleResult = this.skipCount >= this.escalateAfter ? "escalate" : "skip";
      return result;
    }

    // Proceeding -- record this cycle and reset the skip counter.
    this.skipCount = 0;
    this.cycles.push({ temp: temperature, ts: now });
    return "proceed";
  }

  // Call when a human signal arrives (Discord message from owner, session event, etc.)
  // Clears the window so the next cycle is always allowed through.
  reset(): void {
    this.cycles = [];
    this.skipCount = 0;
  }
}
