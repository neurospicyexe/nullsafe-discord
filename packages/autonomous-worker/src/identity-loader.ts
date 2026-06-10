import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { IDENTITY_PATHS, SHARED_CONTEXT_PATH } from "./config.js";
import { getKernelBundle } from "./halseth-client.js";
import type { CompanionId } from "./types.js";

const cache = new Map<CompanionId, string>();
const remoteCache = new Map<CompanionId, string>();

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

/**
 * Kernel-first identity loading: Halseth identity_kernel bundle (shared doctrine +
 * companion kernel) is the canonical source. Fallback chain:
 *   1. GET /identity/kernel/:id/bundle (live canonical)
 *   2. tmpdir cached copy of the last successful bundle fetch
 *   3. on-disk identity file via loadIdentity (legacy path)
 * Identity is constant, substrate varies -- every substrate pulls the same kernel.
 */
export async function loadIdentityRemote(companionId: CompanionId): Promise<string> {
  if (remoteCache.has(companionId)) return remoteCache.get(companionId)!;

  const tmpPath = join(tmpdir(), `nullsafe-kernel-${companionId}.md`);

  const bundle = await getKernelBundle(companionId);
  if (bundle) {
    remoteCache.set(companionId, bundle);
    try { writeFileSync(tmpPath, bundle, "utf-8"); } catch { /* cache write is best-effort */ }
    console.log(`[identity-loader] ${companionId}: kernel bundle from Halseth (${bundle.length} chars)`);
    return bundle;
  }

  try {
    const cached = readFileSync(tmpPath, "utf-8");
    if (cached.length > 200) {
      remoteCache.set(companionId, cached);
      console.warn(`[identity-loader] ${companionId}: Halseth unreachable, using cached kernel bundle`);
      return cached;
    }
  } catch { /* fall through to disk */ }

  console.warn(`[identity-loader] ${companionId}: no kernel available, falling back to disk identity file`);
  return loadIdentity(companionId);
}

/** Clear the cache (useful for testing or hot-reload). */
export function clearIdentityCache(): void {
  cache.clear();
  remoteCache.clear();
}
