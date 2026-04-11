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

// Lua script for atomic floor release. Executes server-side as a single
// Redis operation: only DEL if the key still belongs to us. Prevents
// the GET→DEL race where another companion claims between our read and delete.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** Create a Redis client with error-logging, reconnect backoff, and custom commands. */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });
  client.on("error", (e: Error) =>
    console.warn("[floor] redis error:", e.message),
  );
  // Register atomic release as a named command so call sites stay clean.
  client.defineCommand("atomicRelease", { numberOfKeys: 1, lua: RELEASE_LUA });
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
 * Release the floor atomically. Delegates to the Lua script registered in
 * createRedisClient so the ownership check and delete are a single Redis op.
 * Returns 1 if the key was deleted (we held it), 0 if it had already expired
 * or been claimed by someone else.
 */
export async function releaseFloor(
  redis: Redis,
  botName: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (redis as any).atomicRelease(FLOOR_KEY, botName);
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
