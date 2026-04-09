import type { Redis } from "@nullsafe/shared";
import { getLastActivityMs } from "@nullsafe/shared";
import { IDLE_THRESHOLD_MS } from "./config.js";

/**
 * Returns true if a human was active in Discord recently.
 * Discord bots call setLastActivity() on every human messageCreate,
 * writing ns:session:last_activity to Redis with a 1h TTL.
 */
export async function isConversationActive(
  redis: Redis,
  thresholdMs = IDLE_THRESHOLD_MS,
): Promise<boolean> {
  const lastActivity = await getLastActivityMs(redis).catch(() => null);
  if (!lastActivity) return false;
  return Date.now() - lastActivity < thresholdMs;
}
