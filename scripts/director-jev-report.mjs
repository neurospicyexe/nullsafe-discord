#!/usr/bin/env node
/**
 * Read-out for the director's Jev shadow (shared/src/director-jev.ts, 2026-10-13). The worker
 * appends to DIRECTOR_JEV_LOG (default /app/logs/director-jev.jsonl):
 *   kind:"decide"  per commons message the director decided on: its pick beside Jev's
 *                  next_speaker / thread_has_more / echoing
 *   kind:"turn"    every commons turn ingested: who ACTUALLY spoke
 *   kind:"invite"  an invitation issued;  kind:"result"  how it ended (spoke / pass / expired / empty)
 *
 * Three questions, no hand labels needed for the first two:
 *   1. next_speaker: does Jev's pick match who actually spoke next (within --next-window, 10 min)?
 *      Scored beside the director's own hit rate on the same rows, so neither is taken as truth.
 *   2. #6 invitation uptake: for each issued invite, did thread_has_more (asked on the decide that
 *      issued it) predict spoke vs pass/expired?
 *   3. echoing (#12 over-talked): distribution, and whether high echo precedes a fade/no-uptake.
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

out.push(`# Director Jev shadow`);
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
out.push(`## 1. Who should speak next (truth: who actually spoke within ${NEXT_S}s)`);
out.push(``);
if (!scored.length) out.push(`No scorable rows yet.`);
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

// 2. #6 invitation uptake ----------------------------------------------------
out.push(`## 2. Invitation uptake (#6: does thread_has_more predict spoke vs pass?)`);
out.push(``);
const live = invites.filter((i) => i.mode === "live" && results.has(i.invite_id));
if (!live.length) out.push(`No resolved live invitations yet.`);
else {
  // The decide row for an invite: same channel, director picked that companion, closest before it.
  const decideFor = (inv) => decides.filter((d) => d.channel_id === inv.channel_id && d.jev && d.director.kind === "invite" && d.director.companion === inv.companion && Date.parse(d.at) <= Date.parse(inv.at) + 10_000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const paired = live.map((inv) => ({ inv, res: results.get(inv.invite_id), d: decideFor(inv) })).filter((x) => x.d && typeof x.d.jev.threadHasMore === "number");
  const spoke = paired.filter((x) => x.res.outcome === "spoke");
  const not = paired.filter((x) => x.res.outcome !== "spoke");
  const mean = (xs) => (xs.length ? (xs.reduce((s, x) => s + x.d.jev.threadHasMore, 0) / xs.length).toFixed(2) : "n/a");
  out.push(`- resolved live invites: ${live.length}; paired with a Jev decide: ${paired.length}; spoke ${spoke.length}, pass/expired/empty ${not.length}`);
  out.push(`- mean thread_has_more when the invitee spoke: ${mean(spoke)}; when it did not: ${mean(not)} (a gap is the signal)`);
  const lowSaid = paired.filter((x) => x.d.jev.threadHasMore < 0.3);
  out.push(`- thread_has_more < 0.3 (Jev would not invite): ${lowSaid.length}; of those the invitee passed or let it expire: ${lowSaid.filter((x) => x.res.outcome !== "spoke").length}`);
  const oc = {};
  for (const x of paired) oc[x.res.outcome] = (oc[x.res.outcome] ?? 0) + 1;
  out.push(`- outcomes: ${Object.entries(oc).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
out.push(``);

// 3. echoing (#12 over-talked) -----------------------------------------------
out.push(`## 3. Echoing (#12: are the companions restating each other?)`);
out.push(``);
const ech = ok.filter((d) => typeof d.jev.echoing === "number");
if (!ech.length) out.push(`No rows yet.`);
else {
  const hi = ech.filter((d) => d.jev.echoing >= 0.5);
  out.push(`- echoing >= 0.5: ${hi.length} of ${ech.length} (${pct(hi.length, ech.length)})`);
  out.push(`- of those, the director stayed silent (budget / no_uptake / nothing_to_add): ${hi.filter((d) => d.director.kind === "silence").length}; it invited anyway: ${hi.filter((d) => d.director.kind === "invite").length}`);
  out.push(`- by bot turns into the thread: ${[[0, 4], [4, 8], [8, 99]].map(([a, b]) => { const g = ech.filter((d) => d.bot_turns >= a && d.bot_turns < b); return `${a}-${b === 99 ? "+" : b - 1}: ${pct(g.filter((d) => d.jev.echoing >= 0.5).length, g.length)} of ${g.length}`; }).join("; ")}`);
}
out.push(``);

const fails = decides.filter((d) => !d.jev);
const fr = {};
for (const d of fails) fr[d.jev_failure] = (fr[d.jev_failure] ?? 0) + 1;
const wall = decides.map((d) => d.jev_wall_ms).filter((x) => Number.isFinite(x));
out.push(`Failures: ${fails.length}${fails.length ? ` (${Object.entries(fr).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}. Wall p50 ${q(wall, 0.5) ?? "n/a"}ms, p95 ${q(wall, 0.95) ?? "n/a"}ms.`);
console.log(out.join("\n"));
