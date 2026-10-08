import { createRun, updateRun, appendLog, setHomePresence, sweepStaleThreads, spendBudget } from "./halseth-client.js";
import { isProjectRun } from "./phases/seed.js";
import { runOrient } from "./phases/orient.js";
import { runSeed } from "./phases/seed.js";
import { runExplore } from "./phases/explore.js";
import { runSynthesize } from "./phases/synthesize.js";
import { runWrite } from "./phases/write.js";
import { runReflect } from "./phases/reflect.js";
import { runSomaUpdate } from "./phases/soma.js";
import { runSiblingExchange } from "./siblings.js";
import { AUTONOMOUS_TIME_ROOMS } from "./config.js";
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

/** Pipeline runs in THIS process (resets on restart, like node-cron's timers). */
let pipelineTick = 0;

/** Phases in order; `phases_run` counts how many `await runX(ctx)` calls returned. */
const PIPELINE_PHASES = ["orient", "seed", "explore", "synthesize", "reflect", "write", "soma"] as const;

/**
 * One line per pipeline run, uniform shape, counts only (P3-18, 2026-10-08). A worker with no
 * `[observability]` line persists nothing visible and reads as a broken feature; this is the
 * line the health check can grep. Every field is a counter the run already keeps:
 * phases_run / phases_failed from the phase sequence, artifacts + tokens from ctx, nonfatal_failed
 * from the non-fatal catch handlers. There is no halseth post/fail counter in halseth-client, so
 * none is reported here (do not invent one).
 */
function observabilityLine(f: {
  tick: number; companionId: CompanionId; runId: string; status: "completed" | "failed" | "budget_skipped";
  phasesRun: number; phasesFailed: number; nonFatalFailed: number; artifacts: number; tokens: number; ms: number;
}): string {
  return `[observability] tick=${f.tick} companion=${f.companionId} run=${f.runId} status=${f.status} ` +
    `phases_run=${f.phasesRun}/${PIPELINE_PHASES.length} phases_failed=${f.phasesFailed} nonfatal_failed=${f.nonFatalFailed} ` +
    `artifacts=${f.artifacts} tokens=${f.tokens} ms=${f.ms}`;
}

export async function runPipeline(companionId: CompanionId, runType: RunType = "exploration"): Promise<PipelineResult> {
  console.log(`[${companionId}/pipeline] starting ${runType} run`);
  const tick = ++pipelineTick;
  const startedAt = Date.now();
  let phasesRun = 0;
  let nonFatalFailed = 0;

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
    recentWmNotes: [],
    recentSessionNotes: [],
    recentFeelings: [],
    recentConclusions: [],
    seed: null,
    seedDecisionReason: null,
    project: null,
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

  // Weekly budget (C3, mig 0124; R2: 1 credit = 1 run). Debited BEFORE any phase runs, tagged
  // with the run's purpose (project day vs self-exploration -- same parity the seed phase uses).
  // A spent week SKIPS the run with the reason in-band: the run row + log line carry it, so a
  // quiet week is visibly chosen scarcity, never indistinguishable from a dead worker.
  const purpose = isProjectRun(new Date()) ? "project" : "self";
  const spend = await spendBudget(companionId, purpose, runId);
  if (!spend.ok) {
    console.log(`[${companionId}/pipeline] run skipped: ${spend.reason}`);
    await appendLog(runId, "pipeline:budget", `run skipped -- ${spend.reason}`).catch(() => {});
    await updateRun(runId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      error_message: `budget: ${spend.reason}`,
    }).catch(() => {});
    console.log(observabilityLine({ tick, companionId, runId, status: "budget_skipped", phasesRun: 0, phasesFailed: 0, nonFatalFailed: 0, artifacts: 0, tokens: 0, ms: Date.now() - startedAt }));
    return { seedTopic: null, explorationSummary: null, journalEntryId: null };
  }

  try {
    // Phase 1: Load full identity + orient context
    await runOrient(ctx);
    phasesRun++;

    // Mark presence in home_presence so the topology reflects autonomous session activity.
    // Non-fatal -- pipeline continues even if the write fails.
    await setHomePresence(companionId, AUTONOMOUS_TIME_ROOMS[companionId], "in autonomous session");

    // Phase 2: Select or generate exploration seed
    // Seed phase may mutate ctx.runType, ctx.threadId, ctx.threadPosition
    await runSeed(ctx);
    phasesRun++;

    // If seed phase set a thread or changed run type, back-patch the run record
    if (ctx.threadId || ctx.runType !== runType) {
      await updateRun(runId, {
        ...(ctx.threadId ? { thread_id: ctx.threadId, thread_position: ctx.threadPosition ?? 1 } : {}),
      }).catch(() => {}); // non-fatal
    }

    // Phase 3: Web search + summarize through companion lens
    await runExplore(ctx);
    phasesRun++;

    // Phase 4: Synthesize growth journal entry in companion voice
    await runSynthesize(ctx);
    phasesRun++;

    // Phase 5: Reflection + new seed generation -- pushes patterns/markers into ctx
    // before write iterates them. Reflect doesn't need journalEntryId; write stamps
    // run_id on patterns/markers after the fact.
    await runReflect(ctx);
    phasesRun++;

    // Phase 6: Write artifacts to Halseth (journal + patterns + markers)
    await runWrite(ctx);
    phasesRun++;

    // Phase 7: SOMA state update (non-fatal) -- close the read/write gap
    await runSomaUpdate(ctx);
    phasesRun++;

    // C4 sibling exchange (R3 = yes, 2026-08-17; non-fatal): the private lane lives HERE, in the
    // unwatched runtime, and nowhere else. Rides the run rather than costing one -- a note to a
    // sibling is not an autonomous exploration. Content never reaches ctx, the journal, or logs.
    await runSiblingExchange(companionId)
      .catch(e => { nonFatalFailed++; console.warn(`[${companionId}/pipeline] sibling exchange failed (non-fatal):`, e); });

    // Thread hygiene (2026-07-02, non-fatal): resolve machine-opened auto:*
    // threads untouched for 14 days. The conclude path alone never kept up --
    // ~220 open per companion had accumulated by the time this landed.
    await sweepStaleThreads(companionId)
      .then(n => { if (n > 0) return appendLog(runId, "pipeline:thread-sweep", `resolved ${n} stale auto threads`); })
      .catch(e => { nonFatalFailed++; console.warn(`[${companionId}/pipeline] thread sweep failed (non-fatal):`, e); });

    // Mark run complete
    await updateRun(runId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      tokens_used: ctx.tokensUsed,
      artifacts_created: ctx.artifactsCreated,
    });

    console.log(`[${companionId}/pipeline] completed: ${ctx.artifactsCreated} artifacts, ${ctx.tokensUsed} tokens`);
    console.log(observabilityLine({ tick, companionId, runId, status: "completed", phasesRun, phasesFailed: 0, nonFatalFailed, artifacts: ctx.artifactsCreated, tokens: ctx.tokensUsed, ms: Date.now() - startedAt }));
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
    // The throwing phase is the one after the last counted; phases_failed is 1 by construction
    // (phase failures abort the run), kept as a field so the line's shape never changes.
    console.log(observabilityLine({ tick, companionId, runId, status: "failed", phasesRun, phasesFailed: 1, nonFatalFailed, artifacts: ctx.artifactsCreated, tokens: ctx.tokensUsed, ms: Date.now() - startedAt }));
    return { seedTopic: null, explorationSummary: null, journalEntryId: null };
  }
}
