// served-memory-report.mjs -- read-out for the served-memory audit (packages/shared/src/served-memory.ts).
//   node scripts/served-memory-report.mjs [--days N] [--companion c] [--top N] [/app/logs/served-memory.jsonl]
// Counts per companion and per source, and the most-served ids. Ids only; the log holds no text.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const days = Number(opt("--days", "7"));
const only = opt("--companion", null);
const top = Number(opt("--top", "10"));
const skip = new Set(["--days", "--companion", "--top"]);
const file = args.find((a, i) => !a.startsWith("--") && !skip.has(args[i - 1])) ?? "/app/logs/served-memory.jsonl";

const since = Date.now() - days * 86_400_000;
let text = "";
try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }

const per = {};
let bad = 0;
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { bad++; continue; }
  if (Date.parse(r.at) < since) continue;
  if (only && r.c !== only) continue;
  const c = (per[r.c] ??= { turns: 0, empty: 0, sources: {}, ids: new Map() });
  c.turns++;
  if (!r.n) c.empty++;
  for (const [src, ids] of Object.entries(r.sources ?? {})) {
    c.sources[src] = (c.sources[src] ?? 0) + ids.length;
    for (const id of ids) c.ids.set(`${src}:${id}`, (c.ids.get(`${src}:${id}`) ?? 0) + 1);
  }
}
console.log(`served-memory ${file} (last ${days}d${only ? `, ${only}` : ""})${bad ? `, ${bad} unparseable lines` : ""}`);
for (const [name, c] of Object.entries(per)) {
  console.log(`\n${name}: ${c.turns} turns, ${c.empty} served nothing`);
  for (const [s, n] of Object.entries(c.sources).sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(18)} ${n} ids served`);
  console.log("  most served:");
  for (const [id, n] of [...c.ids].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`    ${String(n).padStart(4)}x ${id}`);
}
if (!Object.keys(per).length) console.log("no rows in range");
