/**
 * Self-contained .env loader -- evaluated before config.ts reads process.env
 * (import this FIRST in the entry point; ESM evaluates imports depth-first in
 * declaration order, and this module has no imports of its own beyond node).
 *
 * Why not `source .env` or dotenv: the repo .env contains characters bash
 * chokes on (backticks in comments), and pm2 ecosystem configs already parse
 * the file manually for the same reason. This makes one-shot runs
 * (`node dist/index.js --once --companion=x`) work without exporting anything.
 *
 * Precedence: the .env FILE wins. It is the varlock-managed source of truth, and a
 * STALE pm2 saved env (dump.pm2) silently shadowing it is exactly what 401'd every
 * daemon cron for a day after the 2026-06-27 secret rotation (pm2 kept the pre-rotation
 * HALSETH_SECRET; reload/restart preserve pm2's env; dotenv-style "real env wins" then
 * skipped the fresh value). The file overrides process.env so a rotation propagates on the
 * next start. (Point WORKER_ENV_FILE elsewhere to relocate the file; there is no path that
 * lets a stale in-memory secret win.)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

/** Parse KEY=VALUE lines. Skips comments, blanks, malformed keys. Strips one
 *  layer of matching surrounding quotes. Never expands or interprets values
 *  (a secret containing # or ` passes through untouched). */
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

/** WORKER_ENV_FILE override first, then walk up from cwd (package dir -> repo root). */
export function findEnvFile(): string | null {
  const explicit = process.env["WORKER_ENV_FILE"];
  if (explicit && existsSync(explicit)) return explicit;
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadEnvFile(): void {
  const path = findEnvFile();
  if (!path) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const parsed = parseEnv(raw);
  let loaded = 0;
  let overridden = 0;
  for (const [key, value] of Object.entries(parsed)) {
    // The file wins. Overriding (not gap-filling) is deliberate: a stale pm2 dump value
    // must never shadow the current .env (see header -- the 06-27 rotation 401 trap).
    if (process.env[key] !== undefined && process.env[key] !== value) overridden++;
    process.env[key] = value;
    loaded++;
  }
  if (loaded > 0) {
    console.log(`[env] loaded ${loaded} var(s) from ${path}` + (overridden > 0 ? ` (${overridden} overrode a stale process value)` : ""));
  }
}

loadEnvFile();
