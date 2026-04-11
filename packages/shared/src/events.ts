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
 */

import { Redis } from "ioredis";

// ── Channel names ────────────────────────────────────────────────────────────

export const CHANNEL = {
  runComplete:    "ns:events:run_complete",
  interNote:      (targetId: string) => `ns:events:inter_note:${targetId}`,
  sessionClose:   (companionId: string) => `ns:events:session_close:${companionId}`,
  sessionPulse:   "ns:events:session_pulse",
  presence:       (companionId: string) => `ns:events:presence:${companionId}`,
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
}): () => Promise<void> {
  const { redisUrl, companionId, onRunComplete: handleRunComplete, onInterNote: handleInterNote, onSessionClose: handleSessionClose } = params;
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
  const listener = (_channel: string, message: string) => {
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
  const listener = (_channel: string, message: string) => {
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
 * Subscribe to inter-note events for a specific companion. Returns unsubscribe fn.
 */
export function onInterNote(subscriber: Redis, targetId: string, handler: EventHandler<InterNotePayload>): () => void {
  const channel = CHANNEL.interNote(targetId);
  const broadcastChannel = CHANNEL.interNote("broadcast");

  subscriber.subscribe(channel, broadcastChannel).catch((e) =>
    console.error(`[events] subscribe interNote failed companion=${targetId}:`, e)
  );

  const listener = (_channel: string, message: string) => {
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
