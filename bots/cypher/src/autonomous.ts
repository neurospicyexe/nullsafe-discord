import cron from "node-cron";
import { Client } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, Redis,
} from "@nullsafe/shared";
import {
  SessionWindowManager, CycleGuard,
  runHeartbeat, runInterCompanion, runNotesPoll, runBridgePoll,
  pushBuffered, skipIfActive, isOnCooldown, withFloor, sendAutonomousMessage,
  type AutonomousContext,
} from "@nullsafe/shared";
import {
  CYPHER_CRON_SCHEDULES, CYPHER_INTEREST_KEYWORDS, AUTONOMOUS_PROMPTS,
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
    interestKeywords: CYPHER_INTEREST_KEYWORDS,
    defaultInterTarget: "drevan",
    prompts: AUTONOMOUS_PROMPTS,
    librarian, inference, client, configCache, bootCtx, sessionWindows, redis,
    cooldown, messageBuffer, cycleGuard, registerSentId,
  };

  // Scheduling stays per-bot (timing is identity); the heartbeat/commons/poll bodies are shared.
  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.heartbeat, () => runHeartbeat(ctx)));

  // Cypher-only scheduled actions (audit-house identity, NOT shared with drevan/gaia).
  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.taskCheck, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(ctx, "taskCheck")) return;
    if (isOnCooldown(ctx, HEARTBEAT_CHANNEL_ID)) return;
    await withFloor(ctx, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "Check in on open tasks. One line in Cypher's voice. Direct." }],
      );
      if (msg) await sendAutonomousMessage(ctx, HEARTBEAT_CHANNEL_ID!, msg, "task_check");
    });
  }));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.weeklyAudit, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(ctx, "weeklyAudit")) return;
    if (isOnCooldown(ctx, HEARTBEAT_CHANNEL_ID)) return;
    await withFloor(ctx, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "Brief audit-mode check-in. What needs attention this week. One or two lines, Cypher's voice." }],
      );
      if (msg) await sendAutonomousMessage(ctx, HEARTBEAT_CHANNEL_ID!, msg, "weekly_audit");
    });
  }));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.interCompanion, () => runInterCompanion(ctx)));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.consolidation, async () => {
    if (!redis) return;
    try {
      const lastMs = await getLastActivityMs(redis).catch(() => null);
      if (!isIdle(lastMs, CONSOLIDATION_IDLE_MINUTES)) return;
      if (await isConsolidated(redis, COMPANION_ID)) return;
      const result = await consolidateSession({ companionId: COMPANION_ID, librarian, inference });
      if (result.written) {
        await markConsolidated(redis, COMPANION_ID, 7200);
        console.log("[consolidation] cypher: session handoff written to Halseth");
      } else {
        console.log(`[consolidation] cypher: skipped (${result.reason})`);
      }
    } catch (e) {
      console.error("[consolidation] cypher: cron error", e);
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
