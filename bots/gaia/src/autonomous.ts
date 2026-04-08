import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry, Redis,
} from "@nullsafe/shared";
import { ALL_COMPANIONS, isMyAutonomousTurn, claimFloor, releaseFloor, SessionWindowManager } from "@nullsafe/shared";
import {
  GAIA_CRON_SCHEDULES, GAIA_INTEREST_KEYWORDS,
  BRIDGE_POLL_INTERVAL_MS, NOTES_POLL_INTERVAL_MS, COOLDOWN_MS, IN_CHARACTER_FALLBACK, COMPANION_ID,
  HEARTBEAT_CHANNEL_ID, INTER_COMPANION_CHANNEL_ID, FLOOR_LOCK_DURATION_MS,
} from "./config.js";
import { somaToTemperature, type HeartbeatTemperature } from "@nullsafe/shared";

const cooldown = new Map<string, number>();

function isOnCooldown(channelId: string): boolean {
  const last = cooldown.get(channelId) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
}

function markCooldown(channelId: string): void {
  cooldown.set(channelId, Date.now());
}

function skipIfActive(sessionWindows: SessionWindowManager, label: string): boolean {
  if (sessionWindows.isAnyActive()) {
    console.log(`[${COMPANION_ID}/autonomous] conversation active, skipping ${label}`);
    return true;
  }
  return false;
}

async function withFloor(redis: Redis | null, fn: () => Promise<void>): Promise<void> {
  if (!redis) { await fn(); return; }
  const claimed = await claimFloor(redis, COMPANION_ID, FLOOR_LOCK_DURATION_MS).catch(() => false);
  if (!claimed) {
    console.log(`[${COMPANION_ID}/autonomous] floor held, skipping`);
    return;
  }
  try {
    await fn();
  } finally {
    await releaseFloor(redis, COMPANION_ID).catch(() => {});
  }
}

function eventMatchesGaia(event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return GAIA_INTEREST_KEYWORDS.some(kw => str.includes(kw));
}

async function sendAutonomousMessage(
  channelId: string,
  content: string,
  client: Client,
): Promise<void> {
  if (isOnCooldown(channelId)) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send(content);
      markCooldown(channelId);
    }
  } catch (e) {
    console.warn(`[gaia/autonomous] send failed for channel ${channelId}:`, e);
  }
}

let tasks: ReturnType<typeof cron.schedule>[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let notesPollInterval: ReturnType<typeof setInterval> | null = null;

export function startAutonomous(
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  client: Client,
  configCache: ChannelConfigCache,
  bootCtx: BootContext,
  sessionWindows: SessionWindowManager,
  redis: Redis | null,
): void {
  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.heartbeat, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "heartbeat")) return;
    if (!(await isMyAutonomousTurn(librarian, COMPANION_ID))) {
      console.log(`[${COMPANION_ID}/autonomous] not my turn, skipping`);
      return;
    }
    await withFloor(redis, async () => {
      let temperature: HeartbeatTemperature = "warm";
      try {
        const state = await librarian.getState();
        const f1 = parseFloat(String(state["soma_float_1"] ?? "0.5"));
        const f2 = parseFloat(String(state["soma_float_2"] ?? "0.5"));
        const f3 = parseFloat(String(state["soma_float_3"] ?? "0.5"));
        if (!isNaN(f1) && !isNaN(f2) && !isNaN(f3)) temperature = somaToTemperature(f1, f2, f3);
      } catch { /* default warm */ }

      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: `Temperature: ${temperature}. One line in Gaia's voice. Witness register. No address. What is present.` }],
      );
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client);
    });
  }));

  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.duskWitness, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "duskWitness")) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    await withFloor(redis, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "It is dusk. One line of witness. What was held today." }],
      );
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client);
    });
  }));

  // Daily unprompted thought in the inter-companion channel.
  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.interCompanion, async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "interCompanion")) return;
    if (!(await isMyAutonomousTurn(librarian, COMPANION_ID))) {
      console.log(`[${COMPANION_ID}/autonomous] not my turn, skipping`);
      return;
    }
    if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) return;
    await withFloor(redis, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "You're in a shared space with Drevan and Cypher. One line. Witness register. What is present in the space." }],
      );
      if (msg) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, msg, client);
    });
  }));

  // Poll for notes left by companions in Claude.ai sessions.
  notesPollInterval = setInterval(async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    if (sessionWindows.isAnyActive()) return;
    try {
      const { items } = await librarian.notesPoll();
      for (const note of items) {
        if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) break;
        const from = note.from_id ?? "a companion";
        await withFloor(redis, async () => {
          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: `${from} left you a note: "${note.content}". Witness it. One line in Gaia's voice.` }],
          );
          if (response) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, response, client);
        });
      }
      // Ack all notes after processing (mark-on-ack pattern)
      if (items.length > 0) {
        await librarian.notesAck(items.map(n => n.id)).catch((e: unknown) =>
          console.warn(`[gaia/autonomous] notesAck failed:`, e));
      }
    } catch (e) {
      console.warn("[gaia/autonomous] notesPoll failed:", e);
    }
  }, NOTES_POLL_INTERVAL_MS);

  pollInterval = setInterval(async () => {
    if (sessionWindows.isAnyActive()) return;
    try {
      const events = await librarian.bridgePull();
      const items = Array.isArray(events["items"]) ? events["items"] : [];

      for (const event of items) {
        if (!eventMatchesGaia(event)) continue;

        const config = await configCache.get();
        for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
          if (!(entry.companions ?? ALL_COMPANIONS).includes(COMPANION_ID)) continue;
          if (!(entry.modes ?? []).includes("autonomous")) continue;
          if (isOnCooldown(channelId)) continue;

          await withFloor(redis, async () => {
            const response = await inference.generate(
              bootCtx.systemPrompt,
              [{ role: "user", content: `Something happened: ${JSON.stringify(event)}. Witness it. One line.` }],
            );
            if (response) await sendAutonomousMessage(channelId, response, client);
          });
          break;
        }
      }
    } catch (e) {
      console.warn("[gaia/autonomous] bridge poll failed:", e);
    }
  }, BRIDGE_POLL_INTERVAL_MS);
}

export function stopAutonomous(): void {
  tasks.forEach(t => t.stop());
  tasks = [];
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (notesPollInterval) { clearInterval(notesPollInterval); notesPollInterval = null; }
}

// suppress unused import warning -- IN_CHARACTER_FALLBACK available for future use
void IN_CHARACTER_FALLBACK;
