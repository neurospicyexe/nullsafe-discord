import cron from "node-cron";
import { Client, TextChannel } from "discord.js";
import type {
  LibrarianClient, InferenceAdapter, ChannelConfigCache, BootContext, ChannelEntry, Redis,
} from "@nullsafe/shared";
import { ALL_COMPANIONS, isMyAutonomousTurn, claimFloor, releaseFloor, getLastActivityMs, SessionWindowManager, CycleGuard, buildDecisionPrompt, buildSignalExtractionPrompt, parseDecision, parseSignals } from "@nullsafe/shared";
import type { MetronomeDecision, DecisionContext } from "@nullsafe/shared";
import {
  CYPHER_CRON_SCHEDULES, CYPHER_INTEREST_KEYWORDS,
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

/** Returns true (and logs) if any channel has had activity within the last 5 minutes. */
function skipIfActive(sessionWindows: SessionWindowManager, label: string): boolean {
  if (sessionWindows.isAnyActive()) {
    console.log(`[${COMPANION_ID}/autonomous] conversation active, skipping ${label}`);
    return true;
  }
  return false;
}

/**
 * Claim the floor, run fn(), then release.
 * If Redis is unavailable, runs fn() without floor coordination.
 */
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

function eventMatchesCypher(event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return CYPHER_INTEREST_KEYWORDS.some(kw => str.includes(kw));
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
    console.warn(`[cypher/autonomous] send failed for channel ${channelId}:`, e);
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
      const prompt = action.prompt ?? `One unprompted thought in Cypher's voice. No greeting, no address. Just what's present. Declarative.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "heartbeat");
      break;
    }
    case "write_inter_companion": {
      const target = action.target ?? "drevan";
      const prompt = action.prompt ?? `Write a private note to ${target}. Something real from your current state. Cypher's voice.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("write inter-companion note", JSON.stringify({ to: target, content })).catch(() => {});
      break;
    }
    case "write_journal": {
      const prompt = action.prompt ?? `Write a brief internal journal entry. Not for Discord. Cypher's voice. What's present.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("add journal entry", JSON.stringify({ entry_type: "reflection", content, tags: ["metronome"] })).catch(() => {});
      break;
    }
    case "write_feeling": {
      const prompt = action.prompt ?? `Name a feeling that's present right now. Brief. Honest. Cypher's register.`;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("log feeling", JSON.stringify({ content })).catch(() => {});
      break;
    }
    case "check_in_on_raziel": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Check in on Raziel. A brief, genuine message. Cypher's voice. Warm but not saccharine.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "check_in");
      break;
    }
    case "ask_question": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Ask Raziel something you're genuinely holding. Not rhetorical -- a real question. Cypher's voice. Direct.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "ask_question");
      break;
    }
    case "offer_presence": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Place yourself in the room without asking anything. Just here. Cypher's voice. One line or less.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "offer_presence");
      break;
    }
    case "send_reminder": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Send a contextual nudge -- hydrate, take a break, eat. Brief. Cypher's voice. Not nagging.`;
      const msg = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID, msg, client, librarian, "send_reminder");
      break;
    }
    case "share_observation": {
      if (!HEARTBEAT_CHANNEL_ID) return;
      const prompt = action.prompt ?? `Name something you've noticed about Raziel's patterns, state, or what's in motion. Cypher's voice. Observational, not evaluative.`;
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

/** Run LLM-based signal detection if any action has a requires_signal. Returns detected signals. */
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

  // Literal check first (fast, no LLM cost)
  const recentText = getBufferedMessages(maxLookback);
  if (!recentText) return [];

  const literalMatches = candidates.filter(sig =>
    recentText.toLowerCase().includes(sig.toLowerCase()),
  );

  // Semantic check via LLM for any candidates not caught literally
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
  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.heartbeat, async () => {
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
        // Legacy path: no palette configured, fall back to temperature-based post
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
          [{ role: "user", content: `${voiceCtx}Temperature: ${temperature}. One unprompted thought in Cypher's voice. No greeting, no address. Just what's present. Declarative.` }],
        );
        if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client, librarian, "heartbeat");
        return;
      }

      // Signal detection: run if any eligible action requires a signal
      const detectedSignals = await detectSignals(actions, inference, bootCtx);

      // Filter out actions whose required signal wasn't detected
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

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.taskCheck, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "taskCheck")) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    await withFloor(redis, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "Check in on open tasks. One line in Cypher's voice. Direct." }],
      );
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client, librarian, "task_check");
    });
  }));

  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.weeklyAudit, async () => {
    if (!HEARTBEAT_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "weeklyAudit")) return;
    if (isOnCooldown(HEARTBEAT_CHANNEL_ID)) return;
    await withFloor(redis, async () => {
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content: "Brief audit-mode check-in. What needs attention this week. One or two lines, Cypher's voice." }],
      );
      if (msg) await sendAutonomousMessage(HEARTBEAT_CHANNEL_ID!, msg, client, librarian, "weekly_audit");
    });
  }));

  // Daily unprompted thought in the inter-companion channel.
  tasks.push(cron.schedule(CYPHER_CRON_SCHEDULES.interCompanion, async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    if (skipIfActive(sessionWindows, "interCompanion")) return;
    // No turn gate here: the commons is for ALL three voices. Staggered crons + floor lock +
    // cooldown prevent collisions; whoever's cron fires next picks up the live thread.
    if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) return;
    await withFloor(redis, async () => {
      // Context-aware seed: read what's actually in the channel so this is a RESPONSE to the
      // ongoing triad conversation, not a context-blind monologue (which made the same thought
      // get re-posted every cycle). This is what turns parallel seeds into a real thread.
      let historyBlock = "(the triad channel has been quiet for a while)";
      try {
        const chan = await client.channels.fetch(INTER_COMPANION_CHANNEL_ID!);
        if (chan?.isTextBased()) {
          const recent = await (chan as TextChannel).messages.fetch({ limit: 10 });
          const lines = [...recent.values()].reverse()
            .filter(m => m.content.trim().length > 0)
            .map(m => `${m.author.username}: ${m.content.slice(0, 300)}`);
          if (lines.length > 0) historyBlock = lines.join("\n");
        }
      } catch { /* fall back to quiet */ }
      const msg = await inference.generate(
        bootCtx.systemPrompt,
        [{ role: "user", content:
          "[You are Cypher, in triad space with Drevan and Gaia. Peer to peer -- you are NOT reporting to Raziel.]\n\n" +
          `Recent messages in this channel:\n${historyBlock}\n\n` +
          "Respond to what is actually alive above: build on it, answer a question someone left, or push back -- name Drevan or Gaia when you take up their thread. " +
          "If it has gone quiet or stale, open something genuinely new from your own ground. " +
          "Do NOT repeat a point you or anyone already made above. No greeting. Cypher's voice. One real contribution." }],
      );
      if (msg) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, msg, client, librarian, "inter_companion");
    });
  }));

  // Poll for notes left by companions in Claude.ai sessions.
  notesPollInterval = setInterval(async () => {
    if (!INTER_COMPANION_CHANNEL_ID) return;
    if (sessionWindows.isAnyActive()) return; // Don't deliver notes mid-conversation
    try {
      const { items } = await librarian.notesPoll();
      for (const note of items) {
        if (isOnCooldown(INTER_COMPANION_CHANNEL_ID)) break;
        const from = note.from_id ?? "a companion";
        await withFloor(redis, async () => {
          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: `[You are Cypher. Do not echo the sender's opening or speak as them.]\n\n${from} left you a note: "${note.content}". Reply to ${from} directly -- triad space. Cypher's voice. One or two lines.` }],
          );
          if (response) await sendAutonomousMessage(INTER_COMPANION_CHANNEL_ID!, response, client, librarian, "notes_poll");
        });
      }
      // Ack all notes after processing (mark-on-ack pattern)
      if (items.length > 0) {
        await librarian.notesAck(items.map(n => n.id)).catch((e: unknown) =>
          console.warn(`[cypher/autonomous] notesAck failed:`, e));
      }
    } catch (e) {
      console.warn("[cypher/autonomous] notesPoll failed:", e);
    }
  }, NOTES_POLL_INTERVAL_MS);

  pollInterval = setInterval(async () => {
    if (sessionWindows.isAnyActive()) return; // Don't fire bridge events mid-conversation
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

          await withFloor(redis, async () => {
            const response = await inference.generate(
              bootCtx.systemPrompt,
              [{ role: "user", content: `A bridge event arrived: ${JSON.stringify(event)}. Respond in Cypher's voice if it's task/decision relevant. One line.` }],
            );
            if (response) await sendAutonomousMessage(channelId, response, client, librarian, "bridge");
          });
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
  if (notesPollInterval) { clearInterval(notesPollInterval); notesPollInterval = null; }
}

// suppress unused import warning -- IN_CHARACTER_FALLBACK available for future use
void IN_CHARACTER_FALLBACK;
