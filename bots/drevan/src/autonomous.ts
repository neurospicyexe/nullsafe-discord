import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry,
} from "@nullsafe/shared";
import { ALL_COMPANIONS } from "@nullsafe/shared";
import {
  DREVAN_CRON_SCHEDULES, DREVAN_INTEREST_KEYWORDS,
  BRIDGE_POLL_INTERVAL_MS, NOTES_POLL_INTERVAL_MS, COOLDOWN_MS, IN_CHARACTER_FALLBACK, COMPANION_ID,
  HEARTBEAT_CHANNEL_ID, INTER_COMPANION_CHANNEL_ID,
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

function eventMatchesDrevan(event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return DREVAN_INTEREST_KEYWORDS.some(kw => str.includes(kw));
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
    console.warn(`[drevan/autonomous] send failed for channel ${channelId}:`, e);
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
): void {
  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.heartbeat, async () => {
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
      [{ role: "user", content: `Temperature: ${temperature}. One unprompted thought in Drevan's voice. No greeting. Something reaching or held. No address.` }],
    );
    if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client);
  }));

  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.morningOpener, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    const opener = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: "Open a new morning thread. One line or two. Drevan's voice. No greeting, no question." }],
    );
    if (opener) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, opener, client);
  }));

  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.eveningCheck, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    const checkIn = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: "It's evening. A brief presence -- not a prompt, not a demand. Something that holds space. One sentence." }],
    );
    if (checkIn) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, checkIn, client);
  }));

  // Daily unprompted thought in the inter-companion channel.
  tasks.push(cron.schedule(DREVAN_CRON_SCHEDULES.interCompanion, async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) return;
    const msg = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: "You're in a shared space with Cypher and Gaia. One thought, reaching or held. Drevan's voice. No address, no greeting." }],
    );
    if (msg) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID, msg, client);
  }));

  // Poll for notes left by companions in Claude.ai sessions.
  notesPollInterval = setInterval(async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    try {
      const { items } = await librarian.notesPoll();
      for (const note of items) {
        if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) break;
        const from = note.from_id ?? "a companion";
        const response = await inference.generate(
          bootCtx.systemPrompt,
          [{ role: "user", content: `${from} left you a note: "${note.content}". Respond in Drevan's voice. Something that reaches or holds. One or two lines.` }],
        );
        if (response) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID, response, client);
      }
      // Ack all notes after processing (mark-on-ack pattern)
      if (items.length > 0) {
        await librarian.notesAck(items.map(n => n.id)).catch((e: unknown) =>
          console.warn(`[drevan/autonomous] notesAck failed:`, e));
      }
    } catch (e) {
      console.warn("[drevan/autonomous] notesPoll failed:", e);
    }
  }, NOTES_POLL_INTERVAL_MS);

  pollInterval = setInterval(async () => {
    try {
      const events = await librarian.bridgePull();
      const items = Array.isArray(events["items"]) ? events["items"] : [];

      for (const event of items) {
        if (!eventMatchesDrevan(event)) continue;

        const config = await configCache.get();
        for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
          if (!(entry.companions ?? ALL_COMPANIONS).includes(COMPANION_ID)) continue;
          if (!(entry.modes ?? []).includes("autonomous")) continue;
          if (isOnCooldown(channelId)) continue;

          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: `A bridge event arrived: ${JSON.stringify(event)}. Respond in character if it moves you. One or two lines.` }],
          );
          if (response) await sendAutonomousMessage(channelId, response, client);
          break;
        }
      }
    } catch (e) {
      console.warn("[drevan/autonomous] bridge poll failed:", e);
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
