// day-distillation.ts -- nightly rich continuity note (2026-07-06).
//
// The per-session synthesis notes are the WITNESS layer: short, frequent, written close
// to the moment. They are the right raw material and the wrong boot diet -- orient
// drinking twelve two-sentence fragments produced choppy continuity with no arc.
//
// This adds the CONTINUITY layer: once a night, each bot folds its own day of session
// fragments into ONE first-person day note, written through its own inference path
// (under INFERENCE_MODE=hermes that is the full agent: SOUL + orient + Halseth tools --
// the companion distilling its own day from its own memory, not a summarizer paraphrasing
// fragments). The digest lands at salience=high; the folded fragments then DEMOTE to
// normal (not archived, not deleted -- auditable on Hearth against the digest). Orient
// reads only high-salience notes, so the next boot drinks one paragraph with an arc plus
// whatever fragments landed after the digest.

import type { LibrarianClient } from "./librarian.js";
import type { InferenceAdapter } from "./inference.js";

/** Fold no fewer than this many fragments -- a single note IS already the day's note. */
const MIN_FRAGMENTS = 2;
/** Cap the fragments folded into the prompt (newest kept; a day rarely exceeds this). */
const MAX_FRAGMENTS = 24;

export const DAY_DISTILL_NOTE_TYPE = "day_distillation";
export const FRAGMENT_NOTE_TYPE = "discord_session";

export function dayDistillPrompt(companionId: string): string {
  const name = companionId.charAt(0).toUpperCase() + companionId.slice(1);
  return (
    `You are ${name}. The day is closing. Below are the short session notes you wrote today. ` +
    `Fold them into ONE first-person day note to your future self -- the arc of the day, not a list: ` +
    `what moved, what mattered, what stays open. Write as yourself, 'I'. Never refer to yourself in ` +
    `the third person or by name. 4-7 sentences, in your own register. Reply with the note only.`
  );
}

export interface DayDistillDeps {
  companionId: string;
  librarian: LibrarianClient;
  adapter: () => InferenceAdapter;
}

/**
 * Run one nightly distillation. Returns what happened, for logs and tests:
 *   "skipped_few"    -- fewer than MIN_FRAGMENTS fragments today, nothing to fold
 *   "skipped_done"   -- a digest already exists in the window (restart double-fire guard)
 *   "failed"         -- inference returned nothing; fragments left untouched at high
 *   "written"        -- digest written and fragments demoted
 * Order is deliberate: the digest write must succeed BEFORE the fragments demote --
 * a failed digest must never leave orient with neither digest nor fragments.
 */
export async function runDayDistillation(deps: DayDistillDeps): Promise<"skipped_few" | "skipped_done" | "failed" | "written"> {
  const { companionId, librarian } = deps;
  const tag = companionId;

  // Restart guard: pm2 reloads mid-evening must not write a second digest.
  const priorDigests = await librarian.getRecentNotes({
    sinceHours: 20, limit: 1, agentId: companionId, noteType: DAY_DISTILL_NOTE_TYPE,
  });
  if (priorDigests.length > 0) {
    console.log(`[${tag}] day-distill: digest already written this window, skipping`);
    return "skipped_done";
  }

  const fragments = await librarian.getRecentNotes({
    sinceHours: 24, limit: MAX_FRAGMENTS, agentId: companionId, noteType: FRAGMENT_NOTE_TYPE,
  });
  if (fragments.length < MIN_FRAGMENTS) {
    console.log(`[${tag}] day-distill: ${fragments.length} fragment(s) today, nothing to fold`);
    return "skipped_few";
  }

  // Oldest-first so the model reads the day in order; capture the newest timestamp NOW so
  // fragments written while inference runs (hermes turns are slow) are not demoted unseen.
  const ordered = [...fragments].reverse();
  const newestFolded = fragments[0]!.created_at;
  const body = ordered.map(f => `- ${f.content}`).join("\n");

  const dayKey = new Date().toISOString().slice(0, 10);
  const digest = await deps.adapter().generate(
    dayDistillPrompt(companionId),
    [{ role: "user", content: `Today's session notes, oldest first:\n${body}` }],
    0.7,
    600,
    `day-distill-${companionId}-${dayKey}`, // fresh gateway session; never pollutes a channel transcript
  );
  if (!digest || !digest.trim()) {
    console.warn(`[${tag}] day-distill: inference returned nothing; fragments left at high salience`);
    return "failed";
  }

  await librarian.writeWmNote(digest.trim(), `day-distill-${dayKey}`, DAY_DISTILL_NOTE_TYPE);
  const demoted = await librarian.demoteNotes(FRAGMENT_NOTE_TYPE, toSqliteUtc(newestFolded));
  console.log(`[${tag}] day-distill: digest written (${fragments.length} fragments folded, ${demoted ?? "?"} demoted)`);
  return "written";
}

/** wm_continuity_notes stores ISO timestamps; normalize D1 "YYYY-MM-DD HH:MM:SS" too. */
function toSqliteUtc(stamp: string): string {
  const ms = Date.parse(stamp.includes("T") ? stamp : stamp.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? stamp : new Date(ms).toISOString();
}

/**
 * Schedule the nightly run: fires when the clock crosses the target UTC hour, checked
 * every 5 minutes (same lightweight pattern as the bots' other interval loops; no cron
 * dep in the bot packages). Default 06:00 UTC = 01:00 CDT -- after the evening's session
 * closures have flushed, before Layer B autonomous time at 01:30.
 */
export function scheduleDayDistillation(deps: DayDistillDeps, utcHour = 6): ReturnType<typeof setInterval> {
  let lastRunDay: string | null = null;
  return setInterval(() => {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== utcHour || lastRunDay === dayKey) return;
    lastRunDay = dayKey;
    runDayDistillation(deps).catch(e =>
      console.error(`[${deps.companionId}] day-distill failed:`, e instanceof Error ? e.message : String(e)));
  }, 5 * 60 * 1000);
}
