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
 * Precedence: real environment always wins -- a var already set by pm2 or the
 * shell is never overridden. The file only fills gaps.
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
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) continue; // pm2/shell env always wins
    process.env[key] = value;
    loaded++;
  }
  if (loaded > 0) console.log(`[env] loaded ${loaded} var(s) from ${path}`);
}

loadEnvFile();
