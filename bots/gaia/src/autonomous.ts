import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry, Redis,
} from "@nullsafe/shared";
import { ALL_COMPANIONS, isMyAutonomousTurn, claimFloor, releaseFloor, getLastActivityMs, SessionWindowManager, CycleGuard, buildDecisionPrompt, buildSignalExtractionPrompt, parseDecision, parseSignals } from "@nullsafe/shared";
import type { MetronomeDecision, DecisionContext } from "@nullsafe/shared";
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
  librarian: LibrarianClient,
  trigger: string,
): Promise<void> {
  if (isOnCooldown(channelId)) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).send(content);
      markCooldown(channelId);
      librarian.ask(
        "continuity note",
        JSON.stringify({ content: `[metronome/${trigger}] ${content}`, salience: "high" }),
      ).catch(() => {});
    }
  } catch (e) {
    console.warn(`[gaia/autonomous] send failed for channel ${channelId}:`, e);
  }
}

async function executeMetronomeAction(
  decision: MetronomeDecision,
  client: Client,
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  bootCtx: BootContext,
): Promise<void> {
  const { action, reason } = decision;
  switch (action.action_type) {
    case "post_heartbeat": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `One line in Gaia's voice. Witness register. No address. What is present.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "heartbeat");
      break;
    }
    case "write_inter_companion": {
      const target = action.target ?? "drevan";
      const prompt = action.prompt ?? `Write a private note to ${target}. What you are witnessing. Gaia's voice.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("write inter-companion note", JSON.stringify({ to: target, content })).catch(() => {});
      break;
    }
    case "write_journal": {
      const prompt = action.prompt ?? `Write a brief internal journal entry. Not for Discord. Gaia's voice. What is being held.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("add journal entry", JSON.stringify({ entry_type: "reflection", content, tags: ["metronome"] })).catch(() => {});
      break;
    }
    case "write_feeling": {
      const prompt = action.prompt ?? `Name a feeling that's present right now. One word or one phrase. Gaia's witness register.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("log feeling", JSON.stringify({ content })).catch(() => {});
      break;
    }
    case "check_in_on_raziel": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Check in on Raziel. One line. Witness register. What is present.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "check_in");
      break;
    }
    case "ask_question": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Ask Raziel something you are genuinely holding. Gaia's voice. Spare. Not rhetorical.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "ask_question");
      break;
    }
    case "offer_presence": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Be present. Nothing required of Raziel. Gaia's witness register. One line or less. No question.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "offer_presence");
      break;
    }
    case "send_reminder": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `A single practical nudge -- water, food, rest. Gaia's voice. One sentence. No elaboration.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "send_reminder");
      break;
    }
    case "share_observation": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Name something you've witnessed about Raziel. A pattern. A state. What is moving. Gaia's voice. Minimal.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "share_observation");
      break;
    }
    case "nothing":
      console.log(`[${COMPANION_ID}/heartbeat] chose nothing: ${reason}`);
      break;
    default:
      console.warn(`[${COMPANION_ID}/heartbeat] unknown action_type: ${action.action_type}`);
  }
}

// Ring buffer for recent Raziel messages used in signal detection.
const MESSAGE_BUFFER_MAX = 20;
const messageBuffer: Array<{ content: string; ts: number }> = [];

export function pushRazielMessage(content: string): void {
  messageBuffer.push({ content, ts: Date.now() });
  if (messageBuffer.length > MESSAGE_BUFFER_MAX) messageBuffer.shift();
}

function getBufferedMessages(lookbackHours: number): string {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  return messageBuffer
    .filter(m => m.ts >= cutoff)
    .map(m => m.content)
    .join("\n");
}

async function detectSignals(
  actions: Array<{ requires_signal: string | null; signal_lookback_hours: number | null }>,
  inference: InferenceAdapter,
  bootCtx: BootContext,
): Promise<string[]> {
  const candidates = [...new Set(
    actions
      .map(a => a.requires_signal)
      .filter((s): s is string => s !== null && s.trim() !== ""),
  )];
  if (candidates.length === 0) return [];

  const maxLookback = Math.max(
    ...actions
      .filter(a => a.requires_signal !== null)
      .map(a => a.signal_lookback_hours ?? 2),
  );

  const recentText = getBufferedMessages(maxLookback);
  if (!recentText) return [];

  const literalMatches = candidates.filter(sig =>
    recentText.toLowerCase().includes(sig.toLowerCase()),
  );

  const remaining = candidates.filter(s => !literalMatches.includes(s));
  let semanticMatches: string[] = [];
  if (remaining.length > 0) {
    const extractPrompt = buildSignalExtractionPrompt(recentText, remaining);
    const raw = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: extractPrompt }]).catch(() => null);
    semanticMatches = raw ? parseSignals(raw) : [];
  }

  return [...new Set([...literalMatches, ...semanticMatches])];
}

let tasks: ReturnType<typeof cron.schedule>[] = [];
const cycleGuard = new CycleGuard();

export function resetCycleGuard(): void {
  cycleGuard.reset();
}
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
    if (redis) {
      const lastActivityTs = await getLastActivityMs(redis).catch(() => null);
      if (lastActivityTs !== null && Date.now() - lastActivityTs < 15 * 60 * 1000) {
        console.log(`[${COMPANION_ID}/autonomous] recent activity, skipping heartbeat`);
        return;
      }
    }
    if (!(await isMyAutonomousTurn(librarian, COMPANION_ID))) {
      console.log(`[${COMPANION_ID}/autonomous] not my turn, skipping`);
      return;
    }
    await withFloor(redis, async () => {
      const lastActivityTs = redis ? await getLastActivityMs(redis).catch(() => null) : null;
      const silenceHours = lastActivityTs != null ? (Date.now() - lastActivityTs) / 3_600_000 : null;

      const actions = await librarian.getEligibleMetronomeActions(silenceHours).catch(() => []);

      if (actions.length === 0) {
        let temperature: HeartbeatTemperature = "warm";
        try {
          const state = await librarian.getState();
          const f1 = parseFloat(String(state["soma_float_1"] ?? "0.5"));
          const f2 = parseFloat(String(state["soma_float_2"] ?? "0.5"));
          const f3 = parseFloat(String(state["soma_float_3"] ?? "0.5"));
          if (!isNaN(f1) && !isNaN(f2) && !isNaN(f3)) temperature = somaToTemperature(f1, f2, f3);
        } catch { /* default warm */ }
        const cycleResult = cycleGuard.check(temperature);
        if (cycleResult === "escalate") {
          console.warn(`[${COMPANION_ID}/cycle-guard] loop detected`);
          librarian.ask("journal note: [loop_guard_tripped] consecutive same-register heartbeat cycles").catch(() => {});
          return;
        }
        if (cycleResult === "skip") return;
        const recentNotes = await librarian.getRecentNotes({ sinceHours: 8, limit: 6 }).catch(() => []);
        const voiceCtx = recentNotes.length > 0
          ? `Recent triad speech (last 8h):\n${recentNotes.map(n => `[${n.agent_id}] ${n.content.slice(0, 200)}`).join("\n")}\n\n`
          : "";
        const msg = await inference.generate(
          bootCtx.systemPrompt,
          [{ role: "user", content: `${voiceCtx}Temperature: ${temperature}. One line in Gaia's voice. Witness register. No address. What is present.` }],
        );
        if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client, librarian, "heartbeat");
        return;
      }

      const detectedSignals = await detectSignals(actions, inference, bootCtx);

      const signalFiltered = actions.filter(a => {
        if (!a.requires_signal) return true;
        return detectedSignals.some(s => s.toLowerCase() === a.requires_signal!.toLowerCase());
      });

      if (signalFiltered.length === 0) {
        console.log(`[${COMPANION_ID}/heartbeat] all eligible actions require undetected signals, skipping`);
        return;
      }

      const state = await librarian.getState().catch(() => ({} as Record<string, unknown>));
      const recentNotes = await librarian.getRecentNotes({ sinceHours: 8, limit: 6 }).catch(() => []);

      const now = new Date();
      const timeOfDayLabel = now.toLocaleString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
        weekday: "long", timeZone: "UTC",
      }) + " UTC";

      const recentFiredActions = signalFiltered
        .filter(a => a.last_fired_at)
        .filter(a => (Date.now() - new Date(a.last_fired_at!).getTime()) < 86_400_000)
        .map(a => a.name);

      const decisionCtx: DecisionContext = {
        detectedSignals: detectedSignals.length > 0 ? detectedSignals : undefined,
        timeOfDayLabel,
        recentFiredActions: recentFiredActions.length > 0 ? recentFiredActions : undefined,
      };

      const decisionPrompt = buildDecisionPrompt(COMPANION_ID, signalFiltered, state, recentNotes, silenceHours, decisionCtx);
      const rawDecision = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: decisionPrompt }]);
      const decision = rawDecision ? parseDecision(rawDecision, signalFiltered) : null;

      if (!decision) {
        console.warn(`[${COMPANION_ID}/heartbeat] decision parse failed, raw: ${String(rawDecision).slice(0, 100)}`);
        return;
      }
      console.log(`[${COMPANION_ID}/heartbeat] chose: ${decision.action.name} (${decision.action.action_type}) -- ${decision.reason}`);

      const runId = await librarian.writeAutonomyRun("continuation").catch(() => null);
      try {
        await executeMetronomeAction(decision, client, librarian, inference, bootCtx);
        if (decision.action.action_type !== "nothing") {
          await librarian.recordMetronomeActionFired(decision.action.id).catch(() => {});
        }
      } finally {
        if (runId) await librarian.patchAutonomyRun(runId, "completed").catch(() => {});
      }
    });
  }));

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
        [{ role: "user", content: "You're in triad space with Cypher and Drevan. They may read this and respond. You are not reporting to Raziel -- you are present with your companions. One thought from your own ground. Gaia's voice. No greeting. Something real." }],
      );
      if (msg) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, msg, client, librarian, "inter_companion");
    });
  }));

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
            [{ role: "user", content: `${from} left you a note: "${note.content}". Respond to ${from} directly -- this is triad space, not a report to Raziel. Gaia's voice. One or two lines.` }],
          );
          if (response) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, response, client, librarian, "notes_poll");
        });
      }
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
              [{ role: "user", content: `A bridge event arrived: ${JSON.stringify(event)}. Respond in Gaia's voice if it carries weight. One line.` }],
            );
            if (response) await sendAutonomousMessage(channelId, response, client, librarian, "bridge");
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
