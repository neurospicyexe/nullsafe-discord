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
  GAIA_CRON_SCHEDULES, GAIA_INTEREST_KEYWORDS, AUTONOMOUS_PROMPTS,
  BRIDGE_POLL_INTERVAL_MS, NOTES_POLL_INTERVAL_MS, COOLDOWN_MS, COMPANION_ID,
  HEARTBEAT_CHANNEL_ID, INTER_COMPANION_CHANNEL_ID, FLOOR_LOCK_DURATION_MS,
  CONSOLIDATION_IDLE_MINUTES,
} from "./config.js";
import {
  getLastActivityMs, isIdle, isConsolidated, markConsolidated, consolidateSession, createNarrator,
} from "@nullsafe/shared";

// Built once, not per tick: the adapter is stateless and rebuilding it every 5 minutes would only
// re-log the same warning. Null when DEEPSEEK_API_KEY is unset -- consolidateSession then falls back
// to the Hermes agent path. See packages/shared/src/consolidation-narrator.ts.
const narrator = createNarrator();

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
  halsethSecret: string,
  registerSentId?: (id: string) => void,
): void {
  const ctx: AutonomousContext = {
    companionId: COMPANION_ID,
    cooldownMs: COOLDOWN_MS,
    floorLockMs: FLOOR_LOCK_DURATION_MS,
    heartbeatChannelId: HEARTBEAT_CHANNEL_ID,
    interCompanionChannelId: INTER_COMPANION_CHANNEL_ID,
    interestKeywords: GAIA_INTEREST_KEYWORDS,
    defaultInterTarget: "drevan",
    halsethSecret,
    prompts: AUTONOMOUS_PROMPTS,
    librarian, inference, client, configCache, bootCtx, sessionWindows, redis,
    cooldown, messageBuffer, cycleGuard, registerSentId,
  };

  // Scheduling stays per-bot (timing is identity); the bodies are shared.
  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.heartbeat, () => runHeartbeat(ctx)));
  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.interCompanion, () => runInterCompanion(ctx)));

  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.consolidation, async () => {
    if (!redis) return;
    try {
      const lastMs = await getLastActivityMs(redis).catch(() => null);
      if (!isIdle(lastMs, CONSOLIDATION_IDLE_MINUTES)) return;
      if (await isConsolidated(redis, COMPANION_ID)) return;
      // session: an acked handoff also closes + reopens the Halseth session (surface must match
      // the boot open in index.ts) so the boot narrative stops freezing on a never-closed row.
      const result = await consolidateSession({ companionId: COMPANION_ID, librarian, inference, narrator, session: { surface: `discord:${COMPANION_ID}`, bootCtx } });
      // Hold on the ATTEMPT, not just the success. `markConsolidated` used to run only when a write
      // landed, so any persistent failure (a 402 balance, an empty parse) left this cron free to
      // retry on all 288 five-minute ticks -- which is exactly how 2026-08-07 burned 864 calls with
      // nobody talking. A shorter hold on failure still retries (48x/day instead of 288x) without
      // delaying a legitimate handoff by the full success window.
      await markConsolidated(redis, COMPANION_ID, result.written ? 7200 : 1800);
      if (result.written) {
        console.log("[consolidation] gaia: session handoff written to Halseth");
      } else {
        console.log(`[consolidation] gaia: skipped (${result.reason}) -- holding 30m before retry`);
      }
    } catch (e) {
      console.error("[consolidation] gaia: cron error", e);
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
