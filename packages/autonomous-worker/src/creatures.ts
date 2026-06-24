// Creatures tick (0078, take 10) -- thin trigger; all decay/mood logic lives
// server-side in Halseth (handlers/creatures.ts), where the creatures table is local
// D1. Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick: untended trust cools toward its baseline and each creature's mood is
// re-derived (corvid daemon-tick analog -- deterministic, no LLM).

import { tickCreatures, getCreatures, recordSolAppearance } from "./halseth-client.js";
import { shouldSolAppear, solMomentText, postSolMoment } from "./sol-presence.js";

export async function runCreaturesTick(): Promise<void> {
  const res = await tickCreatures();
  console.log(`[creatures] tick: ${res.ticked}/${res.total} creature(s) updated`);

  // Sol self-appearance -- runs after tick so disposition reflects today's state.
  // Fail-soft: any error here must not crash the tick.
  try {
    const url = process.env.SOL_WEBHOOK_URL;
    if (!url) { console.warn("[creatures] SOL_WEBHOOK_URL unset; no Sol presence"); return; }
    const creatures = await getCreatures();
    const sol = creatures.find(c => c.name === "Sol");
    if (!sol) return;
    if (!shouldSolAppear(sol.disposition, Math.random())) {
      console.log(`[creatures] Sol stays away (${sol.disposition})`);
      return;
    }
    const text = solMomentText(sol.disposition, Date.now());
    if (!text) return;
    const posted = await postSolMoment(url, text);
    if (posted) await recordSolAppearance(sol.id, text);
    console.log(`[creatures] Sol appeared (${sol.disposition}): ${posted}`);
  } catch (err) {
    console.error("[creatures] Sol appearance error (non-fatal):", err);
  }
}
