// Weekly clearing-pass tick (Goal B, 2026-06-14) -- thin trigger; the high-substrate
// triage of the ratification backlog runs server-side in Halseth (handlers/clearing.ts),
// where the growth_journal is local D1 and the model key is a Cloudflare secret.
// Halseth-only writes; no floor lock. LIVE in prod (ANTHROPIC_API_KEY set on Halseth; no-ops only if unset).

import { runClearing } from "./halseth-client.js";

export async function runClearingTick(): Promise<void> {
  const res = await runClearing();
  if (res.skipped) {
    console.log(`[clearing] tick skipped: ${res.skipped}`);
    return;
  }
  console.log(
    `[clearing] tick: ${res.pending} growth (${res.declined} declined, ${res.shortlisted} shortlisted), ` +
    `${res.basins_reviewed} basins (${res.basins_dismissed} dismissed, ${res.basins_surfaced} surfaced)` +
    (res.letter_id ? `, letter ${res.letter_id}` : ""),
  );
}
