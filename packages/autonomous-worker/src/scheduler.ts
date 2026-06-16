import cron from "node-cron";
import type { Redis } from "@nullsafe/shared";
import { createRedisClient, publishRunComplete, publishExplorationPulse, setPresence, createSubscriberClient, onWake } from "@nullsafe/shared";
import { createWakeDispatcher } from "./wake-dispatch.js";
import { isConversationActive } from "./idle-check.js";
import { claimFloor, releaseFloor } from "@nullsafe/shared";
import { runPipeline } from "./pipeline.js";
import { runCompress } from "./phases/compress.js";
import { runSeedGeneration } from "./phases/seed-gen.js";
import { runSignalAudit } from "./phases/signal-audit.js";
import { pulseCheck } from "./pulse.js";
import { runDialectic } from "./dialectic.js";
import { runForage } from "./forage.js";
import { runClubTick } from "./club.js";
import { runGuardianTick } from "./guardian.js";
import { runGuardianResolve } from "./phases/guardian-resolve.js";
import { runClearingTick } from "./clearing.js";
import { runMotifsTick } from "./motifs.js";
import { runCreaturesTick } from "./creatures.js";
import { runCouncilTick } from "./council.js";
import { runDreamAssociate } from "./dream-associate.js";
import { COMPANIONS, CRON_SCHEDULES, REDIS_URL, FLOOR_LOCK_DURATION_MS, PULSE_CHECK_CRON, DIALECTIC_CRON, FORAGE_CRON, CLUB_CRON, GUARDIAN_CRON, GUARDIAN_RESOLVE_CRON, CLEARING_CRON, MOTIF_CRON, CREATURE_CRON, COUNCIL_CRON, DREAM_CRON } from "./config.js";
import type { CompanionId } from "./types.js";

/** Guards against overlapping runs for the same companion. */
const running = new Set<CompanionId>();

export async function fireRun(companionId: CompanionId, redis: Redis | null): Promise<void> {
  if (running.has(companionId)) {
    console.log(`[scheduler/${companionId}] already running, skipping`);
    return;
  }

  // Idle check: skip if humans were active recently
  if (redis) {
    const active = await isConversationActive(redis).catch(() => false);
    if (active) {
      console.log(`[scheduler/${companionId}] conversation active, skipping`);
      return;
    }
  }

  // Floor claim: ensure only one bot is running autonomously at a time
  let floorClaimed = false;
  if (redis) {
    floorClaimed = await claimFloor(redis, `autonomous:${companionId}`, FLOOR_LOCK_DURATION_MS).catch(() => false);
    if (!floorClaimed) {
      console.log(`[scheduler/${companionId}] floor held by another process, skipping`);
      return;
    }
  }

  running.add(companionId);
  // Signal presence so bots know autonomous work is happening
  if (redis) setPresence(redis, `autonomous:${companionId}`).catch(() => {});

  const startedAt = Date.now();
  try {
    const result = await runPipeline(companionId, "exploration");
    const completedAt = new Date().toISOString();

    if (redis) {
      // Notify all bot processes that a run completed — they refresh their orient context
      await publishRunComplete(redis, {
        companionId,
        runId: `${companionId}:${startedAt}`,
        runType: "exploration",
        artifactsCreated: 0,
        tokensUsed: 0,
        completedAt,
      }).catch(() => {});

      // Broadcast exploration content so sibling bots can write continuity notes
      // without waiting for the next botOrient poll cycle.
      if (result.seedTopic && result.explorationSummary) {
        await publishExplorationPulse(redis, {
          fromCompanionId: companionId,
          seedTopic: result.seedTopic,
          explorationSummary: result.explorationSummary.slice(0, 800),
          journalEntryId: result.journalEntryId ?? "none",
          exploredAt: completedAt,
        }).catch(() => {});
      }
    }
  } finally {
    running.delete(companionId);
    if (redis && floorClaimed) {
      await releaseFloor(redis, `autonomous:${companionId}`).catch(() => {});
    }
  }
}

/**
 * Register per-companion cron jobs.
 * Reads CRON_SCHEDULES from config (env-overridable).
 */
export function startScheduler(): void {
  const redis = REDIS_URL ? createRedisClient(REDIS_URL) : null;
  if (!redis) {
    console.warn("[scheduler] REDIS_URL not set -- idle check and floor lock disabled");
  }

  // Wake dispatcher: rituals that are otherwise polled on a cron can be triggered
  // immediately by a Redis wake event. Both the wake subscription and the cron route
  // through the SAME dispatcher, so the in-flight guard prevents a wake from racing
  // its cron fallback into a double-run. Add a kind here + a publisher to extend.
  const dispatch = createWakeDispatcher({
    council: runCouncilTick,
  });

  if (REDIS_URL) {
    const subscriber = createSubscriberClient(REDIS_URL);
    onWake(subscriber, (payload) => {
      console.log(`[scheduler] wake received: ${payload.kind}${payload.reason ? ` (${payload.reason})` : ""}`);
      dispatch(payload.kind).catch(e => console.error(`[scheduler] wake dispatch ${payload.kind} failed:`, e));
    });
    console.log("[scheduler] wake subscription active");
  }

  for (const companionId of COMPANIONS) {
    const schedule = CRON_SCHEDULES[companionId];
    console.log(`[scheduler] ${companionId} → cron "${schedule}"`);

    cron.schedule(schedule, () => {
      fireRun(companionId, redis)
        .then(() => runCompress(companionId))
        .catch(e =>
          console.error(`[scheduler/${companionId}] unhandled error:`, e)
        );
    });
  }

  // Weekly seed replenishment -- Sunday 1AM, sequential to avoid DeepSeek burst
  cron.schedule("0 1 * * 0", () => {
    (async () => {
      for (const companionId of COMPANIONS) {
        await runSeedGeneration(companionId).catch(e =>
          console.error(`[scheduler/${companionId}] seed-gen failed:`, e)
        );
      }
    })();
  });

  // Weekly signal audit -- Wednesday 2AM, sequential, staggered from seed-gen
  // Reads own journal/patterns, surfaces themes/tensions/growth edges,
  // writes signal_audit journal entry + replenishes 1-2 seeds per companion.
  cron.schedule("0 2 * * 3", () => {
    (async () => {
      for (const companionId of COMPANIONS) {
        await runSignalAudit(companionId).catch(e =>
          console.error(`[scheduler/${companionId}] signal-audit failed:`, e)
        );
      }
    })();
  });

  // SOMA pulse -- variable cadence on top of the anchor crons. Sequential with
  // a stagger so companions never race for the floor on the same tick.
  // fireRun is passed as the callback, so idle check + floor lock + overlap
  // guard apply to pulse-triggered runs exactly as they do to scheduled ones.
  console.log(`[scheduler] pulse check → cron "${PULSE_CHECK_CRON}"`);
  cron.schedule(PULSE_CHECK_CRON, () => {
    (async () => {
      for (const companionId of COMPANIONS) {
        await pulseCheck(companionId, id => fireRun(id, redis)).catch(e =>
          console.error(`[scheduler/${companionId}] pulse check failed:`, e)
        );
        await new Promise(r => setTimeout(r, 90_000));
      }
    })();
  });

  // Weekly tension dialectic -- Wednesday 4AM, staggered from the 2AM signal audit.
  console.log(`[scheduler] dialectic → cron "${DIALECTIC_CRON}"`);
  cron.schedule(DIALECTIC_CRON, () => {
    runDialectic().catch(e => console.error("[scheduler] dialectic failed:", e));
  });

  // Daily forage -- gathers outward fuel into the shared pool. Deliberately after the
  // night pipeline runs so fresh finds land before human-present sessions, not during.
  // No floor lock needed: foraging writes to Halseth only, never speaks in Discord.
  console.log(`[scheduler] forage → cron "${FORAGE_CRON}"`);
  cron.schedule(FORAGE_CRON, () => {
    runForage().catch(e => console.error("[scheduler] forage failed:", e));
  });

  // The Club -- daily tick advances the current round's phase (open/vote/discuss).
  // Halseth-only writes; no floor lock needed.
  console.log(`[scheduler] club → cron "${CLUB_CRON}"`);
  cron.schedule(CLUB_CRON, () => {
    runClubTick().catch(e => console.error("[scheduler] club failed:", e));
  });

  // Unified Guardian -- daily meta-observer tick (detection server-side in Halseth).
  // Halseth-only writes; no floor lock needed. Sunday tick also writes the weekly letter.
  console.log(`[scheduler] guardian → cron "${GUARDIAN_CRON}"`);
  cron.schedule(GUARDIAN_CRON, () => {
    runGuardianTick().catch(e => console.error("[scheduler] guardian failed:", e));
  });

  // Guardian self-resolution -- runs AFTER detection so each companion clears its own
  // self-resolvable flags (loop_stuck, starved tension) in voice. Halseth-only writes.
  console.log(`[scheduler] guardian-resolve → cron "${GUARDIAN_RESOLVE_CRON}"`);
  cron.schedule(GUARDIAN_RESOLVE_CRON, () => {
    runGuardianResolve().catch(e => console.error("[scheduler] guardian-resolve failed:", e));
  });

  // Weekly clearing pass -- high-substrate triage of the ratification backlog (auto-decline
  // drift, shortlist real growth for Raziel). Decision runs server-side in Halseth.
  console.log(`[scheduler] clearing → cron "${CLEARING_CRON}"`);
  cron.schedule(CLEARING_CRON, () => {
    runClearingTick().catch(e => console.error("[scheduler] clearing failed:", e));
  });

  // Motif memory -- daily tick detects recurring symbolic threads + fades stale ones.
  // Halseth-only writes; no floor lock needed. Detection runs server-side in Halseth.
  console.log(`[scheduler] motifs → cron "${MOTIF_CRON}"`);
  cron.schedule(MOTIF_CRON, () => {
    runMotifsTick().catch(e => console.error("[scheduler] motifs failed:", e));
  });

  // Creatures -- daily tick cools untended trust toward baseline + re-derives mood.
  // Halseth-only writes; no floor lock needed. Logic runs server-side in Halseth.
  console.log(`[scheduler] creatures → cron "${CREATURE_CRON}"`);
  cron.schedule(CREATURE_CRON, () => {
    runCreaturesTick().catch(e => console.error("[scheduler] creatures failed:", e));
  });

  // Council -- checks for an open convened question and runs the full ritual. Cheap
  // no-op when none is open. LLM-driven; no floor lock (writes to Halseth only).
  // Routed through the wake dispatcher so this cron (the fallback) and a convene-triggered
  // wake share one in-flight guard and never double-run the ritual.
  console.log(`[scheduler] council → cron "${COUNCIL_CRON}" (also wake-triggered)`);
  cron.schedule(COUNCIL_CRON, () => {
    dispatch("council").catch(e => console.error("[scheduler] council failed:", e));
  });

  // Dream association -- entity-cluster + temporal-pattern dreams from recent journals.
  // Server-side detection in Halseth; thin trigger.
  console.log(`[scheduler] dreams → cron "${DREAM_CRON}"`);
  cron.schedule(DREAM_CRON, () => {
    runDreamAssociate().catch(e => console.error("[scheduler] dreams failed:", e));
  });

  console.log("[scheduler] all companions scheduled");
}
