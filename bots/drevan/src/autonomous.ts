import cron from "node-cron";
import { Client } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, Redis,
} from "@nullsafe/shared";
import {
  SessionWindowManager, CycleGuard,
  runHeartbeat, runInterCompanion, runNotesPoll, runBridgePoll,
  pushBuffered, type AutonomousContext,
} from "@nullsafe/shared";
import {
  DREVAN_CRON_SCHEDULES, DREVAN_INTEREST_KEYWORDS, AUTONOMOUS_PROMPTS,
  BRIDGE_POLL_INTERVAL_MS, NOTES_POLL_INTERVAL_MS, COOLDOWN_MS, COMPANION_ID,
  HEARTBEAT_CHANNEL_ID, INTER_COMPANION_CHANNEL_ID, FLOOR_LOCK_DURATION_MS,
  CONSOLIDATION_IDLE_MINUTES,
} from "./config.js";
import {
  getLastActivityMs, isIdle, isConsolidated, markConsolidated, consolidateSession,
} from "@nullsafe/shared";

// Per-process state shared by-reference with the shared autonomous runners (autonomous-core.ts).
// pushRazielMessage (called from the message handler) and the runner signal-detection read the
// SAME messageBuffer; resetCycleGuard and the heartbeat loop share the SAME cycleGuard.
const cooldown = new Map<string, number>();
const messageBuffer: Array<{ content: string; ts: number }> = [];
const cycleGuard = new CycleGuard();

let tasks: ReturnType<typeof cron.schedule>[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let notesPollInterval: ReturnType<typeof setInterval> | null = null;

export function pushRazielMessage(content: string): void {
  pushBuffered(messageBuffer, content);
}

export function resetCycleGuard(): void {
  cycleGuard.reset();
}

export function startAutonomous(
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  client: Client,
  configCache: ChannelConfigCache,
  bootCtx: BootContext,
  sessionWindows: SessionWindowManager,
  redis: Redis | null,
  registerSentId?: (id: string) => void,
): void {
  const ctx: AutonomousContext = {
    companionId: COMPANION_ID,
    cooldownMs: COOLDOWN_MS,
    floorLockMs: FLOOR_LOCK_DURATION_MS,
    heartbeatChannelId: HEARTBEAT_CHANNEL_ID,
    interCompanionChannelId: INTER_COMPANION_CHANNEL_ID,
    interestKeywords: DREVAN_INTEREST_KEYWORDS,
    defaultInterTarget: "cypher",
    prompts: AUTONOMOUS_PROMPTS,
    librarian, inference, client, configCache, bootCtx, sessionWindows, redis,
    cooldown, messageBuffer, cycleGuard, registerSentId,
  };

  // Scheduling stays per-bot (timing is identity); the bodies are shared.
  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.heartbeat, () => runHeartbeat(ctx)));
  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.interCompanion, () => runInterCompanion(ctx)));

  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.consolidation, async () => {
    if (!redis) return;
    try {
      const lastMs = await getLastActivityMs(redis).catch(() => null);
      if (!isIdle(lastMs, CONSOLIDATION_IDLE_MINUTES)) return;
      if (await isConsolidated(redis, COMPANION_ID)) return;
      const result = await consolidateSession({ companionId: COMPANION_ID, librarian, inference });
      if (result.written) {
        await markConsolidated(redis, COMPANION_ID, 7200);
        console.log("[consolidation] drevan: session handoff written to Halseth");
      } else {
        console.log(`[consolidation] drevan: skipped (${result.reason})`);
      }
    } catch (e) {
      console.error("[consolidation] drevan: cron error", e);
    }
  }));

  notesPollInterval = setInterval(() => runNotesPoll(ctx), NOTES_POLL_INTERVAL_MS);
  pollInterval = setInterval(() => runBridgePoll(ctx), BRIDGE_POLL_INTERVAL_MS);
}

export function stopAutonomous(): void {
  tasks.forEach(t => t.stop());
  tasks = [];
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (notesPollInterval) { clearInterval(notesPollInterval); notesPollInterval = null; }
}
