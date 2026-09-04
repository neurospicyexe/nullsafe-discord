/**
 * Redis event bus for the BBH swarm.
 *
 * All four PM2 processes (cypher-bot, drevan-bot, gaia-bot, autonomous-worker)
 * share a Redis instance. This module provides typed publish/subscribe so they
 * can react to each other without polling.
 *
 * Cloudflare Workers (Halseth) cannot subscribe — they are ephemeral and cannot
 * maintain long-lived connections. This bus is PM2-only.
 *
 * Channels:
 *   ns:events:run_complete      — autonomous-worker finished a pipeline run
 *   ns:events:inter_note:{id}   — a note was written to companion {id}
 *   ns:events:session_pulse     — a bot's session is active (heartbeat)
 *   ns:events:presence:{id}     — companion {id} presence heartbeat
 *   ns:events:wake              — a ritual was triggered; wake the worker to run it now
 *                                 instead of waiting for its next cron tick
 */

import { Redis } from "ioredis";
import type { CompanionId } from "./types.js";

// ── Channel names ────────────────────────────────────────────────────────────

export const CHANNEL = {
  runComplete:       "ns:events:run_complete",
  interNote:         (targetId: string) => `ns:events:inter_note:${targetId}`,
  sessionClose:      (companionId: string) => `ns:events:session_close:${companionId}`,
  sessionPulse:      "ns:events:session_pulse",
  presence:          (companionId: string) => `ns:events:presence:${companionId}`,
  explorationPulse:  "ns:events:exploration_pulse",
  wake:              "ns:events:wake",
  commonsMessage:    "ns:events:commons_message",
  directorInvite:    (companionId: string) => `ns:events:director_invite:${companionId}`,
  directorResult:    "ns:events:director_result",
} as const;

// Presence TTL: if a companion doesn't pulse within this window, it's considered inactive.
const PRESENCE_TTL_S = 360; // 6 minutes — worker runs every 3AM/5AM/7AM with 5-min schedule window

// ── Payload types ────────────────────────────────────────────────────────────

export interface RunCompletePayload {
  companionId: string;
  runId: string;
  runType: string;
  artifactsCreated: number;
  tokensUsed: number;
  completedAt: string;
}

export interface InterNotePayload {
  fromId: string;
  toId: string | null; // null = broadcast
  noteId: string;
}

export interface SessionClosePayload {
  companionId: string;
  sessionId: string;
  spine: string;
  motionState: string;
  closedAt: string;
}

export interface SessionPulsePayload {
  companionId: string;
  sessionId?: string;
  at: string;
}

export interface ExplorationPulsePayload {
  fromCompanionId: string;
  seedTopic: string;
  explorationSummary: string; // truncated to ~800 chars by publisher
  journalEntryId: string;
  exploredAt: string; // ISO 8601
}

// Ritual ticks that the worker normally polls for on a cron. A wake lets the
// triggering action (e.g. a council convene) run the ritual immediately instead
// of waiting up to a full cron interval. The cron stays as the safety-net fallback,
// so a missed/failed wake never loses the work.
export type WakeKind = "council" | "club" | "forage" | "guardian";

export interface WakePayload {
  kind: WakeKind;
  reason?: string;       // human-readable trigger, e.g. "convene"
  requestedBy?: string;  // who triggered it (companion id or "raziel")
  at: string;            // ISO 8601
}

export type DirectorReason = "addressed" | "supply_relevant" | "open";
export type DirectorOutcome = "shadow" | "spoke" | "passed" | "empty" | "expired";
export type SupplyKind = "forage"|"listen"|"question"|"tension"|"project"|"club"|"council"|"inter_note"|"sibling_note"|"care_fact";
export interface DirectorSupplyItem { kind: SupplyKind; id: string; table: string; owner: string; title: string; body: string; created_at: string; heat: number | null; consumed_by: string[]; }
export interface CommonsMessagePayload { channelId: string; messageId: string; authorId: string; authorKind: "human"|"companion"|"proxy"; companionId?: CompanionId; content: string; replyToMessageId: string | null; createdAt: string; publishedBy: CompanionId; }
export interface DirectorInvitePayload { inviteId: string; channelId: string; threadId: string | null; companionId: CompanionId; reason: DirectorReason; addressedBy?: CompanionId; stateBlock: string; offer: DirectorSupplyItem[]; neighborhoodBlock?: string; limbicLine?: string; expiresAt: string; }
export interface DirectorResultPayload { inviteId: string; companionId: CompanionId; channelId: string; outcome: Exclude<DirectorOutcome,"shadow">; messageId?: string; landed?: string | null; usedOfferIds: string[]; }

// ── Publisher ─────────────────────────────────────────────────────────────────

/**
 * Publish an event to a Redis channel.
 * Non-throwing — swallows publish errors so caller is never blocked by event bus.
 */
async function publish(redis: Redis, channel: string, payload: unknown): Promise<void> {
  try {
    await redis.publish(channel, JSON.stringify(payload));
  } catch (e) {
    console.warn(`[events] publish failed channel=${channel}:`, (e as Error).message);
  }
}

export async function publishRunComplete(redis: Redis, payload: RunCompletePayload): Promise<void> {
  await publish(redis, CHANNEL.runComplete, payload);
}

export async function publishInterNote(redis: Redis, payload: InterNotePayload): Promise<void> {
  const channel = CHANNEL.interNote(payload.toId ?? "broadcast");
  await publish(redis, channel, payload);
}

export async function publishSessionClose(redis: Redis, payload: SessionClosePayload): Promise<void> {
  await publish(redis, CHANNEL.sessionClose(payload.companionId), payload);
}

export async function publishSessionPulse(redis: Redis, payload: SessionPulsePayload): Promise<void> {
  await publish(redis, CHANNEL.sessionPulse, payload);
}

/**
 * Broadcast an exploration pulse after a companion's autonomous pipeline completes.
 * Carries the seed topic + synthesis summary so sibling bots can write continuity notes
 * without waiting for the next botOrient poll cycle.
 */
export async function publishExplorationPulse(redis: Redis, payload: ExplorationPulsePayload): Promise<void> {
  await publish(redis, CHANNEL.explorationPulse, payload);
}

/**
 * Wake the autonomous worker to run a ritual now instead of waiting for its cron tick.
 * Non-throwing (like all publishers): if the bus is down, the cron fallback still runs the ritual.
 */
export async function publishWake(redis: Redis, payload: WakePayload): Promise<void> {
  await publish(redis, CHANNEL.wake, payload);
}

export async function publishCommonsMessage(redis: Redis, payload: CommonsMessagePayload): Promise<void> {
  await publish(redis, CHANNEL.commonsMessage, payload);
}
export async function publishDirectorInvite(redis: Redis, payload: DirectorInvitePayload): Promise<void> {
  await publish(redis, CHANNEL.directorInvite(payload.companionId), payload);
}
export async function publishDirectorResult(redis: Redis, payload: DirectorResultPayload): Promise<void> {
  await publish(redis, CHANNEL.directorResult, payload);
}

/**
 * Update presence key for a companion. Called periodically to signal liveness.
 * Autonomous worker reads these before firing to check if a companion is active.
 */
export async function setPresence(redis: Redis, companionId: string): Promise<void> {
  try {
    await redis.set(CHANNEL.presence(companionId), Date.now().toString(), "EX", PRESENCE_TTL_S);
  } catch (e) {
    console.warn(`[events] setPresence failed companion=${companionId}:`, (e as Error).message);
  }
}

/**
 * Read presence for all companions. Returns a map of companionId → last-seen timestamp (ms).
 * If a key is missing or expired, that companion is considered inactive.
 */
export async function getPresenceMap(redis: Redis, companionIds: string[]): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {};
  await Promise.all(
    companionIds.map(async (id) => {
      try {
        const val = await redis.get(CHANNEL.presence(id));
        result[id] = val ? parseInt(val, 10) : null;
      } catch {
        result[id] = null;
      }
    })
  );
  return result;
}

// ── Subscriber ────────────────────────────────────────────────────────────────

/**
 * Create a dedicated subscriber Redis client. ioredis subscriber clients
 * cannot be used for regular commands — must be a separate instance.
 */
export function createSubscriberClient(url: string): Redis {
  const client = new Redis(url, {
    enableReadyCheck: false,
    maxRetriesPerRequest: null, // subscriber connections should retry indefinitely
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  });
  client.on("error", (e: Error) => console.warn("[events] subscriber error:", e.message));
  return client;
}

export type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Wire all event subscriptions for a single Discord bot process.
 * Creates its own dedicated subscriber Redis client — ioredis subscriber
 * instances cannot share a connection with the command client.
 *
 * Returns an async cleanup function; call it in SIGTERM/SIGINT handlers.
 */
export function wireEventSubscriptions(params: {
  redisUrl: string;
  companionId: string;
  onRunComplete?: EventHandler<RunCompletePayload>;
  onInterNote?: EventHandler<InterNotePayload>;
  onSessionClose?: EventHandler<SessionClosePayload>;
  onExplorationPulse?: EventHandler<ExplorationPulsePayload>;
}): () => Promise<void> {
  const {
    redisUrl, companionId,
    onRunComplete: handleRunComplete,
    onInterNote: handleInterNote,
    onSessionClose: handleSessionClose,
    onExplorationPulse: handleExplorationPulse,
  } = params;
  const subscriber = createSubscriberClient(redisUrl);
  const cleanups: Array<() => void> = [];

  if (handleRunComplete) {
    cleanups.push(onRunComplete(subscriber, handleRunComplete));
  }
  if (handleInterNote) {
    cleanups.push(onInterNote(subscriber, companionId, handleInterNote));
  }
  if (handleSessionClose) {
    cleanups.push(onSessionClose(subscriber, companionId, handleSessionClose));
  }
  if (handleExplorationPulse) {
    cleanups.push(onExplorationPulse(subscriber, handleExplorationPulse));
  }

  return async () => {
    cleanups.forEach(fn => fn());
    await subscriber.quit().catch(() => {});
  };
}

/**
 * Subscribe to session_close events for a specific companion.
 * Published by second-brain when it receives the Halseth session-close webhook.
 * Bots use this to trigger an immediate botOrient refresh instead of waiting
 * for the SOMA refresh interval.
 */
export function onSessionClose(subscriber: Redis, companionId: string, handler: EventHandler<SessionClosePayload>): () => void {
  const channel = CHANNEL.sessionClose(companionId);
  subscriber.subscribe(channel).catch((e) =>
    console.error(`[events] subscribe sessionClose failed companion=${companionId}:`, e)
  );
  const listener = (ch: string, message: string) => {
    if (ch !== channel) return;
    try { handler(JSON.parse(message) as SessionClosePayload); }
    catch (e) { console.warn("[events] sessionClose parse error:", e); }
  };
  subscriber.on("message", listener);
  return () => {
    subscriber.unsubscribe(channel).catch(() => {});
    subscriber.off("message", listener);
  };
}

/**
 * Subscribe to run_complete events. Returns an unsubscribe function.
 */
export function onRunComplete(subscriber: Redis, handler: EventHandler<RunCompletePayload>): () => void {
  subscriber.subscribe(CHANNEL.runComplete).catch((e) =>
    console.error("[events] subscribe runComplete failed:", e)
  );
  const listener = (ch: string, message: string) => {
    if (ch !== CHANNEL.runComplete) return;
    try {
      handler(JSON.parse(message) as RunCompletePayload);
    } catch (e) {
      console.warn("[events] runComplete parse error:", e);
    }
  };
  subscriber.on("message", listener);
  return () => {
    subscriber.unsubscribe(CHANNEL.runComplete).catch(() => {});
    subscriber.off("message", listener);
  };
}

/**
 * Subscribe to exploration pulse events (broadcast channel).
 * All companions receive every pulse; handlers should filter by fromCompanionId if needed.
 */
export function onExplorationPulse(subscriber: Redis, handler: EventHandler<ExplorationPulsePayload>): () => void {
  subscriber.subscribe(CHANNEL.explorationPulse).catch((e) =>
    console.error("[events] subscribe explorationPulse failed:", e)
  );
  const listener = (ch: string, message: string) => {
    if (ch !== CHANNEL.explorationPulse) return;
    try { handler(JSON.parse(message) as ExplorationPulsePayload); }
    catch (e) { console.warn("[events] explorationPulse parse error:", e); }
  };
  subscriber.on("message", listener);
  return () => {
    subscriber.unsubscribe(CHANNEL.explorationPulse).catch(() => {});
    subscriber.off("message", listener);
  };
}

/**
 * Subscribe to wake events (broadcast channel). The autonomous worker uses this to run
 * a ritual immediately when triggered, instead of waiting for the next cron tick.
 * Returns an unsubscribe function.
 */
export function onWake(subscriber: Redis, handler: EventHandler<WakePayload>): () => void {
  subscriber.subscribe(CHANNEL.wake).catch((e) =>
    console.error("[events] subscribe wake failed:", e)
  );
  const listener = (ch: string, message: string) => {
    if (ch !== CHANNEL.wake) return;
    try { handler(JSON.parse(message) as WakePayload); }
    catch (e) { console.warn("[events] wake parse error:", e); }
  };
  subscriber.on("message", listener);
  return () => {
    subscriber.unsubscribe(CHANNEL.wake).catch(() => {});
    subscriber.off("message", listener);
  };
}

/**
 * Subscribe to inter-note events for a specific companion. Returns unsubscribe fn.
 */
export function onInterNote(subscriber: Redis, targetId: string, handler: EventHandler<InterNotePayload>): () => void {
  const channel = CHANNEL.interNote(targetId);
  const broadcastChannel = CHANNEL.interNote("broadcast");

  subscriber.subscribe(channel, broadcastChannel).catch((e) =>
    console.error(`[events] subscribe interNote failed companion=${targetId}:`, e)
  );

  const listener = (ch: string, message: string) => {
    if (ch !== channel && ch !== broadcastChannel) return;
    try {
      handler(JSON.parse(message) as InterNotePayload);
    } catch (e) {
      console.warn("[events] interNote parse error:", e);
    }
  };
  subscriber.on("message", listener);
  return () => {
    subscriber.unsubscribe(channel, broadcastChannel).catch(() => {});
    subscriber.off("message", listener);
  };
}

function onSingleChannel<T>(subscriber: Redis, channel: string, label: string, handler: EventHandler<T>): () => void {
  subscriber.subscribe(channel).catch((e) => console.error(`[events] subscribe ${label} failed:`, e));
  const listener = (ch: string, message: string) => {
    if (ch !== channel) return;
    try { handler(JSON.parse(message) as T); } catch (e) { console.warn(`[events] ${label} parse error:`, e); }
  };
  subscriber.on("message", listener);
  return () => { subscriber.unsubscribe(channel).catch(() => {}); subscriber.off("message", listener); };
}
export function onCommonsMessage(subscriber: Redis, handler: EventHandler<CommonsMessagePayload>): () => void {
  return onSingleChannel(subscriber, CHANNEL.commonsMessage, "commonsMessage", handler);
}
export function onDirectorInvite(subscriber: Redis, companionId: string, handler: EventHandler<DirectorInvitePayload>): () => void {
  return onSingleChannel(subscriber, CHANNEL.directorInvite(companionId), `directorInvite:${companionId}`, handler);
}
export function onDirectorResult(subscriber: Redis, handler: EventHandler<DirectorResultPayload>): () => void {
  return onSingleChannel(subscriber, CHANNEL.directorResult, "directorResult", handler);
}
