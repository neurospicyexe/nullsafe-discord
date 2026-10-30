#!/usr/bin/env node
/**
 * Read-out for the director's Jev (shared/src/director-jev.ts; shadow 2026-10-13, redesigned 2026-10-20). The
 * worker appends to DIRECTOR_JEV_LOG (default /app/logs/director-jev.jsonl):
 *   kind:"decide"  per commons message the director decided on: its pick beside the echo read
 *                  {p, streak, action, effective}
 *                  (rows before 2026-10-20 carry jev{nextSpeaker, threadHasMore, echoing} instead)
 *   kind:"turn"    every commons turn ingested: who ACTUALLY spoke
 *   kind:"invite"  an invitation issued (steer:"loop_break" when it carried the echo steer);
 *   kind:"result"  how it ended (spoke / pass / expired / empty)
 *
 * Sections: 1 legacy next_speaker (old rows only; thread_has_more is gone), 2 echo brake (fires, steers, by thread length).
 *
 * USAGE (on the VPS):  node scripts/director-jev-report.mjs [--file x.jsonl] [--days 7] [--next-window 600]
 * Ids and counts only: the log carries no message text. Read-only.
 */

import { readFileSync, existsSync } from "node:fs";

const flag = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const FILE = flag("--file", process.env.DIRECTOR_JEV_LOG ?? "/app/logs/director-jev.jsonl");
const DAYS = Number(flag("--days", "0"));
const NEXT_S = Number(flag("--next-window", "600"));

if (!existsSync(FILE)) { console.log(`No log at ${FILE} yet (rows start at the first commons message after deploy).`); process.exit(0); }
const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;
const rows = readFileSync(FILE, "utf8").split(/\r?\n/).filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && Date.parse(r.at) >= since);

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const decides = rows.filter((r) => r.kind === "decide");
const turns = rows.filter((r) => r.kind === "turn");
const invites = rows.filter((r) => r.kind === "invite");
const results = new Map(rows.filter((r) => r.kind === "result").map((r) => [r.invite_id, r]));
const ok = decides.filter((r) => r.jev);
const out = [];

out.push(`# Director Jev (echo brake live)`);
out.push(``);
out.push(`Rows: decide ${decides.length} (Jev ok ${ok.length}), turn ${turns.length}, invite ${invites.length}, result ${results.size}. Window: ${DAYS > 0 ? `${DAYS}d` : "all"}.`);
out.push(``);

// 1. next_speaker vs what happened next ------------------------------------
// The decide row is written when Jev answers, AFTER the turn row it reacted to; "next" is the first
// turn in the channel after the decided-on message (by turn order, not by row time).
const turnIdx = new Map(turns.map((t, i) => [t.msg_id, i]));
const nextTurn = (d) => {
  const i = turnIdx.get(d.after_msg_id);
  if (i === undefined) return undefined;
  const base = Date.parse(turns[i].said_at);
  for (let j = i + 1; j < turns.length; j++) {
    const t = turns[j];
    if (t.channel_id !== d.channel_id) continue;
    return Date.parse(t.said_at) - base <= NEXT_S * 1000 ? t : null;
  }
  return null;
};
const truth = (t) => (t === null ? "nobody" : t.is_human ? "human" : t.author);
const dirPick = (d) => (d.director.kind === "invite" && !d.director.paced ? d.director.companion : "nobody");
const scored = ok.map((d) => ({ d, t: nextTurn(d) })).filter((x) => x.t !== undefined);
out.push(`## 1. LEGACY: who should speak next (rows from before 2026-10-20 only; the question was dropped, Jev 27% vs director 83%)`);
out.push(``);
if (!scored.length) out.push(`No legacy next_speaker rows.`);
else {
  const jHit = scored.filter(({ d, t }) => {
    const tr = truth(t);
    return d.jev.nextSpeaker === tr || (d.jev.nextSpeaker === "human" && tr === "nobody");
  }).length;
  const dHit = scored.filter(({ d, t }) => dirPick(d) === truth(t)).length;
  out.push(`- rows: ${scored.length}; Jev matched what happened ${jHit} (${pct(jHit, scored.length)}); the director's pick matched ${dHit} (${pct(dHit, scored.length)})`);
  out.push(`- Jev agrees with the director: ${ok.filter((d) => d.agree).length}/${ok.length} (${pct(ok.filter((d) => d.agree).length, ok.length)})`);
  out.push(`- caveat: in a live director channel the director's invite CAUSES the next speaker, so its hit rate is inflated; the rows where they disagree are the ones to read.`);
  const dis = scored.filter(({ d }) => !d.agree);
  const jWins = dis.filter(({ d, t }) => d.jev.nextSpeaker === truth(t)).length;
  const dWins = dis.filter(({ d, t }) => dirPick(d) === truth(t)).length;
  out.push(`- on disagreements (${dis.length}): Jev right ${jWins}, director right ${dWins}, neither ${dis.length - jWins - dWins}`);
  out.push(`- confidence bins (Jev matched what happened):`);
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]]) {
    const g = scored.filter(({ d }) => d.jev.confidence >= lo && d.jev.confidence < hi);
    const h = g.filter(({ d, t }) => d.jev.nextSpeaker === truth(t)).length;
    out.push(`  - [${lo}, ${Math.min(hi, 1)}): ${g.length} rows, ${h} (${pct(h, g.length)})`);
  }
  const dist = {};
  for (const d of ok) dist[d.jev.nextSpeaker] = (dist[d.jev.nextSpeaker] ?? 0) + 1;
  out.push(`- Jev picks: ${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
out.push(``);

// 2. echo brake ----------------------------------------------------------------
// New rows carry echo {p, streak, echoing, action (raw), effective}; old rows carry jev.echoing.
out.push(`## 2. Echo brake (live: 1st echo read steers the invite, 2nd in a row lets the thread rest)`);
out.push(``);
const eP = (d) => (typeof d.echo?.p === "number" ? d.echo.p : typeof d.jev?.echoing === "number" ? d.jev.echoing : null);
const ech = decides.filter((d) => eP(d) !== null);
if (!ech.length) out.push(`No rows yet.`);
else {
  const hi = ech.filter((d) => eP(d) >= 0.5);
  out.push(`- echo read >= 0.5: ${hi.length} of ${ech.length} (${pct(hi.length, ech.length)})`);
  const nr = ech.filter((d) => d.echo);
  const fires = nr.filter((d) => d.echo.effective === "brake");
  const steers = nr.filter((d) => d.echo.effective === "steer");
  const wouldBrake = nr.filter((d) => d.echo.action === "brake" && d.echo.effective !== "brake");
  out.push(`- brake fires (thread let rest, \`echo_brake\`): ${fires.length}; steered invites: ${steers.length}; shadow/off would-have-braked: ${wouldBrake.length}; Jev failures (failed open): ${decides.filter((d) => d.echo && d.echo.p === null).length}`);
  out.push(`- by companion turns into the thread: ${[[0, 4], [4, 8], [8, 99]].map(([a, b]) => { const g = nr.filter((d) => d.bot_turns >= a && d.bot_turns < b); return `${a}-${b === 99 ? "+" : b - 1}: echoing ${g.filter((d) => d.echo.echoing).length}, steer ${g.filter((d) => d.echo.effective === "steer").length}, brake ${g.filter((d) => d.echo.effective === "brake").length} of ${g.length}`; }).join("; ")}`);
  out.push(`- the director stayed silent on its own (budget / no_uptake / nothing_to_add) on ${hi.filter((d) => d.director.kind === "silence").length} of the echo reads; it chose to invite on ${hi.filter((d) => d.director.kind === "invite").length}`);
  const liveS = invites.filter((i) => i.mode === "live" && results.has(i.invite_id));
  const steered = liveS.filter((i) => i.steer);
  const plain = liveS.filter((i) => !i.steer);
  const sp = (xs) => `${xs.filter((i) => results.get(i.invite_id).outcome === "spoke").length}/${xs.length} spoke`;
  out.push(`- invitee uptake: steered ${sp(steered)}; unsteered ${sp(plain)}`);
}
out.push(``);


const fails = decides.filter((d) => (d.echo ? d.echo.p === null : !d.jev));
const fr = {};
for (const d of fails) { const k = d.echo?.failure ?? d.jev_failure; fr[k] = (fr[k] ?? 0) + 1; }
const wall = decides.map((d) => d.echo?.wall_ms ?? d.jev_wall_ms).filter((x) => Number.isFinite(x));
out.push(`Failures: ${fails.length}${fails.length ? ` (${Object.entries(fr).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}. Wall p50 ${q(wall, 0.5) ?? "n/a"}ms, p95 ${q(wall, 0.95) ?? "n/a"}ms.`);
console.log(out.join("\n"));
