/**
 * Nullsafe Autonomous Worker
 *
 * Standalone process that runs companion autonomous exploration on a cron schedule.
 * Each companion gets their own cron slot (Cypher 3AM / Drevan 5AM / Gaia 7AM).
 *
 * Per run (6 phases):
 *   1. Orient  -- load full identity + botOrient state + growth context
 *   2. Seed    -- pick unused seed or self-generate from identity
 *   3. Explore -- Tavily web search + DeepSeek summarization through companion lens
 *   4. Synthesize -- draft growth_journal entry in companion voice
 *   5. Write   -- persist to Halseth growth tables
 *   6. Reflect -- brief reflection + extract new seed suggestions
 *
 * Env vars required:
 *   HALSETH_URL, HALSETH_SECRET
 *   DEEPSEEK_API_KEY
 *   TAVILY_API_KEY
 *   REDIS_URL (optional but recommended)
 *   CYPHER_IDENTITY_PATH, DREVAN_IDENTITY_PATH, GAIA_IDENTITY_PATH
 */

import { startScheduler } from "./scheduler.js";
import { runPipeline } from "./pipeline.js";
import { runSignalAudit } from "./phases/signal-audit.js";
import type { CompanionId } from "./types.js";

const args = process.argv.slice(2);
const onceIdx = args.indexOf("--once");
const signalAuditIdx = args.indexOf("--signal-audit");
const companionArg = args.find(a => a.startsWith("--companion="))?.split("=")[1] as CompanionId | undefined;

if (signalAuditIdx !== -1) {
  // One-shot signal audit mode
  const companions: CompanionId[] = companionArg ? [companionArg] : ["cypher", "drevan", "gaia"];
  console.log(`[autonomous-worker] signal-audit mode: ${companions.join(", ")}`);

  (async () => {
    for (const companionId of companions) {
      console.log(`\n── signal-audit: ${companionId} ──`);
      await runSignalAudit(companionId);
    }
    console.log("\n[autonomous-worker] signal-audit complete");
    process.exit(0);
  })().catch(e => {
    console.error("[autonomous-worker] signal-audit failed:", e);
    process.exit(1);
  });
} else if (onceIdx !== -1) {
  // One-shot exploration mode: run immediately for specified companion (or all)
  const companions: CompanionId[] = companionArg ? [companionArg] : ["cypher", "drevan", "gaia"];
  console.log(`[autonomous-worker] one-shot mode: ${companions.join(", ")}`);

  (async () => {
    for (const companionId of companions) {
      console.log(`\n── ${companionId} ──`);
      await runPipeline(companionId, "exploration");
    }
    console.log("\n[autonomous-worker] one-shot complete");
    process.exit(0);
  })().catch(e => {
    console.error("[autonomous-worker] one-shot failed:", e);
    process.exit(1);
  });
} else {
  // Daemon mode: register cron jobs and keep process alive
  console.log("[autonomous-worker] starting daemon");
  startScheduler();
  console.log("[autonomous-worker] cron daemon running");

  process.on("SIGTERM", () => {
    console.log("[autonomous-worker] SIGTERM received, shutting down");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("[autonomous-worker] SIGINT received, shutting down");
    process.exit(0);
  });
}
