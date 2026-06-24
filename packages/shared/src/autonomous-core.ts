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
  ALL_COMPANIONS, claimFloor, releaseFloor, getLastActivityMs,
  SessionWindowManager, CycleGuard, buildDecisionPrompt, buildSignalExtractionPrompt,
  parseDecision, parseSignals, summarizeRazielState, filterReachOutWhenUnjustified, isMyHeartbeatWindow, onWriteError, somaToTemperature, sendLong,
  liveIngest, reportVoiceScore, type VoiceCompanionId,
  echoScore, echoThreshold, detectMotif, relativeTime,
  type HeartbeatTemperature, type MetronomeDecision, type DecisionContext,
  type LibrarianClient, type InferenceAdapter, type ChannelConfigCache,
  type BootContext, type ChannelEntry, type Redis, type CompanionId,
} from "./index.js";
import { generateOutward } from "./outward.js";
import { pickTendAction, tendLine } from "./creature-tend.js";
import { publishInterNote } from "./events.js";

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
      const sent = await sendLong(channel as TextChannel, content);
      markCooldown(ctx, channelId);
      ctx.librarian.ask(
        "continuity note",
        JSON.stringify({ content: `[metronome/${trigger}] ${content}`, salience: "high" }),
      ).catch(() => {});
      // Substrate parity (2026-06-12): autonomous posts were invisible to the SB
      // live index and voice telemetry -- only handler-path replies got indexed.
      // Same fire-and-forget contract as the message handler.
      if (sent.length > 0) {
        liveIngest({
          companion: ctx.companionId,
          author: ctx.companionId,
          content,
          channel_id: channelId,
          message_id: sent[0]!.id,
        });
        reportVoiceScore(ctx.companionId as VoiceCompanionId, content, channelId);
      }
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/autonomous] send failed for channel ${channelId}:`, e);
  }
}

/** Halseth-only journal writes (write_journal / write_note_to_raziel) go through the
 *  Librarian "add companion note" path. This has two SILENT failure modes that have bitten
 *  twice (2026-06-13 journal_add crash, 2026-06-14 the post-fix fire that left no row):
 *    1. empty generated content makes the old `if (content)` guard skip the write with no trace;
 *    2. the Librarian returns HTTP 200 with an { error }/{ witness } envelope when an executor
 *       rejects the payload -- it does NOT throw -- so a fire-and-forget `.catch` is blind.
 *  Await the write and inspect the envelope so the NEXT failure is loud, not invisible. */
export async function writeMetronomeJournal(
  librarian: AutonomousContext["librarian"],
  companionId: string,
  label: string,
  content: string | null,
  tags: string[],
): Promise<void> {
  if (!content || !content.trim()) {
    console.warn(`[${companionId}/heartbeat] ${label}: content generation returned empty -- write skipped`);
    return;
  }
  await librarianWriteChecked(
    librarian, companionId, label,
    "add companion note",
    JSON.stringify({ content, tags, source: "metronome" }),
  );
}

/**
 * Await a Librarian write and surface silent rejects. The Librarian returns HTTP 200 with an
 * { error }/{ witness } envelope when an executor rejects the payload -- it does NOT throw, so a
 * fire-and-forget `.catch` is blind to it (the 2026-06-13/06-14 silent-no-op class). A successful
 * write returns `{ ack: true, id }`; treat the absence of both as a loud failure. Never throws,
 * so callers can `await` it on a continuity-noncritical path without risking an unhandled rejection.
 */
export async function librarianWriteChecked(
  librarian: AutonomousContext["librarian"],
  companionId: string,
  label: string,
  request: string,
  context?: string,
): Promise<boolean> {
  try {
    const res = await librarian.ask(request, context);
    if (!res || (!("ack" in res) && !("id" in res))) {
      console.warn(`[${companionId}/heartbeat] ${label}: write returned no ack (silent reject) -- ${JSON.stringify(res).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    onWriteError(companionId, label)(e);
    return false;
  }
}

/**
 * Nudge the recipient companion to poll for a freshly written inter-companion note, so
 * bot/worker-written notes arrive immediately instead of on the sibling's next poll cycle.
 * Best-effort and id-less by design: the subscriber (onInterNote) reacts by re-polling
 * Halseth, which is the source of truth, so no exact note id is needed. The notesPoll cron
 * stays as the fallback for Cloudflare-written notes, which cannot publish to Redis.
 */
export async function nudgeInterNote(redis: Redis | null, fromId: string, toId: string): Promise<void> {
  if (!redis) return;
  await publishInterNote(redis, { fromId, toId, noteId: "" });
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
      if (content) {
        const ok = await librarianWriteChecked(librarian, companionId, "inter-companion note", "write inter-companion note", JSON.stringify({ to: target, content }));
        // Event fast-path: nudge the recipient to poll now instead of waiting for their
        // next notesPoll cron. Only on a confirmed write, and only if we know the target.
        if (ok && target) await nudgeInterNote(ctx.redis, companionId, target);
      }
      break;
    }
    case "write_journal": {
      const prompt = action.prompt ?? prompts.writeJournal;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      // companion_journal (its actual intent), NOT human_journal. "add journal entry"
      // routed to journal_add -> human_journal AND rejected the `content` field, so this
      // silently no-op'd every fire. "add companion note" -> companion_journal handles
      // {content, tags:[...]} correctly (2026-06-13 bug hunt).
      await writeMetronomeJournal(librarian, companionId, "journal entry", content, ["metronome"]);
      break;
    }
    case "write_feeling": {
      const prompt = action.prompt ?? prompts.writeFeeling;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      // feeling_log requires { emotion } (writes.ts execFeelingLog) -- sending { content }
      // silently no-op'd every fire (returns a witness, not a throw). The writeFeeling prompt
      // generates a feeling word/phrase, so it IS the emotion. (2026-06-16 sweep.)
      if (content) await librarianWriteChecked(librarian, companionId, "feeling", "log feeling", JSON.stringify({ emotion: content }));
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
      // companion_journal tagged letter_to_raziel (surfaces in Hearth /journal), same
      // pattern as the guardian weekly letter. Was routing to human_journal + rejected
      // on the `content` field -> silent no-op (2026-06-13 bug hunt).
      await writeMetronomeJournal(librarian, companionId, "note to raziel", content, ["metronome", "letter_to_raziel"]);
      break;
    }
    case "tend_creature": {
      if (!heartbeatChannelId) return;
      // Resolve the target creature (default Sol) and its id.
      const creatures = await ctx.librarian.creaturesList().catch(() => []) ?? [];
      const target = (action.target ?? "Sol").toLowerCase();
      const creature = creatures.find((c: { name: string }) => c.name.toLowerCase() === target) ?? creatures[0];
      if (!creature) break;
      const seed = Date.now();
      const tAction = pickTendAction(companionId, seed);
      const prompt = action.prompt ?? `Tend ${creature.name} the crow with a small act of care (${tAction}). One line, your voice.`;
      const msg = (await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type))
        || tendLine(companionId, tAction, creature.name);
      // Record the tending (builds trust) then show it in the channel.
      await ctx.librarian.interactCreature(creature.id, companionId, tAction).catch((e: unknown) => console.warn(`[${companionId}/tend_creature] interact failed for ${creature.id}:`, e));
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "tend_creature");
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
  // Stateless clock rotation instead of the frozen house_state.autonomous_turn pointer (which only
  // advanced via the Claude.ai ritual, so it stranded the heartbeat on one companion for days).
  if (!isMyHeartbeatWindow(companionId, ALL_COMPANIONS)) {
    console.log(`[${companionId}/autonomous] not my heartbeat window, skipping`);
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
        await librarianWriteChecked(librarian, companionId, "loop-guard note", "journal note: [loop_guard_tripped] consecutive same-register heartbeat cycles");
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

    // Take 9: a fired relational_need makes the reach-out state-driven, not just
    // cron-eligible. Read the drive (non-fatal) and bias the decision prompt toward
    // a genuine reach-out when the need has crossed threshold.
    const drives = await librarian.getDrives().catch(() => []);
    const relationalNeed = drives.find(d => d.drive_key === "relational_need");

    // Raziel's recent subjective ND-state (migration 0081) is the "recent data to justify a
    // reach-out": fresh low spoons/energy/mood shapes the modality; no fresh snapshot means
    // no justifying data, and buildDecisionPrompt leans the companion toward silence.
    const razielState = await librarian.getRazielState().catch(() => null);

    const decisionCtx: DecisionContext = {
      detectedSignals: detectedSignals.length > 0 ? detectedSignals : undefined,
      timeOfDayLabel,
      recentFiredActions: recentFiredActions.length > 0 ? recentFiredActions : undefined,
      relationalNeedFired: relationalNeed?.fired || undefined,
      relationalNeedLevel: relationalNeed?.fired ? relationalNeed.level : undefined,
      razielStateSummary: summarizeRazielState(razielState) ?? undefined,
    };

    // Reach-out justification gate: a direct interruption of Raziel needs recent data behind it --
    // a conversation signal, a fresh logged ND-state, or a risen relational-need drive. With none,
    // drop the direct reach-out actions so the only honest choices are commons / internal / nothing.
    const reachOutJustified =
      detectedSignals.length > 0 ||
      decisionCtx.razielStateSummary != null ||
      Boolean(decisionCtx.relationalNeedFired);
    const candidateActions = filterReachOutWhenUnjustified(signalFiltered, reachOutJustified);
    if (candidateActions.length === 0) {
      console.log(`[${companionId}/heartbeat] no reach-out justified and no commons/internal action eligible -- staying silent`);
      return;
    }

    const decisionPrompt = buildDecisionPrompt(companionId, candidateActions, state, recentNotes, silenceHours, decisionCtx);
    const rawDecision = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: decisionPrompt }]);
    const decision = rawDecision ? parseDecision(rawDecision, candidateActions) : null;

    if (!decision) {
      console.warn(`[${companionId}/heartbeat] decision parse failed, raw: ${String(rawDecision).slice(0, 100)}`);
      return;
    }
    console.log(`[${companionId}/heartbeat] chose: ${decision.action.name} (${decision.action.action_type}) -- ${decision.reason}`);

    const runId = await librarian.writeAutonomyRun("continuation").catch(() => null);
    // runHeartbeat is fired fire-and-forget from a cron callback; an uncaught throw here would
    // surface as an unhandled rejection (and, with the process-level handler, can exit the bot).
    // Catch it: mark the run failed and log loudly rather than leak it. (2026-06-16 sweep.)
    try {
      await executeMetronomeAction(ctx, decision);
      if (decision.action.action_type !== "nothing") {
        await librarian.recordMetronomeActionFired(decision.action.id).catch(onWriteError(companionId, "metronome action fired"));
      }
      if (runId) await librarian.patchAutonomyRun(runId, "completed").catch(onWriteError(companionId, "autonomy run completion"));
    } catch (e) {
      console.error(`[${companionId}/heartbeat] metronome action threw: ${e instanceof Error ? e.message : String(e)}`);
      if (runId) await librarian.patchAutonomyRun(runId, "failed").catch(onWriteError(companionId, "autonomy run failure"));
    }
  });
}

/** Inter-companion commons cron body: context-aware seed that responds to the live triad thread. */
export async function runInterCompanion(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, client, bootCtx, prompts, interCompanionChannelId } = ctx;
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
    let historyContents: string[] = [];
    try {
      const chan = await client.channels.fetch(interCompanionChannelId!);
      if (chan?.isTextBased()) {
        const recent = await (chan as TextChannel).messages.fetch({ limit: 10 });
        const ordered = [...recent.values()].reverse()
          .filter(m => m.content.trim().length > 0);
        historyContents = ordered.map(m => m.content.slice(0, 2000));
        const lines = ordered.map(m => `${m.author.username}: ${m.content.slice(0, 300)}`);
        if (lines.length > 0) historyBlock = lines.join("\n");
      }
    } catch { /* fall back to quiet */ }

    // Fresh material (2026-06-12): re-feeding the channel its own last 10 messages
    // every tick is what kept the elderberry loop alive for 12 hours. Hand the seed
    // something from OUTSIDE the thread -- forage finds, recent listens, held
    // questions -- so the commons metabolizes shared life, not its own echo.
    let freshBlock = "";
    try {
      const orient = await librarian.botOrient();
      const fresh: string[] = [];
      for (const f of (orient?.forage_finds ?? []).slice(0, 2)) {
        fresh.push(`forage find [${f.domain}]: ${f.title} -- ${f.summary.slice(0, 200)}`);
      }
      for (const l of (orient?.recent_listens ?? []).slice(0, 2)) {
        // Stamp the listen with how long ago it actually was -- without this the model
        // guesses the timeframe and gets it wrong ("yesterday" for a 2-days-ago track).
        fresh.push(`listen from ${relativeTime(l.created_at)}: "${l.title}"${l.artist ? ` by ${l.artist}` : ""}`);
      }
      for (const q of (orient?.open_questions ?? []).slice(0, 1)) {
        fresh.push(`a question you're holding: ${q}`);
      }
      if (fresh.length > 0) {
        freshBlock =
          `\n\n[Fresh material -- from your own life, OUTSIDE this thread:\n` +
          fresh.map(f => `- ${f}`).join("\n") +
          `\nPrefer bringing one of these (or anything else new) over extending the thread's existing imagery.]`;
      }
    } catch { /* orient unavailable -- seed proceeds without fresh material */ }

    // Motif exhaustion: when the thread keeps orbiting the same words, say so.
    const motif = detectMotif(historyContents);
    const motifBlock = motif.length > 0
      ? `\n\n[Motif check] The imagery around "${motif.join(", ")}" has run through most of the recent turns. It is spent -- do not extend it. Bring new material, or post nothing.`
      : "";

    const msg = await generateOutward(
      inference, bootCtx.systemPrompt,
      prompts.interCompanionSeed(historyBlock) + freshBlock + motifBlock,
      ctx.companionId, "inter_companion",
    );
    if (!msg) return;

    // Echo gate: if the seed still came out as a re-paint of the thread's own
    // vocabulary, silence beats another verse (same gate as the reply path).
    const echo = echoScore(msg, historyContents);
    if (echo >= echoThreshold()) {
      console.warn(`[${ctx.companionId}/autonomous] inter-companion seed echo-gated (score=${echo.toFixed(2)}) -- staying silent`);
      return;
    }
    await sendAutonomousMessage(ctx, interCompanionChannelId!, msg, "inter_companion");
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
