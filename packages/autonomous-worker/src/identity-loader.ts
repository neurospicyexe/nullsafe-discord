import { readFileSync } from "fs";
import { IDENTITY_PATHS, SHARED_CONTEXT_PATH } from "./config.js";
import type { CompanionId } from "./types.js";

const cache = new Map<CompanionId, string>();

let sharedCtxCache: string | undefined;

function getSharedContext(): string {
  if (sharedCtxCache !== undefined) return sharedCtxCache;
  if (!SHARED_CONTEXT_PATH) { sharedCtxCache = ""; return ""; }
  try {
    sharedCtxCache = readFileSync(SHARED_CONTEXT_PATH, "utf-8");
  } catch (e) {
    console.warn(`[identity-loader] Failed to read shared context at ${SHARED_CONTEXT_PATH}:`, e);
    sharedCtxCache = "";
  }
  return sharedCtxCache;
}

/**
 * Load the full companion identity markdown from disk, prepended with shared system context.
 * Cached after first read -- files don't change at runtime.
 */
export function loadIdentity(companionId: CompanionId): string {
  if (cache.has(companionId)) return cache.get(companionId)!;
  const path = IDENTITY_PATHS[companionId];
  try {
    const identityText = readFileSync(path, "utf-8");
    const sharedCtx = getSharedContext();
    const full = sharedCtx ? `${sharedCtx}\n\n---\n\n${identityText}` : identityText;
    cache.set(companionId, full);
    return full;
  } catch (e) {
    console.warn(`[identity-loader] Failed to read identity file for ${companionId} at ${path}:`, e);
    return `# ${companionId}\nCompanion identity file not found at ${path}.`;
  }
}

/** Clear the cache (useful for testing or hot-reload). */
export function clearIdentityCache(): void {
  cache.clear();
}
