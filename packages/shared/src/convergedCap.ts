// convergedCap.ts
//
// Generalised converged-judgment cap (BBH PLAN-from-review-2026-09-20 T5, last bullet):
// "N declines on unchanged state -> stop; reset on state change."
//
// WHY: the memory judge re-asked an LLM the same question over the same state and was declined
// every time; it cost 100.6M of a week's 186M tokens. That one was fixed locally. This is the
// reusable rule for any repeated LLM judgment: after N consecutive declines at one key whose
// state fingerprint has not moved, stop asking. Any change of fingerprint, or an affirmative
// answer, or an explicit reset (a human signal), re-arms it.
//
// Pure and in-memory (a bot restart re-arms it, which is the safe direction). Not a replacement for
// CycleGuard (a rolling-window breaker on one signal); this keys on the whole input state.

import { createHash } from "node:crypto";

export interface ConvergedCapOpts {
  /** Consecutive declines on an unchanged fingerprint before the judgment is withheld. 0 disables. */
  maxDeclines?: number;
}

interface Entry { fp: string; declines: number }

/** Stable short fingerprint of any JSON-able state. Key order does not matter. */
export function stateFingerprint(state: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canon(state)) ?? "undefined").digest("hex").slice(0, 16);
}

export class ConvergedJudgmentCap {
  private readonly entries = new Map<string, Entry>();
  readonly maxDeclines: number;

  constructor(opts: ConvergedCapOpts = {}) {
    const n = opts.maxDeclines ?? 3;
    this.maxDeclines = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** True when the judgment has converged: N declines already recorded on this exact fingerprint. */
  isCapped(key: string, fingerprint: string): boolean {
    if (this.maxDeclines === 0) return false;
    const e = this.entries.get(key);
    return !!e && e.fp === fingerprint && e.declines >= this.maxDeclines;
  }

  /** Record a decline. A fingerprint that differs from the last one restarts the count at 1. */
  recordDecline(key: string, fingerprint: string): number {
    const e = this.entries.get(key);
    const declines = e && e.fp === fingerprint ? e.declines + 1 : 1;
    this.entries.set(key, { fp: fingerprint, declines });
    return declines;
  }

  /** An affirmative judgment (the thing acted) clears the key. */
  recordAccept(key: string): void { this.entries.delete(key); }

  /** Explicit state change (a human signal): clear one key, or everything. */
  reset(key?: string): void { if (key === undefined) this.entries.clear(); else this.entries.delete(key); }
}
