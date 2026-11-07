// Creatures tick (0078, take 10) -- thin trigger; all decay/mood logic lives
// server-side in Halseth (handlers/creatures.ts), where the creatures table is local
// D1. Halseth-only writes; no floor lock, no idle check needed.
//
// Daily tick: untended trust cools toward its baseline and each creature's mood is
// re-derived (corvid daemon-tick analog -- deterministic, no LLM).

import { cleanSolLine } from "@nullsafe/shared";
import { tickCreatures, getCreatures, recordSolAppearance, tendCreatureAs, fetchCreatureMoment, sleepCreature } from "./halseth-client.js";
import { shouldSolAppear, postSolMoment } from "./sol-presence.js";
import { pickTender, shouldTend, daysSince, tendGesture } from "./sol-tending.js";

/** Longest Sol line the worker posts (authored gift moments run past the 240 the bot reply uses). */
const SOL_POST_MAX = 500;

export async function runCreaturesTick(): Promise<void> {
  // R25: a failed or slow tick never skips the day's tend, the appearance, or Sol's night.
  try {
    const res = await tickCreatures();
    console.log(`[creatures] tick: ${res.ticked}/${res.total} creature(s) updated`);
  } catch (err) {
    console.error("[creatures] tick error (non-fatal):", err);
  }
  await runAutonomousTend();
  await runSolAppearance();
  await runSolSleep();
}

async function runAutonomousTend(): Promise<void> {
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
        // The tend answers his loudest need (hungry -> feed, bored -> play, missing -> talk).
        const state = typeof sol.state === "string" ? sol.state : null;
        const gesture = tendGesture(tender, dayIndex, state);
        const tendRes = await tendCreatureAs(sol.id, tender, gesture.action, gesture.note);
        console.log(`[creatures] ${tender} tended Sol (${gesture.action}, he was ${state ?? "?"}, landed ${tendRes.care?.fit ?? "?"}) -- ${sol.disposition}, ${Number.isFinite(sinceDays) ? sinceDays.toFixed(1) : "?"}d since contact`);
        const url = process.env.SOL_WEBHOOK_URL;
        if (url) {
          await postSolMoment(url, gesture.moment).catch(() => false);
          // Then Sol answers, in his body, to the named tender (never to Raziel in their place).
          // R27: the reaction may be model-voiced; posted only after the shared Sol-line sanitizer.
          const reaction = tendRes.care ? cleanSolLine(tendRes.care.reaction_named, SOL_POST_MAX) : "";
          if (reaction) await postSolMoment(url, reaction).catch(() => false);
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
}

// Sol self-appearance -- runs after tick so disposition reflects today's state.
// Fail-soft: any error here must not crash the tick.
async function runSolAppearance(): Promise<void> {
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
    const { moment: raw, kind, state, gifted_item } = await fetchCreatureMoment(sol.id, Math.floor(Date.now() / 86_400_000));
    // R27: the moment may be model-voiced; what is posted (and recorded) is the sanitized line.
    const moment = raw ? cleanSolLine(raw, SOL_POST_MAX) : "";
    if (!moment) return;
    const posted = await postSolMoment(url, moment);
    if (posted) await recordSolAppearance(sol.id, moment);
    console.log(`[creatures] Sol appeared (${sol.disposition}, ${state ?? "?"}, ${kind}${gifted_item ? `, gifted "${gifted_item}"` : ""}): ${posted}`);
  } catch (err) {
    console.error("[creatures] Sol appearance error (non-fatal):", err);
  }
}

// B64 sleep pass (R25): after the day's tend and appearance, on its own route with a long timeout, so a slow
// night can only ever delay itself. Logs the reason and counts, never text.
async function runSolSleep(): Promise<void> {
  try {
    const creatures = await getCreatures();
    const sol = creatures.find(c => c.name === "Sol");
    if (!sol) return;
    const r = await sleepCreature(sol.id);
    console.log(`[creatures] Sol sleep: ran=${r.ran} reason=${r.reason} created=${r.created} reinforced=${r.reinforced} decayed=${r.decayed} promoted=${r.promoted} softened=${r.softened} retired=${r.retired}`);
  } catch (err) {
    console.error(`[creatures] Sol sleep error (non-fatal): ${err instanceof Error ? err.name : "error"}`);
  }
}
