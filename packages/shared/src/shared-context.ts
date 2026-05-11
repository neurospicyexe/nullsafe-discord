import { readFileSync } from "fs";

let cache: string | undefined;

/**
 * Load the shared system context file (NSML1, Core_v4, USER_PREFERENCES, ANCHORS).
 * Path set via SHARED_CONTEXT_PATH env var. Non-fatal: returns "" if unset or unreadable.
 * Cached after first read -- file doesn't change at runtime.
 */
export function loadSharedContext(): string {
  if (cache !== undefined) return cache;
  const path = process.env["SHARED_CONTEXT_PATH"]?.trim();
  if (!path) { cache = ""; return ""; }
  try {
    cache = readFileSync(path, "utf-8");
    return cache;
  } catch (e) {
    console.warn(`[shared-context] Failed to read shared context at ${path}:`, e);
    cache = "";
    return "";
  }
}

export function clearSharedContextCache(): void {
  cache = undefined;
}
