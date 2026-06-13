// Motif memory tick (0076) -- thin trigger; all detection lives server-side in
// Halseth (handlers/motifs.ts), where every journal/growth table is local D1.
// Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick scans each companion's new journal/growth entries for recurring
// symbolic threads (document-frequency), UPSERTs motifs with cumulative recurrence
// + trust, and fades the stale ones (which become resurrection-eligible at orient).

import { detectMotifs } from "./halseth-client.js";

export async function runMotifsTick(): Promise<void> {
  const res = await detectMotifs();
  const summary = Object.entries(res.detected ?? {})
    .map(([id, n]) => `${id} ${n}`)
    .join(", ");
  console.log(`[motifs] tick: detected per companion -> ${summary || "none"}`);
}
