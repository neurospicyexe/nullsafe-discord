import { readFileSync } from "fs";
import { IDENTITY_PATHS } from "./config.js";
import type { CompanionId } from "./types.js";

const cache = new Map<CompanionId, string>();

/**
 * Load the full companion identity markdown from disk.
 * Cached after first read -- identity files don't change at runtime.
 */
export function loadIdentity(companionId: CompanionId): string {
  if (cache.has(companionId)) return cache.get(companionId)!;
  const path = IDENTITY_PATHS[companionId];
  try {
    const text = readFileSync(path, "utf-8");
    cache.set(companionId, text);
    return text;
  } catch (e) {
    console.warn(`[identity-loader] Failed to read identity file for ${companionId} at ${path}:`, e);
    // Return a minimal fallback so pipeline doesn't crash
    return `# ${companionId}\nCompanion identity file not found at ${path}.`;
  }
}

/** Clear the cache (useful for testing or hot-reload). */
export function clearIdentityCache(): void {
  cache.clear();
}
