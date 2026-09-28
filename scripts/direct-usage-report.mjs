#!/usr/bin/env node
/**
 * Tally of the bot-side DIRECT inference spend (BBH STATUS B22, 2026-09-28).
 *
 * The judges, consolidation narrator, day-distill clerk, med reminder and reach ask call
 * DeepInfra (DeepSeek-direct as the emergency second link) without going through the Hermes
 * gateway, so none of their tokens reach state.db. Since B22 each 2xx prints one line:
 *
 *   2026-09-28 12:00:01: [inference:usage] provider=deepinfra model=<id> caller=<label|-> in=N out=N cached=N reasoning=N cost=<usd|->
 *
 * (in INCLUDES cached, out INCLUDES reasoning; `usage=absent` when the body had no usage.)
 * This script turns those lines into a per companion / per day table, priced.
 *
 * USAGE (on the VPS):
 *   node scripts/direct-usage-report.mjs                         # /app/logs/*-bot-out.log + worker, all days
 *   node scripts/direct-usage-report.mjs --days 7 --by caller
 *   node scripts/direct-usage-report.mjs --files a.log,b.log --price 'deepseek-v4-flash=0.14,0.28,0.028'
 *
 * Pricing is USD per 1M tokens as `model=input,output,cached`. The ONE built-in rate is
 * deepseek-ai/DeepSeek-V4-Flash-0731 on DeepInfra, standard tier, as fetched from the DeepInfra
 * model page on 2026-09-27 (BBH docs/readout-flash-24h-2026-09-27.md section 3): $0.06 in, $0.18
 * out, $0.015 cached. Any other model (including DeepSeek-direct's deepseek-v4-flash) is reported
 * UNPRICED until you pass --price for it; this script never guesses a rate. When the provider
 * sent its own `cost=`, that sum is shown next to the derived one.
 *
 * Day = the CDT date in pm2's line prefix (pm2 writes local time on this box, see OPS-MANUAL).
 * Companion = the log file name (`cypher-bot-out.log` -> cypher, `autonomous-worker-out.log` -> worker).
 *
 * Read-only. Opens only the log files named; never contacts any service.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const flags = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

const DIR = flag("--dir", "/app/logs");
const DAYS = Number(flag("--days", "0"));
const BY = flag("--by", "day"); // day | caller

const PRICES = new Map([
  ["deepseek-ai/DeepSeek-V4-Flash-0731", { in: 0.06, out: 0.18, cached: 0.015, src: "DeepInfra page 2026-09-27" }],
]);
for (const spec of flags("--price")) {
  const m = /^(.+)=([\d.]+),([\d.]+),([\d.]+)$/.exec(spec);
  if (!m) { console.error(`[direct-usage] bad --price '${spec}', want model=in,out,cached (USD per 1M)`); process.exit(1); }
  PRICES.set(m[1], { in: Number(m[2]), out: Number(m[3]), cached: Number(m[4]), src: "--price" });
}

let files = flag("--files", "");
files = files
  ? files.split(",").filter(Boolean)
  : existsSync(DIR)
    ? readdirSync(DIR).filter((f) => /-bot-out\.log$/.test(f) || f === "autonomous-worker-out.log").map((f) => join(DIR, f))
    : [];
if (!files.length) { console.error(`[direct-usage] no log files (dir ${DIR})`); process.exit(1); }

const companionOf = (f) => {
  const b = basename(f);
  if (b.startsWith("autonomous-worker")) return "worker";
  return b.replace(/-bot-out.*$/, "");
};

/** Parse one log line; null when it is not a usage line. */
function parseUsageLine(line) {
  const at = line.indexOf("[inference:usage] ");
  if (at < 0) return null;
  const ts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(line);
  const kv = {};
  for (const m of line.slice(at + 18).matchAll(/(\w+)=(\S+)/g)) kv[m[1]] = m[2];
  const n = (k) => (/^\d+$/.test(kv[k] ?? "") ? Number(kv[k]) : 0);
  return {
    day: ts ? ts[1] : "unknown",
    provider: kv.provider ?? "?",
    model: kv.model ?? "?",
    caller: kv.caller ?? "-",
    absent: kv.usage === "absent",
    in: n("in"), out: n("out"), cached: n("cached"), reasoning: n("reasoning"),
    cost: kv.cost !== undefined && kv.cost !== "-" && Number.isFinite(Number(kv.cost)) ? Number(kv.cost) : null,
  };
}

/** Derived USD for one row, or null when its model has no known rate. in includes cached. */
function priceRow(r, prices = PRICES) {
  const p = prices.get(r.model);
  if (!p) return null;
  const uncached = Math.max(0, r.in - r.cached);
  return (uncached * p.in + r.cached * p.cached + r.out * p.out) / 1e6;
}

const cutoff = DAYS > 0 ? new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10) : "";
const rows = [];
for (const f of files) {
  if (!existsSync(f)) { console.error(`[direct-usage] skip missing ${f}`); continue; }
  const companion = companionOf(f);
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const r = parseUsageLine(line);
    if (!r) continue;
    if (cutoff && r.day !== "unknown" && r.day < cutoff) continue;
    rows.push({ ...r, companion });
  }
}

const groups = new Map();
for (const r of rows) {
  const key = BY === "caller" ? `${r.companion}\t${r.caller}` : `${r.companion}\t${r.day}`;
  const g = groups.get(key) ?? { calls: 0, absent: 0, in: 0, cached: 0, out: 0, reasoning: 0, usd: 0, unpriced: 0, reported: 0, reportedN: 0, models: new Set() };
  g.calls++; if (r.absent) g.absent++;
  g.in += r.in; g.cached += r.cached; g.out += r.out; g.reasoning += r.reasoning;
  const usd = priceRow(r);
  if (usd === null) { if (!r.absent) g.unpriced++; } else g.usd += usd;
  if (r.cost !== null) { g.reported += r.cost; g.reportedN++; }
  g.models.add(r.model);
  groups.set(key, g);
}

const $ = (x) => `$${x.toFixed(4)}`;
const out = [];
out.push(`# Direct inference usage (bot-side, outside Hermes)`);
out.push(``);
out.push(`files: ${files.map((f) => basename(f)).join(", ")}  usage lines: ${rows.length}  window: ${DAYS > 0 ? `since ${cutoff}` : "all"}  grouped by: companion x ${BY === "caller" ? "caller" : "day (CDT)"}`);
out.push(`rates (USD/1M in, out, cached): ${[...PRICES].map(([m, p]) => `${m} ${p.in}/${p.out}/${p.cached} (${p.src})`).join("; ")}`);
out.push(``);
if (!rows.length) {
  out.push(`No \`[inference:usage]\` lines. Either the B22 build is not deployed yet, or the window has no direct calls.`);
} else {
  const col = BY === "caller" ? "caller" : "day";
  out.push(`| companion | ${col} | calls | usage absent | in (incl cached) | cached | out (incl reasoning) | reasoning | derived $ | unpriced calls | provider-reported $ |`);
  out.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  const keys = [...groups.keys()].sort();
  const tot = { calls: 0, absent: 0, in: 0, cached: 0, out: 0, reasoning: 0, usd: 0, unpriced: 0, reported: 0, reportedN: 0 };
  for (const k of keys) {
    const [c, second] = k.split("\t");
    const g = groups.get(k);
    for (const f of Object.keys(tot)) tot[f] += g[f];
    out.push(`| ${c} | ${second} | ${g.calls} | ${g.absent} | ${g.in} | ${g.cached} | ${g.out} | ${g.reasoning} | ${$(g.usd)} | ${g.unpriced} | ${g.reportedN ? `${$(g.reported)} (${g.reportedN})` : "-"} |`);
  }
  out.push(`| ALL | | ${tot.calls} | ${tot.absent} | ${tot.in} | ${tot.cached} | ${tot.out} | ${tot.reasoning} | ${$(tot.usd)} | ${tot.unpriced} | ${tot.reportedN ? `${$(tot.reported)} (${tot.reportedN})` : "-"} |`);
  const unpricedModels = [...new Set(rows.filter((r) => !r.absent && priceRow(r) === null).map((r) => r.model))];
  if (unpricedModels.length) {
    out.push(``);
    out.push(`Unpriced models (pass --price model=in,out,cached): ${unpricedModels.join(", ")}`);
  }
}
console.log(out.join("\n"));
