import type { WakeKind } from "@nullsafe/shared";

export type TickRunner = () => Promise<unknown>;

/**
 * Builds a guarded dispatcher for ritual ticks that can be triggered either by a Redis
 * wake event or by their cron fallback. Both paths call the SAME dispatcher, so the
 * in-flight guard prevents a wake from racing a cron tick (or two wakes) into a
 * double-run of the same ritual.
 *
 * Returns a `dispatch(kind)` that resolves to:
 *   true  -- the runner executed
 *   false -- skipped (no runner for this kind, or one was already in flight)
 *
 * Mirrors the scheduler's per-companion `running` guard, keyed by wake kind.
 */
export function createWakeDispatcher(runners: Partial<Record<WakeKind, TickRunner>>) {
  const inFlight = new Set<WakeKind>();

  return async function dispatch(kind: WakeKind): Promise<boolean> {
    const runner = runners[kind];
    if (!runner) return false;
    if (inFlight.has(kind)) {
      console.log(`[wake] ${kind} already in flight, skipping`);
      return false;
    }
    inFlight.add(kind);
    try {
      await runner();
      return true;
    } finally {
      inFlight.delete(kind);
    }
  };
}
