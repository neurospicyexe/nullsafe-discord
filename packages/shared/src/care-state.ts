// care-state.ts -- per-process registry for the care register (consequence layer C1).
//
// Same idiom as triggers.ts: bot-core writes it at boot and on every orient refresh; the message
// handler reads it synchronously at bid time. A ref-through-every-call-site would work too, but
// the armed-triggers registry is the established shape for "orient-derived state the handler
// needs mid-message", and two idioms for one job is one too many.
//
// What care_hold means at the floor: NOT silence. Direct address still answers (he asked; answering
// IS the care). What softens is ambient self-selection -- the bar for "I have something worth
// saying into his low-spoons evening unprompted" goes up, so presence stays and production quiets.

import type { RazielState } from "./librarian.js";

const careStates = new Map<string, RazielState | null>();

export function setCareState(companionId: string, state: RazielState | null | undefined): void {
  careStates.set(companionId, state ?? null);
}

export function getCareState(companionId: string): RazielState | null {
  return careStates.get(companionId) ?? null;
}

export function careHoldActive(companionId: string): boolean {
  return getCareState(companionId)?.care_hold ?? false;
}

/** When the current hold started (B32, contract: world.raziel_state.care_hold_since). null = unknown or off. */
export function careHoldSince(companionId: string): string | null {
  const s = getCareState(companionId);
  return s?.care_hold ? (s.care_hold_since ?? null) : null;
}

/**
 * B32: apply a hold start/clear to this process's register immediately, instead of waiting up to five
 * minutes for the next orient refresh. The next refresh overwrites it with Halseth's truth either way,
 * so a local apply that disagrees with the server can only last one refresh interval. Orient may have
 * failed at boot (state null), so a minimal register is built rather than dropping the hold.
 */
export function applyLocalHold(
  companionId: string,
  action: "start" | "clear",
  atIso: string,
  server?: { since?: string | null; reasons?: string[] | null },
): void {
  const prev: RazielState = getCareState(companionId) ?? {
    spoons: null, mood: null, pain: null, energy: null, meds_taken: null,
    recorded_at: null, staleness_hours: null, front_state: null,
    care_hold: false, pending_care: null,
  };
  if (action === "start") {
    const reasons = server?.reasons ?? [...new Set([...(prev.care_hold_reason ?? []), "owner_said"])];
    setCareState(companionId, {
      ...prev,
      care_hold: true,
      care_hold_since: server?.since ?? (prev.care_hold ? (prev.care_hold_since ?? atIso) : atIso),
      care_hold_reason: reasons,
    });
  } else {
    setCareState(companionId, { ...prev, care_hold: false, care_hold_since: null, care_hold_reason: [] });
  }
}
