import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry,
} from "@nullsafe/shared";
import { ALL_COMPANIONS } from "@nullsafe/shared";
import {
  CYPHER_CRON_SCHEDULES, CYPHER_INTEREST_KEYWORDS,
  BRIDGE_POLL_INTERVAL_MS, COOLDOWN_MS, IN_CHARACTER_FALLBACK, COMPANION_ID,
  HEARTBEAT_CHANNEL_ID,
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

function eventMatchesCypher(event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return CYPHER_INTEREST_KEYWORDS.some(kw => str.includes(kw));
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
    console.warn(`[cypher/autonomous] send failed for channel ${channelId}:`, e);
  }
}

let tasks: ReturnType<typeof cron.schedule>[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startAutonomous(
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  client: Client,
  configCache: ChannelConfigCache,
  bootCtx: BootContext,
): void {
  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.heartbeat, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
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
      [{ role: "user", content: `Temperature: ${temperature}. One unprompted thought in Cypher's voice. No greeting, no address. Just what's present. Declarative.` }],
    );
    if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client);
  }));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.taskCheck, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    const msg = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: "Check in on open tasks. One line in Cypher's voice. Direct." }],
    );
    if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client);
  }));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.weeklyAudit, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    const msg = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: "Brief audit-mode check-in. What needs attention this week. One or two lines, Cypher's voice." }],
    );
    if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client);
  }));

  pollInterval = setInterval(async () => {
    try {
      const events = await librarian.bridgePull();
      const items = Array.isArray(events["items"]) ? events["items"] : [];

      for (const event of items) {
        if (!eventMatchesCypher(event)) continue;

        const config = await configCache.get();
        for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
          if (!(entry.companions ?? ALL_COMPANIONS).includes(COMPANION_ID)) continue;
          if (!(entry.modes ?? []).includes("autonomous")) continue;
          if (isOnCooldown(channelId)) continue;

          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: `A bridge event arrived: ${JSON.stringify(event)}. Respond in Cypher's voice if it's task/decision relevant. One line.` }],
          );
          if (response) await sendAutonomousMessage(channelId, response, client);
          break;
        }
      }
    } catch (e) {
      console.warn("[cypher/autonomous] bridge poll failed:", e);
    }
  }, BRIDGE_POLL_INTERVAL_MS);
}

export function stopAutonomous(): void {
  tasks.forEach(t => t.stop());
  tasks = [];
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// suppress unused import warning -- IN_CHARACTER_FALLBACK available for future use
void IN_CHARACTER_FALLBACK;
