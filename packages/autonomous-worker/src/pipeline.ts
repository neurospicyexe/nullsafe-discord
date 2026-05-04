import { createRun, updateRun, appendLog } from "./halseth-client.js";
import { runOrient } from "./phases/orient.js";
import { runSeed } from "./phases/seed.js";
import { runExplore } from "./phases/explore.js";
import { runSynthesize } from "./phases/synthesize.js";
import { runWrite } from "./phases/write.js";
import { runReflect } from "./phases/reflect.js";
import { runSomaUpdate } from "./phases/soma.js";
import type { CompanionId, RunType, PipelineContext } from "./types.js";

/**
 * Run a full 6-phase autonomous pipeline for one companion.
 * Creates an autonomy_run record, threads a PipelineContext through each phase,
 * and marks the run completed (or failed) when done.
 *
 * Phase failures in 1-4 abort the run (incomplete data = no artifact).
 * Phase 5 (write) failure also aborts.
 * Phase 6 (reflect) failure is non-fatal -- journal entry already persisted.
 */
export interface PipelineResult {
  seedTopic: string | null;
  explorationSummary: string | null;
  journalEntryId: string | null;
}

export async function runPipeline(companionId: CompanionId, runType: RunType = "exploration"): Promise<PipelineResult> {
  console.log(`[${companionId}/pipeline] starting ${runType} run`);

  const runId = await createRun(companionId, runType);

  const ctx: PipelineContext = {
    companionId,
    runId,
    runType,
    identityText: "",
    orientSummary: "",
    recentGrowth: [],
    activePatterns: [],
    unexaminedDreamIds: [],
    openLoops: [],
    pressureFlags: [],
    activeThreads: [],
    peerActivity: null,
    seed: null,
    seedDecisionReason: null,
    threadId: null,
    threadPosition: null,
    searchResults: [],
    explorationSummary: null,
    explorationEvidence: [],
    journalEntry: null,
    newPatterns: [],
    newMarkers: [],
    reflectionText: null,
    newSeeds: [],
    journalEntryId: null,
    tokensUsed: 0,
    artifactsCreated: 0,
  };

  try {
    // Phase 1: Load full identity + orient context
    await runOrient(ctx);

    // Phase 2: Select or generate exploration seed
    // Seed phase may mutate ctx.runType, ctx.threadId, ctx.threadPosition
    await runSeed(ctx);

    // If seed phase set a thread or changed run type, back-patch the run record
    if (ctx.threadId || ctx.runType !== runType) {
      await updateRun(runId, {
        ...(ctx.threadId ? { thread_id: ctx.threadId, thread_position: ctx.threadPosition ?? 1 } : {}),
      }).catch(() => {}); // non-fatal
    }

    // Phase 3: Web search + summarize through companion lens
    await runExplore(ctx);

    // Phase 4: Synthesize growth journal entry in companion voice
    await runSynthesize(ctx);

    // Phase 5: Write artifacts to Halseth
    await runWrite(ctx);

    // Phase 6: Reflection + new seed generation (non-fatal)
    await runReflect(ctx);

    // Phase 7: SOMA state update (non-fatal) -- close the read/write gap
    await runSomaUpdate(ctx);

    // Mark run complete
    await updateRun(runId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      tokens_used: ctx.tokensUsed,
      artifacts_created: ctx.artifactsCreated,
    });

    console.log(`[${companionId}/pipeline] completed: ${ctx.artifactsCreated} artifacts, ${ctx.tokensUsed} tokens`);
    return {
      seedTopic: ctx.seed?.content ?? null,
      explorationSummary: ctx.explorationSummary,
      journalEntryId: ctx.journalEntryId,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${companionId}/pipeline] run ${runId} failed:`, err);

    await appendLog(runId, "pipeline:error", errMsg)
      .catch((e2: unknown) => console.error(`[${companionId}/pipeline] appendLog failed for run ${runId}:`, String(e2)));
    await updateRun(runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      tokens_used: ctx.tokensUsed,
      artifacts_created: ctx.artifactsCreated,
      error_message: errMsg.slice(0, 500),
    }).catch((e2: unknown) => console.error(`[${companionId}/pipeline] CRITICAL: failed to mark run ${runId} as failed — next cron may retry:`, String(e2)));
    return { seedTopic: null, explorationSummary: null, journalEntryId: null };
  }
}
