#!/usr/bin/env node
// Turn report (2026-10-18, P6 of Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md).
//
// Reads the `[turn]` lines written by packages/shared/src/turn-telemetry.ts (one per reply turn, per
// dropped/absorbed/skipped turn) and prints per-outcome counts plus p50/p95 of every timing field.
// Ids and numbers only; the lines carry no message or reply text and neither does this output.
//
// Usage, on the VPS:
//   node scripts/turn-report.mjs /app/logs/drevan-bot-out.log
//   node scripts/turn-report.mjs --hours 6 --companion drevan /app/logs/*-bot-out.log
//
// Reads stdin when given no files. --hours filters on the payload's own ISO `at` (pm2 stamps its own
// local-time prefix on each line and this repo has a standing CDT-vs-UTC trap, so the prefix is never used).

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let hours = null;
let companion = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--hours") { hours = Number(args[++i]); continue; }
  if (args[i] === "--companion") { companion = args[++i]; continue; }
  files.push(args[i]);
}

const text = files.length
  ? files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n")
  : readFileSync(0, "utf8");

const cutoff = hours && Number.isFinite(hours) ? Date.now() - hours * 3600_000 : null;
const FIELDS = ["queue_ms", "settle_ms", "vision_ms", "halseth_ms", "inference_ms", "post_ms", "total_ms"];

const rows = [];
for (const line of text.split("\n")) {
  const i = line.indexOf("[turn] ");
  if (i < 0) continue;
  let e;
  try { e = JSON.parse(line.slice(i + 7)); } catch { continue; }
  if (!e || typeof e !== "object" || typeof e.outcome !== "string") continue;
  if (companion && e.c !== companion) continue;
  if (cutoff !== null) {
    const t = Date.parse(e.at ?? "");
    if (!Number.isFinite(t) || t < cutoff) continue;
  }
  rows.push(e);
}

/** Nearest-rank percentile over an ascending-sorted array. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`turns: ${rows.length}${companion ? `  companion: ${companion}` : ""}${hours ? `  window: ${hours}h` : ""}`);
if (rows.length === 0) process.exit(0);

console.log("\noutcome");
const byOutcome = new Map();
for (const r of rows) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
for (const [o, n] of [...byOutcome].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${pad(o, 22)}${num(n, 6)}`);
}

console.log("\nvision");
const byVision = new Map();
for (const r of rows) byVision.set(r.vision ?? "none", (byVision.get(r.vision ?? "none") ?? 0) + 1);
for (const [v, n] of [...byVision].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(v, 22)}${num(n, 6)}`);

const catchups = rows.filter((r) => r.catchup).length;
console.log(`\ncatchup turns: ${catchups}   gathered>0: ${rows.filter((r) => (r.gathered ?? 0) > 0).length}`);

console.log(`\n${pad("field", 16)}${num("p50", 8)}${num("p95", 8)}   (ms, all turns; posted only below)`);
for (const f of FIELDS) {
  const v = rows.map((r) => Number(r[f]) || 0).sort((a, b) => a - b);
  console.log(`${pad(f, 16)}${num(pct(v, 50), 8)}${num(pct(v, 95), 8)}`);
}

const posted = rows.filter((r) => r.outcome === "posted");
if (posted.length) {
  console.log(`\nposted only (n=${posted.length})`);
  for (const f of FIELDS) {
    const v = posted.map((r) => Number(r[f]) || 0).sort((a, b) => a - b);
    console.log(`${pad(f, 16)}${num(pct(v, 50), 8)}${num(pct(v, 95), 8)}`);
  }
}
