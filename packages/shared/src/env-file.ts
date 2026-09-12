/**
 * Self-contained .env loader, shared by every process in this monorepo. Import it FIRST in each
 * entry point (`import "@nullsafe/shared/env-file"`): ESM evaluates imports depth-first in
 * declaration order, and this module imports nothing but node, so it fills process.env before
 * any config module reads it. The deep-import path matters -- `@nullsafe/shared` (the index)
 * would evaluate the whole package, and anything in it that reads process.env at module level
 * would run before the file is loaded.
 *
 * HISTORY. This started life as packages/autonomous-worker/src/env.ts and only the worker had it.
 * The three bots trusted whatever pm2 injected from ecosystem.config.js -- which is exactly one
 * `pm2 restart <name> --update-env` from a bare shell away from being wrong. 2026-09-11 06:49Z
 * that restart happened: DEEPINFRA_API_KEY vanished from all three bot processes, the direct
 * judge/narrator chain silently became DeepSeek-direct-only (balance $0 -> 402), consolidation
 * skipped every 35 minutes and the memory judge wrote nothing for 12 hours -- while the boot log
 * still said "judges: direct (deepinfra-first)". The file is the source of truth; every process
 * reads it itself.
 *
 * Why not `source .env` or dotenv: the repo .env contains characters bash chokes on (backticks
 * in comments), and pm2 ecosystem configs already parse the file manually for the same reason.
 *
 * Precedence: the .env FILE wins. A STALE pm2 saved env (dump.pm2) silently shadowing it is what
 * 401'd every daemon cron for a day after the 2026-06-27 secret rotation (pm2 kept the
 * pre-rotation HALSETH_SECRET; reload/restart preserve pm2's env; dotenv-style "real env wins"
 * then skipped the fresh value). The file overrides process.env so a rotation propagates on the
 * next start. Point NULLSAFE_ENV_FILE (or the older WORKER_ENV_FILE) elsewhere to relocate the
 * file; there is no path that lets a stale in-memory secret win.
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

/** Parse KEY=VALUE lines. Skips comments, blanks, malformed keys. Strips one layer of matching
 *  surrounding quotes. Never expands or interprets values (a secret containing # or ` passes
 *  through untouched). */
export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Explicit override first (NULLSAFE_ENV_FILE, then the worker's older WORKER_ENV_FILE), else
 *  walk up from cwd looking for `.env`. Four levels covers pm2's per-app cwd
 *  (`bots/<name>` or `packages/<name>` -> repo root) with room to spare. */
export function findEnvFile(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  for (const knob of ["NULLSAFE_ENV_FILE", "WORKER_ENV_FILE"]) {
    const explicit = env[knob];
    if (explicit && existsSync(explicit)) return explicit;
  }
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Load the file into process.env (file wins). Returns what it did so a caller can log or test
 *  it; the module-level call below logs one line so a boot log shows the load happened. */
export function loadEnvFile(): { path: string | null; loaded: number; overridden: number } {
  const path = findEnvFile();
  if (!path) return { path: null, loaded: 0, overridden: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { path, loaded: 0, overridden: 0 };
  }
  const parsed = parseEnv(raw);
  let loaded = 0;
  let overridden = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined && process.env[key] !== value) overridden++;
    process.env[key] = value;
    loaded++;
  }
  return { path, loaded, overridden };
}

// Side effect on import, deliberately: the whole point is that nothing has to remember to call it.
// Guarded so a test that imports this module twice (or the worker's re-export plus a direct
// import) loads once.
const SENTINEL = "__NULLSAFE_ENV_FILE_LOADED__";
if (!process.env[SENTINEL]) {
  const r = loadEnvFile();
  if (r.loaded > 0) {
    process.env[SENTINEL] = "1";
    console.log(
      `[env] loaded ${r.loaded} var(s) from ${r.path}` +
      (r.overridden > 0 ? ` (${r.overridden} overrode a stale process value)` : ""),
    );
  }
}
