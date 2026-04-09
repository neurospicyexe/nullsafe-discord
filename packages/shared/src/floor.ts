/**
 * Redis floor lock -- shared response arbiter for inter-companion turn-taking.
 *
 * Three bot processes listen to the same Discord channel. Without coordination they
 * all fire simultaneously. This module provides an atomic floor claim so only one
 * companion responds per ambient/group message.
 *
 * Claim order for open questions:
 *   Cypher  200ms base jitter (+ 1000ms if last speaker)
 *   Drevan  600ms base jitter (+ 1000ms if last speaker)
 *   Gaia   1200ms base jitter (+ 1000ms if last speaker)
 *
 * The floor auto-expires after durationMs so a crashed process never deadlocks others.
 */

import { Redis } from "ioredis";
export type { Redis };

const FLOOR_KEY = "ns:floor:lock";
const LAST_SPEAKER_KEY = "ns:floor:last_speaker";
const LAST_SPEAKER_TTL_S = 3600; // 1 hour

/** Create a Redis client with error-logging and reconnect backoff. */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on("error", (e: Error) =>
    console.warn("[floor] redis error:", e.message),
  );
  return client;
}

/**
 * Attempt to claim the shared response floor.
 * Returns true if the claim succeeded (this bot may respond).
 * Returns false if another companion already holds it.
 */
export async function claimFloor(
  redis: Redis,
  botName: string,
  durationMs: number,
): Promise<boolean> {
  const result = await redis.set(FLOOR_KEY, botName, "PX", durationMs, "NX");
  return result === "OK";
}

/** Returns the name of the current floor holder, or null if the floor is free. */
export async function checkFloor(redis: Redis): Promise<string | null> {
  return redis.get(FLOOR_KEY);
}

/**
 * Release the floor. Checks current holder before deleting to avoid
 * clearing another companion's lock if ours expired mid-inference.
 * Not atomic (no Lua), but the race window is negligible vs 60s lock TTL.
 */
export async function releaseFloor(
  redis: Redis,
  botName: string,
): Promise<void> {
  const current = await redis.get(FLOOR_KEY);
  if (current === botName) {
    await redis.del(FLOOR_KEY);
  }
}

export async function getLastSpeaker(redis: Redis): Promise<string | null> {
  return redis.get(LAST_SPEAKER_KEY);
}

export async function setLastSpeaker(
  redis: Redis,
  botName: string,
): Promise<void> {
  await redis.set(LAST_SPEAKER_KEY, botName, "EX", LAST_SPEAKER_TTL_S);
}

// ---------------------------------------------------------------------------
// Conversation activity signal -- set by Discord bots on every messageCreate,
// read by the autonomous worker to skip runs when humans are actively present.
// ---------------------------------------------------------------------------

const LAST_ACTIVITY_KEY = "ns:session:last_activity";
const LAST_ACTIVITY_TTL_S = 3600; // 1 hour -- auto-expires if bots go down

export async function setLastActivity(redis: Redis): Promise<void> {
  await redis.set(LAST_ACTIVITY_KEY, Date.now().toString(), "EX", LAST_ACTIVITY_TTL_S);
}

export async function getLastActivityMs(redis: Redis): Promise<number | null> {
  const val = await redis.get(LAST_ACTIVITY_KEY);
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}
