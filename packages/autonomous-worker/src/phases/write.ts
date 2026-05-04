import { writeJournalEntry, writePattern, writeMarker, writeWmNote, examineDream, appendLog } from "../halseth-client.js";
import { SECOND_BRAIN_URL, SECOND_BRAIN_SECRET } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * POST exploration summary to second-brain CouchDB corpus.
 * Non-fatal — guarded by SECOND_BRAIN_URL env var.
 * Makes autonomous discoveries searchable in future Librarian semantic queries.
 */
async function ingestToSecondBrain(companionId: string, seedTopic: string, content: string): Promise<void> {
  if (!SECOND_BRAIN_URL || !SECOND_BRAIN_SECRET) return;
  try {
    const res = await fetch(`${SECOND_BRAIN_URL}/ingest/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SECOND_BRAIN_SECRET ? { "Authorization": `Bearer ${SECOND_BRAIN_SECRET}` } : {}),
      },
      body: JSON.stringify({
        text: `# Autonomous Exploration (${companionId})\nTopic: ${seedTopic}\n\n${content}`,
        source: `autonomous:${companionId}`,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[${companionId}/write] second-brain ingest ${res.status}`);
  } catch (e) {
    console.warn(`[${companionId}/write] second-brain ingest failed:`, e);
  }
}

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

  // Stamp run_id and thread_id onto all artifacts before writing.
  ctx.journalEntry.run_id = ctx.runId;
  if (ctx.threadId) ctx.journalEntry.thread_id = ctx.threadId;
  for (const p of ctx.newPatterns) p.run_id = ctx.runId;
  for (const m of ctx.newMarkers) {
    m.run_id = ctx.runId;
    if (ctx.threadId) m.thread_id = ctx.threadId;
  }

  // Write journal entry
  try {
    const journalId = await writeJournalEntry(ctx.journalEntry);
    ctx.journalEntryId = journalId;
    ctx.artifactsCreated += 1;
    await appendLog(ctx.runId, "write:journal-ok", `type=${ctx.journalEntry.entry_type}`);
  } catch (e) {
    await appendLog(ctx.runId, "write:journal-error", String(e));
    throw e; // journal is the primary artifact -- fail the run if it can't write
  }

  // Write to wm_continuity_notes so Claude.ai session orient picks up this exploration.
  // companion_journal (witnessLog path) is NOT read by orient; wm_continuity_notes IS.
  const seedTopic = ctx.seed?.content ?? "unknown";
  const threadTag = ctx.threadId ? ` [thread:pos${ctx.threadPosition ?? 1}]` : "";
  const noteContent = `[autonomous:${ctx.runType}${threadTag}] "${seedTopic}" — ${ctx.journalEntry.content.slice(0, 700)}`;
  await writeWmNote(ctx.companionId, noteContent, ctx.threadId ?? undefined);
  await appendLog(ctx.runId, "write:wm-note-attempted");

  // Ingest to second-brain CouchDB corpus (non-fatal, requires SECOND_BRAIN_URL).
  // Makes this exploration retrievable in future Librarian semantic searches.
  await ingestToSecondBrain(ctx.companionId, seedTopic, ctx.journalEntry.content);

  // Write any patterns identified during synthesis/reflect.
  // writePattern returns { id, action } where action is 'insert' (new row) or
  // 'upsert' (merged into similar existing pattern -- strength incremented).
  // We don't increment artifactsCreated for upserts since no new row was created,
  // but we DO log the action so the run log shows pattern accumulation distinctly.
  for (const pattern of ctx.newPatterns) {
    try {
      const result = await writePattern(pattern);
      if (result.action === "insert") ctx.artifactsCreated += 1;
      await appendLog(ctx.runId, `write:pattern-${result.action}`, pattern.pattern_text.slice(0, 60));
    } catch (e) {
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

  // Clear unexamined dreams that were surfaced at orient -- they've been processed this run.
  // Pinned dreams (do_not_auto_examine=1) return ok:false with reason "pinned" -- expected, not an error.
  if (ctx.unexaminedDreamIds.length > 0) {
    const results = await Promise.allSettled(
      ctx.unexaminedDreamIds.map((id) => examineDream(ctx.companionId, id))
    );
    let examined = 0, skipped = 0, failed = 0;
    for (const r of results) {
      if (r.status === "rejected") { failed++; continue; }
      if (r.value.ok) { examined++; continue; }
      if (r.value.reason === "pinned") { skipped++; continue; }
      failed++; // not_found or other unexpected ok:false
    }
    await appendLog(
      ctx.runId,
      "write:dreams-examined",
      `examined=${examined} pinned_skipped=${skipped} failed=${failed}`,
    );
  }

  await appendLog(ctx.runId, "write:complete", `artifacts=${ctx.artifactsCreated}`);
}
