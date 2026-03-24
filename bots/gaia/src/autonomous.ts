import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry,
} from "@nullsafe/shared";
import { ALL_COMPANIONS } from "@nullsafe/shared";
import {
  GAIA_CRON_SCHEDULES, GAIA_INTEREST_KEYWORDS,
  BRIDGE_POLL_INTERVAL_MS, COOLDOWN_MS, IN_CHARACTER_FALLBACK, COMPANION_ID,
} from "./config.js";

const cooldown = new Map<string, number>();

function isOnCooldown(channelId: string): boolean {
  const last = cooldown.get(channelId) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
}

function markCooldown(channelId: string): void {
  cooldown.set(channelId, Date.now());
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

export function startAutonomous(
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  client: Client,
  configCache: ChannelConfigCache,
  bootCtx: BootContext,
): void {
  tasks.push(cron.schedule(GAIA_CRON_SCHEDULES.duskWitness, async () => {
    const config = await configCache.get();
    for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
      if (!(entry.companions ?? ALL_COMPANIONS).includes(COMPANION_ID)) continue;
      if (!(entry.modes ?? []).includes("autonomous")) continue;
      if (isOnCooldown(channelId)) continue;
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "It is dusk. One line of witness. What was held today." }],
      );
      if (msg) await sendAutonomousMessage(channelId, msg, client);
    }
  }));

  pollInterval = setInterval(async () => {
    try {
      const events = await librarian.bridgePull();
      const items = Array.isArray(events["items"]) ? events["items"] : [];

      for (const event of items) {
        if (!eventMatchesGaia(event)) continue;

        const config = await configCache.get();
        for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
          if (!(entry.companions ?? ALL_COMPANIONS).includes(COMPANION_ID)) continue;
          if (!(entry.modes ?? []).includes("autonomous") && !(entry.modes ?? []).includes("raziel_only")) continue;
          if (isOnCooldown(channelId)) continue;

          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: `Something happened: ${JSON.stringify(event)}. Witness it. One line.` }],
          );
          if (response) await sendAutonomousMessage(channelId, response, client);
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
}

// suppress unused import warning -- IN_CHARACTER_FALLBACK available for future use
void IN_CHARACTER_FALLBACK;
