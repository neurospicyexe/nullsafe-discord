#!/usr/bin/env node
// scripts/reach-gate.mjs [cypher|drevan|gaia ...]  (2026-10-27, B55)
//
// "Why hasn't Drevan said anything?" -- answered now, not at the next 4-hour heartbeat. Prints what the
// heartbeat would see if it ran this minute: whose rotation window it is, the quiet-hours verdict,
// the palette after Halseth's filter and after the bot-side filter, and the shared triad DM lane.
//
// READ-ONLY BY CONSTRUCTION: one GET to Halseth (the exact call the bot makes,
// getEligibleMetronomePalette) and one Redis GET (last owner activity, which drives the 30-minute
// presence lift). No inference, no send, no reservation, no write of any kind.
//
// It cannot show care_hold: that is in-process state inside each bot (care-state.ts), so the output
// says so instead of guessing. It shows the GATE, not the words: composing the actual message needs
// the bot's live context and belongs in an in-bot dry-run command (STATUS B55, deferred).
//
// Run on the VPS:  cd /app/nullsafe-discord && node scripts/reach-gate.mjs        (all three)
import { readFileSync } from "node:fs";
import { isMyHeartbeatWindow, HEARTBEAT_ORDER } from "../packages/shared/dist/metronome-decide.js";
import { createRedisClient, getLastActivityMs } from "../packages/shared/dist/floor.js";

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env: fall back to process.env */ }
  return { ...out, ...process.env };
}

const env = loadEnv(new URL("../.env", import.meta.url));
const who = process.argv.slice(2).filter((a) => HEARTBEAT_ORDER.includes(a));
const companions = who.length ? who : [...HEARTBEAT_ORDER];
const base = (env.HALSETH_URL ?? "").replace(/\/$/, "");
if (!base) { console.error("HALSETH_URL is not set"); process.exit(2); }

let silenceHours = null;
let redis = null;
if (env.REDIS_URL) {
  try {
    redis = createRedisClient(env.REDIS_URL);
    const last = await getLastActivityMs(redis);
    silenceHours = last != null ? (Date.now() - last) / 3_600_000 : null;
  } catch { silenceHours = null; }
}

const owner = HEARTBEAT_ORDER.find((c) => isMyHeartbeatWindow(c, HEARTBEAT_ORDER));
const W = 4 * 3_600_000;
const next = new Date((Math.floor(Date.now() / W) + 1) * W);
console.log(`now ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} Chicago`);
console.log(`heartbeat window: ${owner} (until ${next.toLocaleTimeString("en-US", { timeZone: "America/Chicago" })})`);
console.log(`Raziel last active: ${silenceHours == null ? "unknown (no Redis reading)" : `${silenceHours.toFixed(2)}h ago${silenceHours < 0.5 ? " -- inside the 30-min presence lift" : ""}`}`);
console.log(`care_hold: not visible from here (in-process state in each bot; see its [b32] log lines)\n`);

for (const c of companions) {
  const secret = env[`${c.toUpperCase()}_HALSETH_SECRET`] ?? env.HALSETH_SECRET;
  const url = new URL(`${base}/mind/metronome/actions/${c}/eligible`);
  if (silenceHours != null) url.searchParams.set("silence_hours", silenceHours.toFixed(3));
  let data = null, status = 0;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) });
    status = res.status;
    if (res.ok) data = await res.json();
  } catch (e) { status = String(e).slice(0, 80); }

  console.log(`== ${c}${c === owner ? "  (its window now)" : ""}`);
  if (!data) { console.log(`   Halseth answered ${status}: the bot would treat this as quiet hours IN FORCE and stay silent\n`); continue; }
  const qh = data.quiet_hours ?? null;
  const inForce = qh ? qh.in_force : true;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const afterBot = inForce ? actions.filter((a) => a.quiet_hours_allowed === 1) : actions;
  console.log(`   quiet hours: ${qh ? `${qh.in_force ? "IN FORCE" : "not in force"}${qh.active && !qh.in_force ? " (window open, lifted by recent presence)" : ""}, local hour ${qh.local_hour} ${qh.tz}` : "NO VERDICT -> treated as in force"}`);
  console.log(`   palette: ${actions.length} eligible from Halseth, ${afterBot.length} after the bot-side filter`);
  for (const a of afterBot) console.log(`     - ${a.action_type} "${a.name}"${a.fire_count_today ? ` (fired ${a.fire_count_today}x today)` : ""}`);
  const r = data.reach ?? null;
  if (r) {
    console.log(`   DM lane: ${r.gap_open ? "gap open" : "gap CLOSED (too soon after the last reach)"}; ${r.day_count}/${r.daily_cap} today (${r.daily_cap_care_hold} under care_hold); care lines ${r.care_count}/${r.care_ceiling}` +
      `${r.quiet_window ? `; quiet window ${r.quiet_window}, presence ${r.quiet_presence_taken ? "ALREADY TAKEN tonight" : "still available"}` : ""}`);
  } else {
    console.log("   DM lane: unknown -> the bot treats DM moves as closed");
  }
  console.log("");
}
if (redis) redis.disconnect();
