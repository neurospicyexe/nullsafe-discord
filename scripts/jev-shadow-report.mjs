#!/usr/bin/env node
/**
 * Read-out for the Jev writeback-gate shadow log (BBH docs/PLAN-jev-2026-09-20.md S3).
 *
 * The bots, with WRITEBACK_GATE=jev-shadow, append one JSON line per judged exchange to
 * JEV_SHADOW_LOG (default /app/logs/jev-shadow.jsonl): the live judge's decision next to Jev's
 * answers, no writes changed. This script turns that file into the day-7 table and a labelling
 * sample of the disagreements, so the readout is one command instead of a session.
 *
 * USAGE (on the VPS):
 *   node scripts/jev-shadow-report.mjs                      # /app/logs/jev-shadow.jsonl, all rows
 *   node scripts/jev-shadow-report.mjs --file x.jsonl --days 7 --theta 0.75 --sample 100 --out /tmp/jev-shadow
 *
 * Output: a markdown report on stdout and, with --out, `report.md` plus `label-sample.json`
 * (stratified: judge-wrote / judge-skipped-jev-high / judge-skipped-jev-low, Gaia-weighted) in
 * the shape the "Worth Remembering" labelling artifact consumes.
 *
 * Read-only. Never contacts Halseth, Discord, or Jev.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const FILE = flag("--file", process.env.JEV_SHADOW_LOG ?? "/app/logs/jev-shadow.jsonl");
const DAYS = Number(flag("--days", "0"));
const THETA = Number(flag("--theta", "0.75"));
const DRIFT_THETA = Number(flag("--drift-theta", "0.6"));
const SAMPLE = Number(flag("--sample", "100"));
const OUT = flag("--out", "");

if (!existsSync(FILE)) { console.error(`[shadow-report] no such file: ${FILE}`); process.exit(1); }
const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;
const rows = [];
let bad = 0;
for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    if (since && Date.parse(r.ts) < since) continue;
    rows.push(r);
  } catch { bad++; }
}

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + "%" : "n/a");
const q = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };

const out = [];
out.push(`# Jev shadow read-out`);
out.push(``);
out.push(`file: \`${FILE}\`  rows: ${rows.length}${bad ? `  (${bad} unparseable lines skipped)` : ""}  window: ${DAYS > 0 ? `last ${DAYS} days` : "all"}  theta: ${THETA}  drift theta: ${DRIFT_THETA}`);
if (rows.length) out.push(`span: ${rows.map((r) => r.ts).sort()[0]} to ${rows.map((r) => r.ts).sort().at(-1)}`);
out.push(``);

const ok = rows.filter((r) => r.jev_ok);
out.push(`## Jev availability`);
out.push(``);
out.push(`ok ${ok.length} / ${rows.length} (${pct(ok.length, rows.length)}); latency p50 ${f2(q(ok.map((r) => r.latency_ms), 0.5))}ms p95 ${f2(q(ok.map((r) => r.latency_ms), 0.95))}ms; wall p95 ${f2(q(ok.map((r) => r.wall_ms), 0.95))}ms`);
const reasons = {};
for (const r of rows.filter((r) => !r.jev_ok)) reasons[r.reason ?? "?"] = (reasons[r.reason ?? "?"] ?? 0) + 1;
if (Object.keys(reasons).length) out.push(`failures by reason: ${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(", ")}`);
out.push(``);

out.push(`## Per companion (Jev-ok rows)`);
out.push(``);
out.push(`| companion | rows | owner / peer | judge wrote | Jev would write (>=${THETA}) | both | Jev only | judge only | would promote to wm | drift flagged | mean worth |`);
out.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
const companions = [...new Set(ok.map((r) => r.companion))].sort();
for (const c of [...companions, "ALL"]) {
  const g = c === "ALL" ? ok : ok.filter((r) => r.companion === c);
  if (!g.length) continue;
  const judgeW = g.filter((r) => r.judge && r.judge !== "skip");
  const jevW = g.filter((r) => (r.worth ?? 0) >= THETA);
  const both = g.filter((r) => r.judge && r.judge !== "skip" && (r.worth ?? 0) >= THETA);
  const promote = g.filter((r) => (r.worth ?? 0) >= THETA && r.would_promote);
  const drift = g.filter((r) => (r.drift ?? 0) >= DRIFT_THETA);
  const mean = g.reduce((a, r) => a + (r.worth ?? 0), 0) / g.length;
  out.push(`| ${c} | ${g.length} | ${g.filter((r) => r.speaker === "owner").length} / ${g.filter((r) => r.speaker === "peer").length} | ${judgeW.length} (${pct(judgeW.length, g.length)}) | ${jevW.length} (${pct(jevW.length, g.length)}) | ${both.length} | ${jevW.length - both.length} | ${judgeW.length - both.length} | ${promote.length} | ${drift.length} (${pct(drift.length, g.length)}) | ${f2(mean)} |`);
}
out.push(``);
out.push(`"Jev only" is the recall the judge is leaving on the table at this theta; "judge only" is what Jev would drop. Neither column is truth until labelled.`);
out.push(``);

out.push(`## Worth distribution vs the judge (Jev-ok rows)`);
out.push(``);
out.push(`| worth bin | rows | judge wrote | drift flagged |`);
out.push(`|---|---|---|---|`);
for (let b = 0; b < 10; b++) {
  const lo = b / 10, hi = (b + 1) / 10;
  const g = ok.filter((r) => (r.worth ?? 0) >= lo && ((r.worth ?? 0) < hi || (b === 9 && r.worth === 1)));
  if (!g.length) continue;
  out.push(`| [${lo.toFixed(1)}, ${hi.toFixed(1)}) | ${g.length} | ${g.filter((r) => r.judge !== "skip").length} | ${g.filter((r) => (r.drift ?? 0) >= DRIFT_THETA).length} |`);
}
out.push(``);

out.push(`## Kind agreement (rows where the judge wrote)`);
out.push(``);
const wrote = ok.filter((r) => r.judge && r.judge !== "skip");
const kinds = {};
for (const r of wrote) { const k = `${r.judge} -> ${r.kind ?? "?"}`; kinds[k] = (kinds[k] ?? 0) + 1; }
for (const [k, v] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) out.push(`- ${k}: ${v}`);
out.push(``);

out.push(`## Drift flags by companion`);
out.push(``);
for (const c of companions) {
  const g = ok.filter((r) => r.companion === c);
  const d = g.filter((r) => (r.drift ?? 0) >= DRIFT_THETA);
  out.push(`- ${c}: ${d.length} of ${g.length} (${pct(d.length, g.length)}); drift p50 ${f2(q(g.map((r) => r.drift ?? 0), 0.5))} p90 ${f2(q(g.map((r) => r.drift ?? 0), 0.9))}`);
}
out.push(``);

// Labelling sample: Gaia-weighted, stratified, deterministic.
let seed = 1717;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (arr, n) => shuffle(arr.slice()).slice(0, n);
const strata = {
  judgeWrote: ok.filter((r) => r.judge !== "skip"),
  skipJevHigh: ok.filter((r) => r.judge === "skip" && (r.worth ?? 0) >= THETA),
  skipJevLow: ok.filter((r) => r.judge === "skip" && (r.worth ?? 0) < THETA),
};
const gaiaFirst = (arr) => [...pick(arr.filter((r) => r.companion === "gaia"), Math.ceil(arr.length)), ...pick(arr.filter((r) => r.companion !== "gaia"), arr.length)];
const per = Math.floor(SAMPLE / 3);
const sample = shuffle([
  ...gaiaFirst(strata.judgeWrote).slice(0, per),
  ...gaiaFirst(strata.skipJevHigh).slice(0, SAMPLE - 2 * per),
  ...gaiaFirst(strata.skipJevLow).slice(0, per),
]).map((r, i) => ({ n: i + 1, id: r.message_id, companion: r.companion, at: r.ts, who: r.speaker_name, peer: r.speaker === "peer", judge: r.judge, jev: r.worth, jev_kind: r.kind, jev_sal: r.salience, jev_aff: r.affect, drift: r.drift, channel_id: r.channel_id }));
out.push(`## Labelling sample`);
out.push(``);
out.push(`${sample.length} rows (strata judgeWrote ${strata.judgeWrote.length}, skipJevHigh ${strata.skipJevHigh.length}, skipJevLow ${strata.skipJevLow.length}; Gaia drawn first in each). The shadow log carries ids, not text: hydrate \`user\`/\`assistant\` from Discord with scripts/export-jev-exchanges.mjs (--channel per channel_id) before building the artifact.`);
out.push(``);

const report = out.join("\n");
console.log(report);
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.md"), report + "\n");
  writeFileSync(join(OUT, "label-sample.json"), JSON.stringify(sample));
  console.error(`[shadow-report] wrote ${join(OUT, "report.md")} and label-sample.json (${sample.length} rows)`);
}
