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
 *
 * Per-bot overrides (P2-12, 2026-10-08). "File wins" has one hole: ecosystem.config.js computes
 * PER-BOT values (HERMES_API_URL = port 8642/8643/8644, INFERENCE_MODE from <BOT>_INFERENCE_MODE)
 * and injects them under the GENERIC key, so a generic `HERMES_API_URL=` or `INFERENCE_MODE=` in
 * .env would overwrite the per-bot value for all three bots at once. After the file is applied,
 * `applyPerBotOverrides` re-reads `<PREFIX>_<KEY>` for every loaded key (plus the known per-bot
 * keys even when the file lacks the generic) and lets the prefixed value win. PREFIX is the bot's
 * identity: NULLSAFE_BOT (set per bot in ecosystem.config.js), else pm2's own `name` with its
 * `-bot` suffix stripped; a process with neither (the worker, a bare `node dist/index.js` with no
 * NULLSAFE_BOT) gets no overrides. The ecosystem file forwards <BOT>_HERMES_API_URL and
 * <BOT>_INFERENCE_MODE for exactly this reason: the prefixed value must exist to recover from.
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

/** Keys ecosystem.config.js derives per bot. Overridden from `<PREFIX>_<KEY>` even when the .env
 *  file has no generic line for them (a stale pm2 generic is then corrected too). */
export const PER_BOT_OVERRIDE_KEYS = ["INFERENCE_MODE", "HERMES_API_URL"] as const;

/** The bot's env prefix: NULLSAFE_BOT=cypher -> "CYPHER"; else pm2's `name` ("cypher-bot" ->
 *  "CYPHER"). null when the process is not a bot. */
export function botEnvPrefix(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env["NULLSAFE_BOT"]?.trim();
  const fromPm2 = env["name"]?.trim().replace(/-bot$/i, "");
  const raw = explicit || fromPm2 || "";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(raw)) return null;
  return raw.toUpperCase();
}

/** For each key in `keys` (plus PER_BOT_OVERRIDE_KEYS), if `<prefix>_<key>` is set in env, copy it
 *  over the generic key. Returns the keys taken. Logs one line per key (names only, never values). */
export function applyPerBotOverrides(
  keys: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
  prefix: string | null = botEnvPrefix(env),
  log: (line: string) => void = (line) => console.log(line),
): string[] {
  if (!prefix) return [];
  const taken: string[] = [];
  const candidates = new Set<string>([...keys, ...PER_BOT_OVERRIDE_KEYS]);
  for (const key of candidates) {
    if (key.startsWith(`${prefix}_`)) continue; // never fold a prefixed key onto itself
    const prefixed = `${prefix}_${key}`;
    const value = env[prefixed];
    if (value === undefined) continue;
    if (env[key] === value) continue;
    env[key] = value;
    taken.push(key);
    log(`[env] ${key} taken from ${prefixed}`);
  }
  return taken;
}

export interface LoadEnvFileOptions {
  /** Explicit file path; default = findEnvFile(). */
  path?: string | null;
  /** Target env; default = process.env (tests pass their own). */
  env?: NodeJS.ProcessEnv;
  /** Bot prefix for per-bot overrides; default = botEnvPrefix(env). */
  prefix?: string | null;
  log?: (line: string) => void;
}

/** Load the file into process.env (file wins), then re-apply per-bot overrides (see header).
 *  Returns what it did so a caller can log or test it; the module-level call below logs one line
 *  so a boot log shows the load happened. */
export function loadEnvFile(opts: LoadEnvFileOptions = {}): {
  path: string | null; loaded: number; overridden: number; perBot: string[];
} {
  const env = opts.env ?? process.env;
  const path = opts.path !== undefined ? opts.path : findEnvFile(process.cwd(), env);
  if (!path) return { path: null, loaded: 0, overridden: 0, perBot: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { path, loaded: 0, overridden: 0, perBot: [] };
  }
  const parsed = parseEnv(raw);
  let loaded = 0;
  let overridden = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== value) overridden++;
    env[key] = value;
    loaded++;
  }
  const prefix = opts.prefix !== undefined ? opts.prefix : botEnvPrefix(env);
  const perBot = applyPerBotOverrides(Object.keys(parsed), env, prefix, opts.log);
  return { path, loaded, overridden, perBot };
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
