import type { Redis } from "ioredis";

const KEY_CONSOLIDATED = (id: string) => `companion:${id}:session_consolidated`;

/** Pure helper -- pass the result of getLastActivityMs(redis) directly. */
export function isIdle(lastActivityMs: number | null, thresholdMinutes: number): boolean {
  if (!lastActivityMs) return false;
  return Date.now() - lastActivityMs > thresholdMinutes * 60 * 1000;
}

export async function markConsolidated(
  redis: Redis,
  companionId: string,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(KEY_CONSOLIDATED(companionId), "true", "EX", ttlSeconds);
}

export async function isConsolidated(redis: Redis, companionId: string): Promise<boolean> {
  return (await redis.get(KEY_CONSOLIDATED(companionId))) === "true";
}

export async function clearConsolidation(redis: Redis, companionId: string): Promise<void> {
  await redis.del(KEY_CONSOLIDATED(companionId));
}
