// Creatures tick (0078, take 10) -- thin trigger; all decay/mood logic lives
// server-side in Halseth (handlers/creatures.ts), where the creatures table is local
// D1. Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick: untended trust cools toward its baseline and each creature's mood is
// re-derived (corvid daemon-tick analog -- deterministic, no LLM).

import { tickCreatures, getCreatures, recordSolAppearance, tendCreatureAs, fetchCreatureMoment } from "./halseth-client.js";
import { shouldSolAppear, postSolMoment } from "./sol-presence.js";
import { pickTender, shouldTend, daysSince, tendGesture } from "./sol-tending.js";

export async function runCreaturesTick(): Promise<void> {
  const res = await tickCreatures();
  console.log(`[creatures] tick: ${res.ticked}/${res.total} creature(s) updated`);

  // Autonomous tending (2026-07-02): before this, companions only tended Sol when
  // Raziel asked -- his trust decayed between asks. Now neglect triggers care from
  // one day-rotated companion, in their own register, visible in the channel.
  // Runs BEFORE the appearance roll so a freshly-tended Sol can show up warmer.
  // Fail-soft: tending errors must not block the tick or the appearance.
  try {
    const creatures = await getCreatures();
    const sol = creatures.find(c => c.name === "Sol");
    if (sol) {
      const now = Date.now();
      const sinceDays = daysSince((sol.last_interaction_at as string | null) ?? (sol.created_at as string | null), now);
      if (shouldTend(sol.disposition, sinceDays)) {
        const dayIndex = Math.floor(now / 86_400_000);
        const tender = pickTender(dayIndex);
        const gesture = tendGesture(tender, dayIndex);
        const tendRes = await tendCreatureAs(sol.id, tender, gesture.action, gesture.note);
        console.log(`[creatures] ${tender} tended Sol (${gesture.action}) -- ${sol.disposition}, ${Number.isFinite(sinceDays) ? sinceDays.toFixed(1) : "?"}d since contact`);
        const url = process.env.SOL_WEBHOOK_URL;
        if (url) {
          await postSolMoment(url, gesture.moment).catch(() => false);
          // Milestones (0100) fire once ever -- if this tend crossed one, the
          // channel sees it or nobody does.
          for (const m of tendRes.milestones_fired) {
            console.log(`[creatures] Sol milestone fired: ${m.id} (witnessed by ${tender})`);
            await postSolMoment(url, m.text).catch(() => false);
          }
        }
      }
    }
  } catch (err) {
    console.error("[creatures] autonomous tend error (non-fatal):", err);
  }

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
    // Moment text comes from Halseth (drives x trust tier, occasionally a gift
    // from the nest). Seed = day index so a re-run tick composes the same scene.
    const { moment, kind, state, gifted_item } = await fetchCreatureMoment(sol.id, Math.floor(Date.now() / 86_400_000));
    if (!moment) return;
    const posted = await postSolMoment(url, moment);
    if (posted) await recordSolAppearance(sol.id, moment);
    console.log(`[creatures] Sol appeared (${sol.disposition}, ${state ?? "?"}, ${kind}${gifted_item ? `, gifted "${gifted_item}"` : ""}): ${posted}`);
  } catch (err) {
    console.error("[creatures] Sol appearance error (non-fatal):", err);
  }
}
