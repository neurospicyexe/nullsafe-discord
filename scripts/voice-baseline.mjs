#!/usr/bin/env node
/**
 * Write the per-companion voice baseline (task 31648f0a, 2026-11-01).
 *
 *   node scripts/voice-baseline.mjs --from 2026-10-18 --to 2026-11-01 [--out /app/logs/voice-baseline.json]
 *        [--full-since <ISO>] [--clean-weight 10] [--companions cypher,drevan,gaia] [--dry-run]
 *
 * Reads Halseth voice_scores rows through GET /mind/voice-scores/:companion/rows (PROPOSED route, see
 * the task report; a 404 stops the script with a clear message and writes nothing). Needs HALSETH_URL and
 * ADMIN_SECRET (or HALSETH_SECRET) in the environment. Run `npm run build` first: the maths lives in
 * packages/autonomous-worker/dist/voice-drift-core.js.
 *
 * Bias note: before VOICE_SCORE_SAMPLE shipped (default 1.0) only 10% of CLEAN replies were posted. Clean rows
 * older than --full-since are weighted by --clean-weight (default 10) so the baseline is not skewed toward
 * dirty replies. Pass --full-since = the moment the all-replies change deployed; omit it and EVERY clean row in
 * the window is up-weighted (right for a window entirely before the deploy). swearing / hedging / bluntness
 * only exist on rows posted after the marker change; a baseline for them stays empty until enough
 * `mk:v1` rows accumulate, and the drift job skips markers without one. Re-run the script then.
 *
 * `--to` is inclusive of that whole day (UTC). Refuses to overwrite an existing file without --force:
 * "written once" is the contract.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = name => args.includes(`--${name}`);

const from = opt("from"), to = opt("to");
if (!from || !to || !/^\d{4}-\d\d-\d\d/.test(from) || !/^\d{4}-\d\d-\d\d/.test(to)) {
  console.error("usage: voice-baseline.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--out path] [--full-since ISO] [--clean-weight 10] [--force] [--dry-run]");
  process.exit(2);
}
const out = opt("out", process.env.VOICE_BASELINE_PATH ?? "/app/logs/voice-baseline.json");
const fullSince = opt("full-since", null);
const cleanWeight = Number(opt("clean-weight", "10"));
const companions = opt("companions", "cypher,drevan,gaia").split(",").map(s => s.trim()).filter(Boolean);
const baseUrl = process.env.HALSETH_URL ?? "";
const secret = process.env.ADMIN_SECRET ?? process.env.HALSETH_SECRET ?? "";
if (!baseUrl) { console.error("HALSETH_URL is not set"); process.exit(2); }
if (!Number.isFinite(cleanWeight) || cleanWeight < 1) { console.error("--clean-weight must be >= 1"); process.exit(2); }
if (existsSync(out) && !flag("force") && !flag("dry-run")) {
  console.error(`${out} exists; the baseline is written once. Pass --force to replace it.`);
  process.exit(1);
}

const core = await import(pathToFileURL(resolve(import.meta.dirname, "../packages/autonomous-worker/dist/voice-drift-core.js")).href);
const fromIso = new Date(`${from.slice(0, 10)}T00:00:00Z`).toISOString();
const toIso = new Date(new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime() + 86400_000).toISOString();

const byCompanion = {};
for (const c of companions) {
  const rows = await core.fetchVoiceRows(baseUrl, secret, c, fromIso, toIso);
  if (rows === null) {
    console.error("Halseth has no /mind/voice-scores/:companion/rows route yet (404). Build the proposal first; nothing written.");
    process.exit(1);
  }
  byCompanion[c] = rows;
  console.log(`[voice-baseline] ${c}: ${rows.length} rows`);
}

const baseline = core.buildBaseline(byCompanion, { from: fromIso, to: toIso }, { cleanWeight, fullSince });
for (const [c, b] of Object.entries(baseline.companions)) {
  const parts = Object.entries(b.markers).map(([m, s]) => `${m}=${s.mean.toFixed(2)}±${s.sd.toFixed(2)}(n${s.n})`);
  console.log(`[voice-baseline] ${c}: ${parts.join(" ") || "no data"}`);
}
if (flag("dry-run")) { console.log("[voice-baseline] dry run, nothing written"); process.exit(0); }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n");
console.log(`[voice-baseline] wrote ${out}`);
