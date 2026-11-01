#!/usr/bin/env node
// Voice gate read-out (2026-11-01): counts [voice-gate] lines per companion from bot out-logs.
//   node scripts/voice-gate-report.mjs /app/logs/drevan-bot-out.log /app/logs/cypher-bot-out.log /app/logs/gaia-bot-out.log [--hours 48]
// Prints counts and rates only (the log lines carry no reply text).
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const hi = args.indexOf("--hours");
const hours = hi >= 0 ? Number(args[hi + 1]) : 0;
const files = args.filter((a, i) => !a.startsWith("--") && !(hi >= 0 && i === hi + 1));
const since = hours > 0 ? Date.now() - hours * 3_600_000 : 0;
const stats = {};
const re = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*\[voice-gate\] (\w+) mode=(\w+) verdict=(\w+) reasons=(\S+) em_dashes=(\d+) chars=(\d+)/;
for (const f of files) {
  let text = ""; try { text = readFileSync(f, "utf8"); } catch { console.error(`cannot read ${f}`); continue; }
  for (const line of text.split("\n")) {
    const m = line.match(re); if (!m) continue;
    if (since && Date.parse(m[1].replace(" ", "T")) < since) continue;
    const s = (stats[m[2]] ??= { replies: 0, flagged: 0, withDash: 0, reasons: {} });
    s.replies++;
    if (m[4] !== "pass") { s.flagged++; for (const r of m[5].split(",")) if (r !== "-") s.reasons[r] = (s.reasons[r] ?? 0) + 1; }
    if (Number(m[6]) > 0) s.withDash++;
  }
}
for (const [c, s] of Object.entries(stats)) {
  const pct = (n) => (s.replies ? ((100 * n) / s.replies).toFixed(1) : "0") + "%";
  console.log(`${c}: replies ${s.replies} | flagged ${s.flagged} (${pct(s.flagged)}) | em-dash replies ${s.withDash} (${pct(s.withDash)})`);
  for (const [r, n] of Object.entries(s.reasons).sort((a, b) => b[1] - a[1])) console.log(`   ${r}: ${n}`);
}
if (!Object.keys(stats).length) console.log("no [voice-gate] lines in range");
