#!/usr/bin/env node
/**
 * Room timing read-out (2026-10-31, packages/shared/src/room-timing.ts). READ-ONLY.
 *
 * Joins the shadow decisions in /app/logs/room-timing.jsonl to who actually spoke (address-shadow's
 * `spoke` rows, by msg_id), so one movie night answers: how many lines would each companion have held,
 * and how many of those did it answer anyway (the interruptions the live cut would remove).
 *
 *   node scripts/room-timing-report.mjs --days 2
 *   node scripts/room-timing-report.mjs --since 2026-11-01T00:00:00Z
 *
 * Text never enters these logs; the report prints counts and message ids only.
 */
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const since = opt("--since") ? Date.parse(opt("--since")) : Date.now() - Number(opt("--days", "2")) * 86_400_000;
const TIMING = process.env.ROOM_TIMING_LOG || "/app/logs/room-timing.jsonl";
const ADDRESS = process.env.ADDRESS_SHADOW_LOG || "/app/logs/address-shadow.jsonl";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const rows = read(TIMING).filter((r) => Date.parse(r.at) >= since);
const spoke = new Map();
for (const r of read(ADDRESS)) if (r.kind === "spoke" && Date.parse(r.at) >= since) {
  const s = spoke.get(r.msg_id) ?? new Set(); s.add(r.companion ?? r.runner); spoke.set(r.msg_id, s);
}

const decisions = rows.filter((r) => r.kind === "decision");
const gates = rows.filter((r) => r.kind === "reply_gate");
console.log(`# Room timing (shadow)\n\nwindow since ${new Date(since).toISOString()} -- ${decisions.length} decisions, ${gates.length} reply-gate rows\n`);

for (const c of ["drevan", "cypher", "gaia"]) {
  const mine = decisions.filter((r) => r.companion === c);
  if (!mine.length) continue;
  console.log(`## ${c} (${mine.length} human lines)\n\n| decision | reason | lines | it spoke anyway |\n|---|---|---|---|`);
  const key = (r) => `${r.decision}|${r.reason}`;
  const groups = new Map();
  for (const r of mine) { const k = key(r); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  for (const [k, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const [d, why] = k.split("|");
    const did = rs.filter((r) => spoke.get(r.msg_id)?.has(c)).length;
    console.log(`| ${d} | ${why} | ${rs.length} | ${d === "answer_now" ? "-" : did} |`);
  }
  const held = mine.filter((r) => r.decision !== "answer_now");
  // A cold Blue line (no holder) can be answered by BLUE_COLD_PICK after the row is written: that pick is
  // the system working, not an interruption, so it is counted apart.
  const interruptions = held.filter((r) => spoke.get(r.msg_id)?.has(c) && !r.cold);
  const coldPicks = held.filter((r) => spoke.get(r.msg_id)?.has(c) && r.cold);
  console.log(`\nWould have held ${held.length}; spoke on ${interruptions.length} of them (what the live cut removes or batches to the lull), plus ${coldPicks.length} cold Blue picks.`);
  console.log(`Reaction offered on ${mine.filter((r) => r.react).length}.\n`);
}

if (gates.length) {
  console.log(`## Reply to the other human (REPLY_HUMAN_GATE=shadow)\n`);
  for (const c of ["drevan", "cypher", "gaia"]) {
    const g = gates.filter((r) => r.companion === c);
    if (g.length) console.log(`- ${c}: ${g.length} replies would have been left to the humans; spoke on ${g.filter((r) => spoke.get(r.msg_id)?.has(c)).length}`);
  }
}

// Live cut (ROOM_TIMING=on, 2026-11-01): what happened to each held line. `released` = answered once at the
// lull; `dropped:other_human` = the other human answered inside the burst (it was theirs); `self_spoke` =
// this companion spoke anyway (named on a later line); `replaced` = a newer held line took its place (one
// answer per burst); `stale` = the lull came more than 5 minutes after the line.
const lulls = rows.filter((r) => r.kind === "lull");
if (lulls.length) {
  console.log(`## Live holds (ROOM_TIMING=on)\n\n| companion | outcome | count | median age at outcome (s) |\n|---|---|---|---|`);
  for (const c of ["drevan", "cypher", "gaia"]) {
    const mine = lulls.filter((r) => r.companion === c);
    const by = new Map();
    for (const r of mine) (by.get(r.outcome) ?? by.set(r.outcome, []).get(r.outcome)).push(r.age_s ?? 0);
    for (const [o, ages] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      const s = ages.slice().sort((a, b) => a - b);
      console.log(`| ${c} | ${o} | ${ages.length} | ${s[Math.floor(s.length / 2)]} |`);
    }
  }
}
