// Drift-lane activation tick (Track 0e activation, 2026-06-18) -- thin trigger; the work runs
// server-side in Halseth (handlers/drift.ts): Gaia witnesses open drifts and the safety floor pauses
// any reading as dissolution. Halseth-only writes; no floor lock. LIVE in prod (ANTHROPIC_API_KEY set on Halseth; no-ops only if unset).

import { runDriftPass } from "./halseth-client.js";

export async function runDriftPassTick(): Promise<void> {
  const res = await runDriftPass();
  if (res.skipped) {
    console.log(`[drift-pass] tick skipped: ${res.skipped}`);
    return;
  }
  console.log(
    `[drift-pass] tick: ${res.open} open drifts, ${res.witnessed} witnessed, ${res.paused} paused` +
    (res.letter_id ? `, letter ${res.letter_id}` : ""),
  );
}
