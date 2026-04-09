import { writeJournalEntry, writePattern, writeMarker, appendLog } from "../halseth-client.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 5: Write
 * Persist growth artifacts to Halseth.
 * Cap enforcement happens server-side (oldest rows pruned automatically).
 */
export async function runWrite(ctx: PipelineContext): Promise<void> {
  if (!ctx.journalEntry) {
    await appendLog(ctx.runId, "write:skip", "no journal entry to write");
    return;
  }

  await appendLog(ctx.runId, "write:start");

  // Write journal entry
  try {
    await writeJournalEntry(ctx.journalEntry);
    ctx.artifactsCreated += 1;
    await appendLog(ctx.runId, "write:journal-ok", `type=${ctx.journalEntry.entry_type}`);
  } catch (e) {
    await appendLog(ctx.runId, "write:journal-error", String(e));
    throw e; // journal is the primary artifact -- fail the run if it can't write
  }

  // Write any patterns identified during synthesis
  for (const pattern of ctx.newPatterns) {
    try {
      await writePattern(pattern);
      ctx.artifactsCreated += 1;
      await appendLog(ctx.runId, "write:pattern-ok", pattern.pattern_text.slice(0, 60));
    } catch (e) {
      // Patterns are secondary -- log and continue
      console.warn(`[${ctx.companionId}/write] Pattern write failed:`, e);
      await appendLog(ctx.runId, "write:pattern-error", String(e));
    }
  }

  // Write any markers
  for (const marker of ctx.newMarkers) {
    try {
      await writeMarker(marker);
      ctx.artifactsCreated += 1;
      await appendLog(ctx.runId, "write:marker-ok", marker.description.slice(0, 60));
    } catch (e) {
      console.warn(`[${ctx.companionId}/write] Marker write failed:`, e);
      await appendLog(ctx.runId, "write:marker-error", String(e));
    }
  }

  await appendLog(ctx.runId, "write:complete", `artifacts=${ctx.artifactsCreated}`);
}
