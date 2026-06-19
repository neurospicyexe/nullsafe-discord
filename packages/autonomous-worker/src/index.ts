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

import "./env.js"; // MUST be first: fills process.env from .env before config.ts reads it
import { startScheduler } from "./scheduler.js";
import { runPipeline } from "./pipeline.js";
import { runSignalAudit } from "./phases/signal-audit.js";
import { runDialectic } from "./dialectic.js";
import { runForage } from "./forage.js";
import { runGuardianResolve } from "./phases/guardian-resolve.js";
import { runClearingTick } from "./clearing.js";
import { runDriftPassTick } from "./drift-pass.js";
import { runClubTick } from "./club.js";
import { runGuardianTick } from "./guardian.js";
import { runMotifsTick } from "./motifs.js";
import { runCreaturesTick } from "./creatures.js";
import { runCouncilTick } from "./council.js";
import { runDreamAssociate } from "./dream-associate.js";
import type { CompanionId } from "./types.js";

const args = process.argv.slice(2);
const onceIdx = args.indexOf("--once");
const signalAuditIdx = args.indexOf("--signal-audit");
const dialecticIdx = args.indexOf("--dialectic");
const forageIdx = args.indexOf("--forage");
const clubIdx = args.indexOf("--club");
const guardianIdx = args.indexOf("--guardian");
const guardianResolveIdx = args.indexOf("--guardian-resolve");
const clearingIdx = args.indexOf("--clearing");
const driftPassIdx = args.indexOf("--drift-pass");
const motifsIdx = args.indexOf("--motifs");
const creaturesIdx = args.indexOf("--creatures");
const councilIdx = args.indexOf("--council");
const dreamsIdx = args.indexOf("--dreams");
const companionArg = args.find(a => a.startsWith("--companion="))?.split("=")[1] as CompanionId | undefined;

if (councilIdx !== -1) {
  // One-shot council tick: run the ritual for the oldest open question, then exit.
  console.log("[autonomous-worker] council mode");
  runCouncilTick()
    .then(id => { console.log(`[autonomous-worker] council tick complete${id ? ` (${id})` : " (no open question)"}`); process.exit(0); })
    .catch(e => { console.error("[autonomous-worker] council tick failed:", e); process.exit(1); });
} else if (dreamsIdx !== -1) {
  // One-shot dream association tick.
  console.log("[autonomous-worker] dreams mode");
  runDreamAssociate()
    .then(() => { console.log("[autonomous-worker] dreams tick complete"); process.exit(0); })
    .catch(e => { console.error("[autonomous-worker] dreams tick failed:", e); process.exit(1); });
} else if (creaturesIdx !== -1) {
  // One-shot creatures tick: cool untended trust + re-derive mood, then exit.
  console.log("[autonomous-worker] creatures mode");
  runCreaturesTick()
    .then(() => {
      console.log("[autonomous-worker] creatures tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] creatures tick failed:", e);
      process.exit(1);
    });
} else if (motifsIdx !== -1) {
  // One-shot motif tick: detect recurring threads server-side, then exit.
  console.log("[autonomous-worker] motifs mode");
  runMotifsTick()
    .then(() => {
      console.log("[autonomous-worker] motifs tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] motifs tick failed:", e);
      process.exit(1);
    });
} else if (guardianIdx !== -1) {
  // One-shot guardian tick: run detectors server-side, then exit.
  console.log("[autonomous-worker] guardian mode");
  runGuardianTick()
    .then(() => {
      console.log("[autonomous-worker] guardian tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] guardian tick failed:", e);
      process.exit(1);
    });
} else if (guardianResolveIdx !== -1) {
  // One-shot guardian self-resolution: each companion clears its own resolvable flags.
  console.log("[autonomous-worker] guardian-resolve mode");
  runGuardianResolve()
    .then(n => {
      console.log(`[autonomous-worker] guardian-resolve complete: ${n} flag(s) resolved`);
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] guardian-resolve failed:", e);
      process.exit(1);
    });
} else if (clearingIdx !== -1) {
  // One-shot clearing pass: high-substrate triage of the ratification backlog, then exit.
  console.log("[autonomous-worker] clearing mode");
  runClearingTick()
    .then(() => {
      console.log("[autonomous-worker] clearing tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] clearing tick failed:", e);
      process.exit(1);
    });
} else if (driftPassIdx !== -1) {
  // One-shot drift-lane pass: Gaia witnesses open drifts + the safety floor pauses dissolution, then exit.
  console.log("[autonomous-worker] drift-pass mode");
  runDriftPassTick()
    .then(() => {
      console.log("[autonomous-worker] drift-pass tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] drift-pass tick failed:", e);
      process.exit(1);
    });
} else if (clubIdx !== -1) {
  // One-shot club tick: advance the current round's phase, then exit.
  console.log("[autonomous-worker] club mode");
  runClubTick()
    .then(() => {
      console.log("[autonomous-worker] club tick complete");
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] club tick failed:", e);
      process.exit(1);
    });
} else if (forageIdx !== -1) {
  // One-shot forage mode: gather outward fuel into the shared pool, then exit.
  console.log("[autonomous-worker] forage mode");
  runForage()
    .then(gathered => {
      console.log(`[autonomous-worker] forage complete: ${gathered} find(s) gathered`);
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] forage failed:", e);
      process.exit(1);
    });
} else if (dialecticIdx !== -1) {
  // One-shot tension dialectic mode
  console.log("[autonomous-worker] dialectic mode");
  runDialectic()
    .then(outcomes => {
      console.log(`[autonomous-worker] dialectic complete: ${outcomes.length} tension(s) debated`);
      process.exit(0);
    })
    .catch(e => {
      console.error("[autonomous-worker] dialectic failed:", e);
      process.exit(1);
    });
} else if (signalAuditIdx !== -1) {
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
