#!/usr/bin/env node
/**
 * Read-out for the B37 address-model shadow log (Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md,
 * part E). The bots, with ADDRESS_MODEL=shadow, append to ADDRESS_SHADOW_LOG (default
 * /app/logs/address-shadow.jsonl):
 *   kind:"shadow"  one per classified message, written by the ONE bot that won the Redis claim:
 *                  the regex verdict, the exchange holder, the model's verdict, latency, the bid
 *                  outcome when there was one, plus the message text and recent turns (labelling).
 *   kind:"spoke"   one per companion reply to a human message, written by EVERY bot at send time,
 *                  keyed by the origin message id. Joined here to give the OBSERVED speakers.
 *
 * USAGE (on the VPS):
 *   node scripts/address-shadow-report.mjs                       # all rows
 *   node scripts/address-shadow-report.mjs --days 7 --out /tmp/address-shadow
 *   node scripts/address-shadow-report.mjs --file x.jsonl --min-confidence 0.6
 *
 * Stdout carries ids, verdicts and counts only -- NEVER message text. With --out, the labelling
 * files (`label-disagreements.md` and `.csv`) carry the text and the recent turns so Raziel can
 * mark each disagreement: which one was right, regex or model.
 *
 * Read-only. Never contacts Halseth, Discord, Redis or any model. The log is not rotated (same as
 * jev-shadow.jsonl); a week of shadow is a few hundred rows.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const FILE = flag("--file", process.env.ADDRESS_SHADOW_LOG ?? "/app/logs/address-shadow.jsonl");
const DAYS = Number(flag("--days", "0"));
const MIN_CONF = Number(flag("--min-confidence", "0"));
const OUT = flag("--out", "");

if (!existsSync(FILE)) { console.error(`[address-report] no such file: ${FILE}`); process.exit(1); }
const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;
const shadow = [];
const spokeBy = new Map(); // msg_id -> [companion, ...] in send order
let bad = 0;
for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { bad++; continue; }
  if (since && Date.parse(r.at) < since) continue;
  if (r.kind === "spoke") {
    const list = spokeBy.get(r.msg_id) ?? [];
    if (!list.includes(r.companion)) list.push(r.companion);
    spokeBy.set(r.msg_id, list);
  } else if (r.kind === "shadow") {
    shadow.push(r);
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const q = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const fmtTo = (to) => (Array.isArray(to) ? `[${to.join(",")}]` : String(to));
const regexStr = (r) => (r.regex?.ids?.length ? `${r.regex.type}:${r.regex.ids.join(",")}` : r.regex?.type ?? "?");
const spoke = (r) => spokeBy.get(r.msg_id) ?? (r.spoke_bid ? [r.spoke_bid] : []);

const judged = shadow.filter((r) => r.model && (r.model.confidence ?? 0) >= MIN_CONF);
const lowConf = shadow.filter((r) => r.model && (r.model.confidence ?? 0) < MIN_CONF);
const failed = shadow.filter((r) => !r.model);
const agree = judged.filter((r) => r.agree === true);
const disagree = judged.filter((r) => r.agree === false);

const out = [];
out.push(`# Address model shadow read-out`);
out.push(``);
out.push(`file: \`${FILE}\`  shadow rows: ${shadow.length}  spoke rows joined: ${spokeBy.size}${bad ? `  (${bad} unparseable lines skipped)` : ""}  window: ${DAYS > 0 ? `last ${DAYS} days` : "all"}  min confidence: ${MIN_CONF}`);
if (shadow.length) { const ts = shadow.map((r) => r.at).sort(); out.push(`span: ${ts[0]} to ${ts.at(-1)}`); }
out.push(``);
out.push(`**Agreement mapping** (regex + hold vs model): named X == to [X]; named_multi == same set; group == all three or "room"; ambient with holder H == "continuing" or [H]; ambient, no holder == "room".`);
out.push(`Denominator for every percentage below: shadow rows with a parsed model verdict at or above min confidence (${judged.length}).`);
out.push(``);

out.push(`## Agreement`);
out.push(``);
out.push(`| | rows | share |`);
out.push(`|---|---|---|`);
out.push(`| agree | ${agree.length} | ${pct(agree.length, judged.length)} |`);
out.push(`| disagree | ${disagree.length} | ${pct(disagree.length, judged.length)} |`);
out.push(`| below min confidence (excluded) | ${lowConf.length} | |`);
out.push(`| no verdict (failures) | ${failed.length} | |`);
out.push(``);

out.push(`## By regex verdict`);
out.push(``);
out.push(`| regex | rows | agree | model to=room | model to=continuing | model named someone |`);
out.push(`|---|---|---|---|---|---|`);
const byType = {};
for (const r of judged) (byType[`${r.regex?.type}${r.holder ? "+holder" : ""}`] ??= []).push(r);
for (const [k, g] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  out.push(`| ${k} | ${g.length} | ${g.filter((r) => r.agree).length} (${pct(g.filter((r) => r.agree).length, g.length)}) | ${g.filter((r) => r.model.to === "room").length} | ${g.filter((r) => r.model.to === "continuing").length} | ${g.filter((r) => Array.isArray(r.model.to)).length} |`);
}
out.push(``);

out.push(`## Mention-misread candidates`);
out.push(``);
const misreads = judged.filter((r) => (r.misread ?? []).length > 0);
out.push(`Regex routed to X, model says X is only mentioned (to does not include X): **${misreads.length}** of ${judged.length} (${pct(misreads.length, judged.length)}).`);
const misBy = {};
for (const r of misreads) for (const c of r.misread) misBy[c] = (misBy[c] ?? 0) + 1;
if (Object.keys(misBy).length) out.push(`By companion: ${Object.entries(misBy).map(([k, v]) => `${k}=${v}`).join(", ")}`);
out.push(``);

out.push(`## The exchange hold vs "continuing"`);
out.push(``);
const held = judged.filter((r) => r.holder && r.regex?.type === "ambient");
const cont = held.filter((r) => r.model.to === "continuing" || (Array.isArray(r.model.to) && r.model.to.length === 1 && r.model.to[0] === r.holder));
const room = held.filter((r) => r.model.to === "room");
const other = held.filter((r) => Array.isArray(r.model.to) && !(r.model.to.length === 1 && r.model.to[0] === r.holder));
out.push(`Nameless messages under a hold: ${held.length}. Model kept it with the holder: ${cont.length} (${pct(cont.length, held.length)}); opened it to the room: ${room.length} (${pct(room.length, held.length)}); named someone else: ${other.length}.`);
const holdBy = {};
for (const r of held) { const k = r.holder; holdBy[k] ??= { n: 0, cont: 0 }; holdBy[k].n++; if (cont.includes(r)) holdBy[k].cont++; }
for (const [k, v] of Object.entries(holdBy)) out.push(`- holder ${k}: ${v.n} held, model agreed ${v.cont} (${pct(v.cont, v.n)})`);
out.push(`"continuing" said anywhere (all judged rows): ${judged.filter((r) => r.model.to === "continuing").length}; rows with a holder: ${judged.filter((r) => r.holder).length}.`);
out.push(``);

out.push(`## Latency and failures`);
out.push(``);
const lat = shadow.map((r) => r.latency_ms).filter((x) => Number.isFinite(x));
out.push(`latency p50 ${q(lat, 0.5) ?? "n/a"}ms, p95 ${q(lat, 0.95) ?? "n/a"}ms (n=${lat.length})`);
const reasons = {};
for (const r of failed) reasons[r.failure ?? "?"] = (reasons[r.failure ?? "?"] ?? 0) + 1;
out.push(`failures: ${failed.length}${Object.keys(reasons).length ? ` (${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`);
out.push(``);

out.push(`## Disagreements (ids only; text is in the --out labelling files)`);
out.push(``);
out.push(`| # | at | msg | regex | holder | model to | model mentioned | conf | spoke |`);
out.push(`|---|---|---|---|---|---|---|---|---|`);
disagree.forEach((r, i) => {
  out.push(`| ${i + 1} | ${r.at} | ${r.msg_id} | ${regexStr(r)} | ${r.holder ?? "-"} | ${fmtTo(r.model.to)} | ${(r.model.mentioned ?? []).join(",") || "-"} | ${Number(r.model.confidence).toFixed(2)} | ${spoke(r).join(">") || "?"} |`);
});
out.push(``);
out.push(`"spoke" is observed: the companions whose reply to that message was sent (spoke rows), or the bid's committed speaker when no spoke row exists. "?" = nobody sent, or the row predates the join.`);

const report = out.join("\n");
console.log(report);

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.md"), report + "\n");
  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const md = [
    `# Address model: disagreements to label`,
    ``,
    `For each one, mark who the message was really spoken TO. Put an x in one box.`,
    ``,
  ];
  const csv = [["n", "at", "msg_id", "channel_id", "text", "regex", "holder", "model_to", "model_mentioned", "confidence", "spoke", "right (regex/model/neither)", "really to"].join(",")];
  const cell = (s) => `"${oneLine(s).replace(/"/g, '""')}"`;
  disagree.forEach((r, i) => {
    md.push(`## ${i + 1}. ${r.at} (msg ${r.msg_id})`);
    md.push(``);
    for (const t of r.turns ?? []) md.push(`> **${t.speaker}:** ${oneLine(t.text)}`);
    md.push(`>`);
    md.push(`> **THIS MESSAGE:** ${oneLine(r.text)}`);
    md.push(``);
    md.push(`- regex: \`${regexStr(r)}\`${r.holder ? ` (holder ${r.holder})` : ""}`);
    md.push(`- model: to \`${fmtTo(r.model.to)}\`, mentioned \`${(r.model.mentioned ?? []).join(",") || "-"}\`, confidence ${Number(r.model.confidence).toFixed(2)}`);
    md.push(`- who actually spoke: ${spoke(r).join(" > ") || "nobody / unknown"}`);
    md.push(``);
    md.push(`- [ ] regex was right   - [ ] model was right   - [ ] neither; really to: ____`);
    md.push(``);
    csv.push([i + 1, r.at, r.msg_id, r.channel_id, cell(r.text), regexStr(r), r.holder ?? "", fmtTo(r.model.to), (r.model.mentioned ?? []).join(" "), Number(r.model.confidence).toFixed(2), spoke(r).join(">"), "", ""].join(","));
  });
  writeFileSync(join(OUT, "label-disagreements.md"), md.join("\n") + "\n");
  writeFileSync(join(OUT, "label-disagreements.csv"), csv.join("\n") + "\n");
  console.error(`[address-report] wrote ${join(OUT, "report.md")}, label-disagreements.md and .csv (${disagree.length} rows; these files contain message text)`);
}
