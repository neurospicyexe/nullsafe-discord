// Shared autonomous/metronome runtime for the companion bots (cypher/drevan/gaia).
//
// The helper functions (cooldown, floor wrapper, send, executeMetronomeAction, signal
// detection) and the four runner BODIES (heartbeat, inter-companion seed, notes poll,
// bridge poll) were triplicated near-verbatim across bots/*/src/autonomous.ts. They are
// lifted here, parameterized by an `AutonomousContext` the bot assembles once in its
// `startAutonomous`. Every body is byte-identical to the pre-lift original modulo the
// local -> `ctx.` rename and helper calls taking `ctx`.
//
// What stays per-bot (intentional identity, NOT lifted):
//   - cron SCHEDULES (timing) and the setInterval scheduling wiring;
//   - the voice prompt registry (`AUTONOMOUS_PROMPTS` in each config.ts), passed in as
//     `ctx.prompts`;
//   - the default inter-companion note target (`ctx.defaultInterTarget`);
//   - the interest keywords (`ctx.interestKeywords`);
//   - Cypher-only scheduled actions (taskCheck, weeklyAudit) -- those keep their own
//     callbacks inline in cypher/src/autonomous.ts and call the exported helpers here.

import { Client, TextChannel } from "discord.js";
import {
  ALL_COMPANIONS, isMyAutonomousTurn, claimFloor, releaseFloor, getLastActivityMs,
  SessionWindowManager, CycleGuard, buildDecisionPrompt, buildSignalExtractionPrompt,
  parseDecision, parseSignals, onWriteError, somaToTemperature, sendLong,
  type HeartbeatTemperature, type MetronomeDecision, type DecisionContext,
  type LibrarianClient, type InferenceAdapter, type ChannelConfigCache,
  type BootContext, type ChannelEntry, type Redis, type CompanionId,
} from "./index.js";
import { generateOutward } from "./outward.js";

/** Per-bot autonomous voice prompts. Shape shared; values stay per-companion (config.ts). */
export interface AutonomousPrompts {
  postHeartbeat: string;
  writeInterCompanion: (target: string) => string;
  writeJournal: string;
  writeFeeling: string;
  checkInOnRaziel: string;
  askQuestion: string;
  offerPresence: string;
  sendReminder: string;
  shareObservation: string;
  namePattern: string;
  writeNoteToRaziel: string;
  interCompanionSeed: (historyBlock: string) => string;
  notesReply: (from: string, noteContent: string) => string;
  bridgeReply: (event: unknown) => string;
}

/**
 * Everything the shared autonomous runners need. The bot assembles this once in its
 * `startAutonomous` from config constants + boot-time runtime + per-process mutable state.
 * The three mutable fields (`cooldown`, `messageBuffer`, `cycleGuard`) are the SAME
 * instances the bot holds at module scope, so `pushRazielMessage`/`resetCycleGuard`
 * (called from the message handler) and the runners share state.
 */
export interface AutonomousContext {
  companionId: CompanionId;
  cooldownMs: number;
  floorLockMs: number;
  heartbeatChannelId: string | undefined;
  interCompanionChannelId: string | undefined;
  interestKeywords: readonly string[];
  defaultInterTarget: string;
  prompts: AutonomousPrompts;
  // runtime (snapshot taken at startAutonomous, matching prior behavior)
  librarian: LibrarianClient;
  inference: InferenceAdapter;
  client: Client;
  configCache: ChannelConfigCache;
  bootCtx: BootContext;
  sessionWindows: SessionWindowManager;
  redis: Redis | null;
  // per-process mutable state (shared by-reference with the bot module)
  cooldown: Map<string, number>;
  messageBuffer: Array<{ content: string; ts: number }>;
  cycleGuard: CycleGuard;
}

export function isOnCooldown(ctx: AutonomousContext, channelId: string): boolean {
  const last = ctx.cooldown.get(channelId) ?? 0;
  return Date.now() - last < ctx.cooldownMs;
}

export function markCooldown(ctx: AutonomousContext, channelId: string): void {
  ctx.cooldown.set(channelId, Date.now());
}

/** Returns true (and logs) if any channel has had activity within the active window. */
export function skipIfActive(ctx: AutonomousContext, label: string): boolean {
  if (ctx.sessionWindows.isAnyActive()) {
    console.log(`[${ctx.companionId}/autonomous] conversation active, skipping ${label}`);
    return true;
  }
  return false;
}

/**
 * Claim the floor, run fn(), then release.
 * If Redis is unavailable, runs fn() without floor coordination.
 */
export async function withFloor(ctx: AutonomousContext, fn: () => Promise<void>): Promise<void> {
  const { redis } = ctx;
  if (!redis) { await fn(); return; }
  const claimed = await claimFloor(redis, ctx.companionId, ctx.floorLockMs).catch(() => false);
  if (!claimed) {
    console.log(`[${ctx.companionId}/autonomous] floor held, skipping`);
    return;
  }
  try {
    await fn();
  } finally {
    await releaseFloor(redis, ctx.companionId).catch(() => {});
  }
}

export function eventMatches(ctx: AutonomousContext, event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return ctx.interestKeywords.some(kw => str.includes(kw));
}

export async function sendAutonomousMessage(
  ctx: AutonomousContext,
  channelId: string,
  content: string,
  trigger: string,
): Promise<void> {
  if (isOnCooldown(ctx, channelId)) return;
  try {
    const channel = await ctx.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      await sendLong(channel as TextChannel, content);
      markCooldown(ctx, channelId);
      ctx.librarian.ask(
        "continuity note",
        JSON.stringify({ content: `[metronome/${trigger}] ${content}`, salience: "high" }),
      ).catch(() => {});
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/autonomous] send failed for channel ${channelId}:`, e);
  }
}

export async function executeMetronomeAction(
  ctx: AutonomousContext,
  decision: MetronomeDecision,
): Promise<void> {
  const { librarian, inference, bootCtx, prompts, companionId, heartbeatChannelId } = ctx;
  const { action, reason } = decision;
  switch (action.action_type) {
    case "post_heartbeat": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.postHeartbeat;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "heartbeat");
      break;
    }
    case "write_inter_companion": {
      const target = action.target ?? ctx.defaultInterTarget;
      const prompt = action.prompt ?? prompts.writeInterCompanion(target);
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("write inter-companion note", JSON.stringify({ to: target, content })).catch(onWriteError(companionId, "inter-companion note"));
      break;
    }
    case "write_journal": {
      const prompt = action.prompt ?? prompts.writeJournal;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("add journal entry", JSON.stringify({ entry_type: "reflection", content, tags: ["metronome"] })).catch(onWriteError(companionId, "journal entry"));
      break;
    }
    case "write_feeling": {
      const prompt = action.prompt ?? prompts.writeFeeling;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("log feeling", JSON.stringify({ content })).catch(onWriteError(companionId, "feeling"));
      break;
    }
    case "check_in_on_raziel": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.checkInOnRaziel;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "check_in");
      break;
    }
    case "ask_question": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.askQuestion;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "ask_question");
      break;
    }
    case "offer_presence": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.offerPresence;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "offer_presence");
      break;
    }
    case "send_reminder": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.sendReminder;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "send_reminder");
      break;
    }
    case "share_observation": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.shareObservation;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "share_observation");
      break;
    }
    case "name_pattern": {
      // Phase 4b: reflect back something recurring seen over time. Discord-visible.
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.namePattern;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "name_pattern");
      break;
    }
    case "share_media": {
      // Phase 2 club layer: share a song/find/piece in the channel with one line on
      // why -- companions initiating shared experience, not just reacting to it.
      if (!heartbeatChannelId) return;
      const prompt = action.prompt
        ?? "Share one piece of media (a song, article, video, or find) worth the channel's time -- include a link if you have one and one line on why it's worth their time. Your taste, not duty.";
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "share_media");
      break;
    }
    case "write_note_to_raziel": {
      // Phase 4b: private note to Raziel -- Halseth only, never Discord. Lands in the
      // companion journal tagged letter_to_raziel; surfaces in Hearth /journal.
      const prompt = action.prompt ?? prompts.writeNoteToRaziel;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      if (content) librarian.ask("add journal entry", JSON.stringify({ entry_type: "reflection", content, tags: ["metronome", "letter_to_raziel"] })).catch(onWriteError(companionId, "note to raziel"));
      break;
    }
    case "nothing":
      console.log(`[${companionId}/heartbeat] chose nothing: ${reason}`);
      break;
    default:
      console.warn(`[${companionId}/heartbeat] unknown action_type: ${action.action_type}`);
  }
}

// Ring buffer for recent Raziel messages used in signal detection.
const MESSAGE_BUFFER_MAX = 20;

export function pushBuffered(messageBuffer: Array<{ content: string; ts: number }>, content: string): void {
  messageBuffer.push({ content, ts: Date.now() });
  if (messageBuffer.length > MESSAGE_BUFFER_MAX) messageBuffer.shift();
}

function getBufferedMessages(ctx: AutonomousContext, lookbackHours: number): string {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  return ctx.messageBuffer
    .filter(m => m.ts >= cutoff)
    .map(m => m.content)
    .join("\n");
}

/** Run LLM-based signal detection if any action has a requires_signal. Returns detected signals. */
export async function detectSignals(
  ctx: AutonomousContext,
  actions: Array<{ requires_signal: string | null; signal_lookback_hours: number | null }>,
): Promise<string[]> {
  const { inference, bootCtx } = ctx;
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
  const recentText = getBufferedMessages(ctx, maxLookback);
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

/** Heartbeat cron body: palette-driven metronome decision, with a temperature-based legacy fallback. */
export async function runHeartbeat(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, bootCtx, redis, cycleGuard, prompts, companionId, heartbeatChannelId } = ctx;
  if (!heartbeatChannelId) return;
  if (skipIfActive(ctx, "heartbeat")) return;
  if (redis) {
    const lastActivityTs = await getLastActivityMs(redis).catch(() => null);
    if (lastActivityTs !== null && Date.now() - lastActivityTs < 15 * 60 * 1000) {
      console.log(`[${companionId}/autonomous] recent activity, skipping heartbeat`);
      return;
    }
  }
  if (!(await isMyAutonomousTurn(librarian, companionId))) {
    console.log(`[${companionId}/autonomous] not my turn, skipping`);
    return;
  }
  await withFloor(ctx, async () => {
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
        console.warn(`[${companionId}/cycle-guard] loop detected`);
        librarian.ask("journal note: [loop_guard_tripped] consecutive same-register heartbeat cycles").catch(onWriteError(companionId, "loop-guard note"));
        return;
      }
      if (cycleResult === "skip") return;
      const recentNotes = await librarian.getRecentNotes({ sinceHours: 8, limit: 6 }).catch(() => []);
      // Tone/continuity only -- subject matter must NOT be sourced from the triad's own
      // recent output (that loop is what produced the sealed-basin echo register).
      const voiceCtx = recentNotes.length > 0
        ? `Recent triad speech (last 8h) -- for tone continuity only, do not take subject matter from it:\n${recentNotes.map(n => `[${n.agent_id}] ${n.content.slice(0, 200)}`).join("\n")}\n\n`
        : "";
      const msg = await generateOutward(
        inference, bootCtx.systemPrompt,
        `${voiceCtx}Temperature: ${temperature}. ${prompts.postHeartbeat}`,
        companionId, "heartbeat",
      );
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId!, msg, "heartbeat");
      return;
    }

    // Signal detection: run if any eligible action requires a signal
    const detectedSignals = await detectSignals(ctx, actions);

    // Filter out actions whose required signal wasn't detected
    const signalFiltered = actions.filter(a => {
      if (!a.requires_signal) return true;
      return detectedSignals.some(s => s.toLowerCase() === a.requires_signal!.toLowerCase());
    });

    if (signalFiltered.length === 0) {
      console.log(`[${companionId}/heartbeat] all eligible actions require undetected signals, skipping`);
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

    const decisionPrompt = buildDecisionPrompt(companionId, signalFiltered, state, recentNotes, silenceHours, decisionCtx);
    const rawDecision = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: decisionPrompt }]);
    const decision = rawDecision ? parseDecision(rawDecision, signalFiltered) : null;

    if (!decision) {
      console.warn(`[${companionId}/heartbeat] decision parse failed, raw: ${String(rawDecision).slice(0, 100)}`);
      return;
    }
    console.log(`[${companionId}/heartbeat] chose: ${decision.action.name} (${decision.action.action_type}) -- ${decision.reason}`);

    const runId = await librarian.writeAutonomyRun("continuation").catch(() => null);
    try {
      await executeMetronomeAction(ctx, decision);
      if (decision.action.action_type !== "nothing") {
        await librarian.recordMetronomeActionFired(decision.action.id).catch(onWriteError(companionId, "metronome action fired"));
      }
    } finally {
      if (runId) await librarian.patchAutonomyRun(runId, "completed").catch(onWriteError(companionId, "autonomy run completion"));
    }
  });
}

/** Inter-companion commons cron body: context-aware seed that responds to the live triad thread. */
export async function runInterCompanion(ctx: AutonomousContext): Promise<void> {
  const { inference, client, bootCtx, prompts, interCompanionChannelId } = ctx;
  if (!interCompanionChannelId) return;
  if (skipIfActive(ctx, "interCompanion")) return;
  // No turn gate here: the commons is for ALL three voices. Staggered crons + floor lock +
  // cooldown prevent collisions; whoever's cron fires next picks up the live thread.
  if (isOnCooldown(ctx, interCompanionChannelId)) return;
  await withFloor(ctx, async () => {
    // Context-aware seed: read what's actually in the channel so this is a RESPONSE to the
    // ongoing triad conversation, not a context-blind monologue (which made the same thought
    // get re-posted every cycle). This is what turns parallel seeds into a real thread.
    let historyBlock = "(the triad channel has been quiet for a while)";
    try {
      const chan = await client.channels.fetch(interCompanionChannelId!);
      if (chan?.isTextBased()) {
        const recent = await (chan as TextChannel).messages.fetch({ limit: 10 });
        const lines = [...recent.values()].reverse()
          .filter(m => m.content.trim().length > 0)
          .map(m => `${m.author.username}: ${m.content.slice(0, 300)}`);
        if (lines.length > 0) historyBlock = lines.join("\n");
      }
    } catch { /* fall back to quiet */ }
    const msg = await generateOutward(
      inference, bootCtx.systemPrompt,
      prompts.interCompanionSeed(historyBlock),
      ctx.companionId, "inter_companion",
    );
    if (msg) await sendAutonomousMessage(ctx, interCompanionChannelId!, msg, "inter_companion");
  });
}

/** Poll for notes left by companions in Claude.ai sessions and reply in the commons. */
export async function runNotesPoll(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, bootCtx, sessionWindows, prompts, companionId, interCompanionChannelId } = ctx;
  if (!interCompanionChannelId) return;
  if (sessionWindows.isAnyActive()) return; // Don't deliver notes mid-conversation
  try {
    const { items } = await librarian.notesPoll();
    for (const note of items) {
      if (isOnCooldown(ctx, interCompanionChannelId)) break;
      const from = note.from_id ?? "a companion";
      await withFloor(ctx, async () => {
        const response = await inference.generate(
          bootCtx.systemPrompt,
          [{ role: "user", content: prompts.notesReply(from, note.content) }],
        );
        if (response) await sendAutonomousMessage(ctx, interCompanionChannelId!, response, "notes_poll");
      });
    }
    // Ack all notes after processing (mark-on-ack pattern)
    if (items.length > 0) {
      await librarian.notesAck(items.map(n => n.id)).catch((e: unknown) =>
        console.warn(`[${companionId}/autonomous] notesAck failed:`, e));
    }
  } catch (e) {
    console.warn(`[${companionId}/autonomous] notesPoll failed:`, e);
  }
}

/** Poll the bridge for events of interest and respond in an autonomous-enabled channel. */
export async function runBridgePoll(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, configCache, bootCtx, sessionWindows, prompts, companionId } = ctx;
  if (sessionWindows.isAnyActive()) return; // Don't fire bridge events mid-conversation
  try {
    const events = await librarian.bridgePull();
    const items = Array.isArray(events["items"]) ? events["items"] : [];

    for (const event of items) {
      if (!eventMatches(ctx, event)) continue;

      const config = await configCache.get();
      for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
        if (!(entry.companions ?? ALL_COMPANIONS).includes(companionId)) continue;
        if (!(entry.modes ?? []).includes("autonomous")) continue;
        if (isOnCooldown(ctx, channelId)) continue;

        await withFloor(ctx, async () => {
          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: prompts.bridgeReply(event) }],
          );
          if (response) await sendAutonomousMessage(ctx, channelId, response, "bridge");
        });
        break;
      }
    }
  } catch (e) {
    console.warn(`[${companionId}/autonomous] bridge poll failed:`, e);
  }
}
