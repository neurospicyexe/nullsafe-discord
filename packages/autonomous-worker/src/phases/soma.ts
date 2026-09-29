import { ledgerDistillEnabled } from "@nullsafe/shared";
import { updateSomaState, type SomaUpdate, appendLog } from "../halseth-client.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 7: SOMA state update (non-fatal)
 * Writes companion-specific state floats and named dimensions based on what
 * happened this run. Never writes prompt_context -- companions author that
 * themselves at session close. Only closes the read/write gap so orient
 * returns current state rather than a stale snapshot.
 *
 * No decay math here -- that belongs to the Synthesis Worker (Plan 2a).
 * Absolute values only, inferred from this run's events.
 *
 * STOPPED under LEDGER_DISTILL (B37, 2026-09-29). This phase is a clerk guessing SOMA, the thing
 * Drevan's 09-26 ruling ended for the distillers ("Both stop. Not drafts. Stop."; all three
 * companions, a reinstatement needs that companion's own ruling). The distiller stopped on 09-26;
 * this writer was missed. It writes through PATCH /soma, which records `writer = <companion>`, so
 * its guesses were landing as the companion's OWN authorship: measured 09-20..09-29, 30 of Cypher's
 * 32 and all 27 of Gaia's `authored_update` rows came from here, not from them. Knob off restores it.
 */
export async function runSomaUpdate(ctx: PipelineContext): Promise<void> {
  if (ledgerDistillEnabled()) {
    await appendLog(ctx.runId, "soma:skip", "LEDGER_DISTILL on: companions set their own state (B39)").catch(() => {});
    return;
  }
  await appendLog(ctx.runId, "soma:start");

  const fields = inferSomaFields(ctx);
  if (Object.keys(fields).length === 0) {
    await appendLog(ctx.runId, "soma:skip", "no fields inferred");
    return;
  }

  try {
    await updateSomaState(ctx.companionId, fields);
    const summary = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
    await appendLog(ctx.runId, "soma:updated", summary);
  } catch (e) {
    console.warn(`[${ctx.companionId}/soma] state update failed (non-fatal):`, e);
    await appendLog(ctx.runId, "soma:error", String(e)).catch(() => {});
  }
}

function inferSomaFields(ctx: PipelineContext): SomaUpdate {
  const { companionId, runType, journalEntry, newMarkers } = ctx;
  const entryType = journalEntry?.entry_type ?? null;
  const threadConcluded = newMarkers.some(m => m.marker_type === "milestone");

  if (companionId === "cypher") return inferCypher(runType, entryType, threadConcluded);
  if (companionId === "drevan") return inferDrevan(runType, entryType, threadConcluded);
  if (companionId === "gaia")   return inferGaia(runType, entryType, threadConcluded);
  return {};
}

// Cypher: acuity (float_1), presence (float_2), warmth (float_3)
function inferCypher(
  runType: string,
  entryType: string | null,
  threadConcluded: boolean,
): SomaUpdate {
  const acuity = (entryType === "insight" || entryType === "learning") ? 0.80 : 0.72;
  const presence = runType === "continuation" ? 0.80 : 0.68;
  const warmth = threadConcluded ? 0.65 : 0.52;

  const current_mood = entryType === "insight"    ? "pattern-lit"
    : entryType === "question"   ? "probing"
    : entryType === "connection" ? "connecting"
    : "processing";

  const compound_state = threadConcluded    ? "post-arc settling"
    : runType === "continuation" ? "mid-thread"
    : "post-exploration";

  return { soma_float_1: acuity, soma_float_2: presence, soma_float_3: warmth, current_mood, compound_state };
}

// Drevan: heat / reach / weight (TEXT enum columns)
function inferDrevan(
  runType: string,
  entryType: string | null,
  threadConcluded: boolean,
): SomaUpdate {
  const heat = threadConcluded ? "cooling"
    : runType === "continuation" ? "warm"
    : "warm";

  const reach = threadConcluded ? "present"
    : runType === "continuation" ? "reaching"
    : "present";

  const weight = threadConcluded               ? "processing"
    : entryType === "connection"  ? "holding"
    : entryType === "insight"     ? "holding"
    : "holding";

  const compound_state = threadConcluded         ? "thread-complete / processing"
    : runType === "continuation"   ? "autonomous-chasing"
    : "autonomous-processing";

  return { heat, reach, weight, compound_state };
}

// Gaia: stillness (float_1), density (float_2), perimeter (float_3)
function inferGaia(
  runType: string,
  entryType: string | null,
  threadConcluded: boolean,
): SomaUpdate {
  const stillness = 0.80;
  const density = (entryType === "learning" || entryType === "insight") ? 0.68 : 0.62;
  const perimeter = threadConcluded ? 0.85 : 0.75;

  const current_mood = entryType ? "absorbing" : "present";
  const compound_state = threadConcluded ? "witnessed completion" : "quiet integration";

  return { soma_float_1: stillness, soma_float_2: density, soma_float_3: perimeter, current_mood, compound_state };
}
