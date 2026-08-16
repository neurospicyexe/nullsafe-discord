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
