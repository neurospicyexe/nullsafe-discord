// Creatures tick (0078, take 10) -- thin trigger; all decay/mood logic lives
// server-side in Halseth (handlers/creatures.ts), where the creatures table is local
// D1. Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick: untended trust cools toward its baseline and each creature's mood is
// re-derived (corvid daemon-tick analog -- deterministic, no LLM).

import { tickCreatures } from "./halseth-client.js";

export async function runCreaturesTick(): Promise<void> {
  const res = await tickCreatures();
  console.log(`[creatures] tick: ${res.ticked}/${res.total} creature(s) updated`);
}
