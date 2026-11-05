// Nightly voice drift job (task 31648f0a, 2026-11-01). Telemetry only: reads Halseth voice_scores
// rows, compares the last 24h and 7d against the stored baseline (scripts/voice-baseline.mjs),
// appends one JSONL row per companion and prints one `[voice-drift]` line (marker names and z only,
// never reply content). Never throws into the scheduler; tolerates a missing rows route, a missing
// baseline and an unwritable log path.
//
// Env: VOICE_DRIFT=off (kill) | VOICE_BASELINE_PATH (/app/logs/voice-baseline.json)
//      VOICE_DRIFT_PATH (/app/logs/voice-drift.jsonl)

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HALSETH_URL, HALSETH_SECRET } from "./config.js";
import {
  fetchVoiceRows, rowTime, windowZ, warnMarkers, twoNightWarn, logLine,
  type BaselineFile, type VoiceRow, type WeightOpts,
} from "./voice-drift-core.js";
import { stageVoiceLesson } from "./voice-lessons.js";
import { isOffToken } from "@nullsafe/shared";

const COMPANION_IDS = ["cypher", "drevan", "gaia"] as const;
export const baselinePath = () => process.env["VOICE_BASELINE_PATH"] ?? "/app/logs/voice-baseline.json";
export const driftPath = () => process.env["VOICE_DRIFT_PATH"] ?? "/app/logs/voice-drift.jsonl";

function readBaseline(): BaselineFile | null {
  try { return JSON.parse(readFileSync(baselinePath(), "utf8")) as BaselineFile; } catch { return null; }
}

function lastRow(companion: string): { ts: string; warn_h24?: string[] } | null {
  try {
    const lines = readFileSync(driftPath(), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = JSON.parse(lines[i]!) as { companion?: string; ts: string; warn_h24?: string[] };
      if (r.companion === companion) return r;
    }
  } catch { /* no file yet */ }
  return null;
}

export interface DriftDeps {
  fetchRows?: (companion: string, from: string, to: string) => Promise<VoiceRow[] | null>;
  now?: () => Date;
  stageLesson?: (companion: string, z: Record<string, number>, flagged: string[]) => Promise<unknown>;
}

export async function runVoiceDriftTick(deps: DriftDeps = {}): Promise<void> {
  if (isOffToken(process.env["VOICE_DRIFT"])) return;
  const now = (deps.now ?? (() => new Date()))();
  const baseline = readBaseline();
  if (!baseline) { console.warn(`[voice-drift] no baseline at ${baselinePath()}; run scripts/voice-baseline.mjs`); return; }
  const opts: WeightOpts = { cleanWeight: baseline.clean_weight, fullSince: baseline.full_since };
  const fetchRows = deps.fetchRows ?? ((c, f, t) => fetchVoiceRows(HALSETH_URL, HALSETH_SECRET, c, f, t));
  const to = now.toISOString();
  const d7From = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const h24Cut = now.getTime() - 86400_000;

  for (const companion of COMPANION_IDS) {
    try {
      const rows = await fetchRows(companion, d7From, to);
      if (rows === null) { console.warn("[voice-drift] Halseth rows route unavailable (404); skipped"); return; }
      const h24Rows = rows.filter(r => rowTime(r.created_at) >= h24Cut);
      const b = baseline.companions[companion];
      const h24 = windowZ(h24Rows, b, opts);
      const d7 = windowZ(rows, b, opts);
      const warnNow = warnMarkers(h24.z);
      const warn2 = twoNightWarn(warnNow, lastRow(companion), now);
      try {
        mkdirSync(dirname(driftPath()), { recursive: true });
        appendFileSync(driftPath(), JSON.stringify({ ts: to, companion, h24, d7, warn_h24: warnNow, warn2 }) + "\n");
      } catch (e) {
        console.warn(`[voice-drift] jsonl write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(logLine(companion, h24, d7, warn2));
      if (warn2.length) console.warn(`[voice-drift] WARN ${companion} |z|>=2 two nights running: ${warn2.join(", ")}`);
      // Voice lessons (mig 0159): a moved marker tonight -> ONE staged lesson in the companion's own voice,
      // from marker names and z only. Staged for Raziel; never applied.
      if (warnNow.length) await (deps.stageLesson ?? stageVoiceLesson)(companion, h24.z, warnNow);
    } catch (e) {
      console.warn(`[voice-drift] ${companion} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
