import cron from "node-cron";
import type { Redis } from "@nullsafe/shared";
import { createRedisClient, publishRunComplete, publishExplorationPulse, setPresence } from "@nullsafe/shared";
import { isConversationActive } from "./idle-check.js";
import { claimFloor, releaseFloor } from "@nullsafe/shared";
import { runPipeline } from "./pipeline.js";
import { runCompress } from "./phases/compress.js";
import { runSeedGeneration } from "./phases/seed-gen.js";
import { COMPANIONS, CRON_SCHEDULES, REDIS_URL, FLOOR_LOCK_DURATION_MS } from "./config.js";
import type { CompanionId } from "./types.js";

/** Guards against overlapping runs for the same companion. */
const running = new Set<CompanionId>();

async function fireRun(companionId: CompanionId, redis: Redis | null): Promise<void> {
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

  console.log("[scheduler] all companions scheduled");
}
