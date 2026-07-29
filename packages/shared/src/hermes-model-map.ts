// packages/shared/src/hermes-model-map.ts
//
// In hermes mode the bot is NOT the thing that changes the model. `cy: model <key>` writes
// `active_model` to Halseth; the hermes-model-watcher on the VPS notices, maps the key via
// hermes-model-map.json, rewrites the gateway config and restarts it. So the set of keys that
// can actually take effect is the set of keys in THAT FILE, not the set in ALL_MODELS.
//
// Those two sets had drifted badly (measured 2026-07-29):
//   * 9 of the 23 keys the Discord command offered were absent from the live map. The command
//     validated against ALL_MODELS, acked SUCCESS, wrote active_model -- and the watcher then
//     pinged "unknown model key". Two contradictory acks for one action, which is the same
//     ack-success-change-nothing shape as the 07-28 `flash`/`pro` bug.
//   * 5 keys the live map could serve (gemini, gemini-pro, ollama, ollama-glm, reasoner) were
//     rejected by the command, so working models were unreachable.
//
// The deeper cause was not code drift between repo copies: `nullsafe-triad-skills` has no git
// remote by design (it must never be published), so the VPS clone and the workstation clone are
// independent repos with no sync path, `ops/` is untracked there, and the live file sat 4 keys
// behind whatever the workstation had. No build-time parity test across repo copies could ever
// have caught that, because the file that runs was never fed by git.
//
// Hence: read the LIVE file at boot, from the same path the watcher uses, and let it define what
// is selectable. One authority, no build coupling, and it self-heals the moment the map is
// updated -- the bot picks up new keys on its next restart with no bot deploy at all.
//
// Fail-open on purpose: an unreadable map degrades to the full registry (previous behaviour)
// rather than leaving Raziel unable to switch models at all. It logs loudly instead.

import { readFileSync } from "node:fs";
import { ALL_MODELS, type ModelEntry } from "./models.js";

/** Where the watcher reads its map from (systemd ExecStart runs the script from this dir). */
export const DEFAULT_HERMES_MODEL_MAP_PATH =
  "/home/nullsafe/nullsafe-triad-skills/ops/hermes-model-map.json";

/** Keys starting with `_` are prose notes in the map, not model entries. */
function isModelKey(key: string): boolean {
  return !key.startsWith("_");
}

/**
 * Read the live hermes model map and return the keys the watcher can actually apply.
 * Returns null when the file cannot be read or parsed -- callers must fail open.
 */
export function readHermesModelKeys(path?: string): Set<string> | null {
  const file = path || process.env.HERMES_MODEL_MAP || DEFAULT_HERMES_MODEL_MAP_PATH;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed as Record<string, unknown>).filter(isModelKey);
    // An empty map is indistinguishable from a truncated/garbage file; treat it as unreadable
    // rather than as "nothing is selectable", which would lock out model switching entirely.
    return keys.length > 0 ? new Set(keys) : null;
  } catch {
    return null;
  }
}

/**
 * The models `cy: model` may offer. In hermes mode this is ALL_MODELS ∩ live map; otherwise
 * (direct/brain, where the bot or Brain resolves the key itself) it is the full registry.
 *
 * Keys only -- never model id strings. The same key legitimately carries different model ids per
 * consumer: `mistral-large` is `mistral-large-latest` on the Mistral API and
 * `mistralai/mistral-large` through OpenRouter, which is what hermes routes it via. Comparing
 * ids would flag that correct difference as a conflict.
 */
export function selectableModels(hermesKeys: Set<string> | null): Record<string, ModelEntry> {
  if (!hermesKeys) return ALL_MODELS;
  const out: Record<string, ModelEntry> = {};
  for (const [key, entry] of Object.entries(ALL_MODELS)) {
    if (hermesKeys.has(key)) out[key] = entry;
  }
  // If the intersection is empty the map is real but describes a different world (wrong file,
  // wrong deploy). Offering nothing would be worse than offering the old list.
  return Object.keys(out).length > 0 ? out : ALL_MODELS;
}

export interface HermesMapDiagnostic {
  /** Keys the live map holds that this bot's registry doesn't offer -- reachable but hidden. */
  unofferedByBot: string[];
  /** Keys the bot offers that the live map can't apply -- would ack success and change nothing. */
  unapplicableByWatcher: string[];
  /** Count the bot will actually offer after intersection. */
  selectableCount: number;
}

/** Compare the bot registry against the live map so boot can report the gap in both directions. */
export function diagnoseHermesMap(hermesKeys: Set<string> | null): HermesMapDiagnostic | null {
  if (!hermesKeys) return null;
  const botKeys = new Set(Object.keys(ALL_MODELS));
  const selectable = Object.keys(selectableModels(hermesKeys));
  return {
    unofferedByBot: [...hermesKeys].filter(k => !botKeys.has(k)).sort(),
    unapplicableByWatcher: [...botKeys].filter(k => !hermesKeys.has(k)).sort(),
    selectableCount: selectable.length,
  };
}
