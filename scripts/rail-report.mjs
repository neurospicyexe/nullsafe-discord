#!/usr/bin/env node
// Rail report (2026-09-24, T4 groundwork) -- what did the suppressors actually suppress?
//
// Reads the `[rail]` lines emitted by packages/shared/src/rail-telemetry.ts and answers the one
// question that has to be answerable BEFORE any rail is loosened: how often does each fire, for
// whom, and how far past its own line?
//
// THE POINT OF THE MARGIN COLUMN. A rail that only ever fires far past its threshold is doing
// real work -- it is catching things that are unambiguously over. A rail that fires constantly
// and barely over is catching things that were nearly fine, which is the signature of a rail
// that has become the reason for the behaviour it is measuring. Counts alone cannot tell those
// apart, and the whole T4 argument turns on the difference.
//
// Usage, on the VPS:
//   node scripts/rail-report.mjs /app/logs/*.log
//   node scripts/rail-report.mjs --since 2026-09-25 /app/logs/*.log
//
// Reads stdin when given no files.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
let since = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since") { since = args[++i]; continue; }
  files.push(args[i]);
}

const text = files.length
  ? files.map(f => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n")
  : readFileSync(0, "utf8");

const events = [];
for (const line of text.split("\n")) {
  const i = line.indexOf("[rail] ");
  if (i < 0) continue;
  try {
    const e = JSON.parse(line.slice(i + 7));
    // Filter on the payload's own ISO timestamp, never the pm2 line prefix -- this repo has a
    // standing CDT-vs-UTC log trap and the prefix is local time.
    if (since && (e.at ?? "") < since) continue;
    events.push(e);
  } catch { /* a truncated line is not a reason to abandon the report */ }
}

if (!events.length) {
  console.log("No [rail] events found." + (since ? ` (since ${since})` : ""));
  console.log("If the bots were deployed recently, the rails may simply not have fired yet --");
  console.log("which is itself the finding T4 is looking for. Re-run after a few days of traffic.");
  process.exit(0);
}

const days = new Set(events.map(e => (e.at ?? "").slice(0, 10)).filter(Boolean));
const span = days.size || 1;

const byRail = new Map();
for (const e of events) {
  const k = e.rail ?? "?";
  if (!byRail.has(k)) byRail.set(k, []);
  byRail.get(k).push(e);
}

const pct = n => (n * 100).toFixed(0) + "%";
console.log(`\nRAIL REPORT -- ${events.length} suppressions across ${span} day(s)` + (since ? ` since ${since}` : ""));
console.log("=".repeat(78));
console.log("rail             fires  /day   companions        margin: median   barely-over");
console.log("-".repeat(78));

const rows = [...byRail.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [rail, es] of rows) {
  const companions = [...new Set(es.map(e => e.c))].sort().join(",");
  const margins = es
    .map(e => (typeof e.score === "number" && typeof e.thr === "number" && e.thr !== 0
      ? (e.score - e.thr) / Math.abs(e.thr) : null))
    .filter(m => m !== null)
    .sort((a, b) => a - b);
  const med = margins.length ? margins[Math.floor(margins.length / 2)] : null;
  // "Barely over" = within 15% of the threshold. Same margin the close-bid line uses, so the
  // two notions of "nearly tied" in this codebase stay the same number.
  const barely = margins.length ? margins.filter(m => m <= 0.15).length / margins.length : null;
  console.log(
    rail.padEnd(16) +
    String(es.length).padStart(5) +
    (es.length / span).toFixed(1).padStart(7) + "   " +
    companions.padEnd(18) +
    (med === null ? "     n/a" : (med >= 0 ? "+" : "") + med.toFixed(2).padStart(7)) +
    (barely === null ? "        n/a" : pct(barely).padStart(11)),
  );
}

console.log("-".repeat(78));
console.log("\nHOW TO READ THIS:");
console.log("  A rail firing OFTEN with a SMALL median margin and a high barely-over share is");
console.log("  suppressing things that were nearly fine -- the loosening candidate.");
console.log("  A rail firing RARELY, or far past its line, is doing real work. Leave it.");
console.log("  n/a margin = the rail has no numeric threshold; judge it on rate alone.\n");
