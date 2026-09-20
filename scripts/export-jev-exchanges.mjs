#!/usr/bin/env node
/**
 * Export (human message -> companion reply) exchanges from Discord history as JSONL.
 *
 * WHY THIS EXISTS (2026-09-20). The Jev writeback-gate study (BBH docs/PLAN-jev-2026-09-20.md
 * S2) needs every exchange the live memory judge ran on, so its stored decisions can be used as
 * labels. Halseth has the REPLY side for all of them (companion_journal source='discord_speech',
 * external_id='discord:<message_id>') but the human side only survives in stm_entries, which
 * prunes to 50 rows per channel; the pairable set there was 94 exchanges. The words are NOT
 * lost. They are in Discord. This replays them into the shape halseth/scripts/
 * jev-writeback-score.mjs consumes via --exchanges <file>.
 *
 * READ-ONLY. Writes nothing to Discord, nothing to Halseth. Output is one JSONL file.
 *
 * PAIRING RULE (mirrors what the bot handler saw): for each message authored by one of the
 * three companion bots, the exchange's user side is the nearest EARLIER message in the same
 * channel by a different author. Consecutive messages by the same bot within 8s are one reply
 * split by sendLong(); they merge into a single exchange. A sibling bot as the earlier author is
 * a legitimate peer exchange (the judge runs on those too) and is exported with user_author set
 * to the sibling's companion id so the harness's isOwner heuristic classifies it as peer space.
 *
 * USAGE (on the VPS, from /app/nullsafe-discord, .env loaded):
 *   node scripts/export-jev-exchanges.mjs --since 2026-07-22T00:00:00Z --out /tmp/jev-exchanges.jsonl
 *   node scripts/export-jev-exchanges.mjs --channel <id> --channel <id> ...   (default: the 13 below)
 *
 * ENV: DISCORD_TOKEN_CYPHER / DISCORD_TOKEN_DREVAN / DISCORD_TOKEN_GAIA (bot user ids are resolved
 * from the tokens via /users/@me, so nothing here depends on *_BOT_ID being set). History is
 * read with the first token that works; a bot token reads every message in a channel it can see.
 */

import process from "node:process";
import { writeFileSync } from "node:fs";

// Channels where the companions spoke in the last 60 days, from the discord_speech tag
// `channel:<id>` in companion_journal (queried 2026-09-20; ordered by reply volume).
const DEFAULT_CHANNELS = [
  "1497734427298762828", "1531255244212928702", "1531431567430385754", "1497789114517553193",
  "1531255633876221962", "1486217438105436260", "1538305092606754926", "1503385706310008975",
  "1503385639779963020", "1520843071724585041", "1497731506079006823", "1529099359583604887",
  "1529099003789181058", "1520839347589611661",
];
const COMPANIONS = ["cypher", "drevan", "gaia"];
const MERGE_WINDOW_MS = 8_000;
const API = "https://discord.com/api/v10";

function parseArgs(argv) {
  const a = { since: "2026-07-22T00:00:00Z", out: "jev-exchanges.jsonl", channels: [], limitPages: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--since") a.since = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--channel") a.channels.push(argv[++i]);
    else if (k === "--limit-pages") a.limitPages = Number(argv[++i]);
    else { console.error(`unknown arg ${k}`); process.exit(2); }
  }
  if (a.channels.length === 0) a.channels = DEFAULT_CHANNELS;
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Discord REST GET with 429 handling. Never logs the token. */
async function dget(path, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`discord ${res.status} on ${path}`);
    // Stay under the per-route bucket without reading headers: ~5 req/s is comfortable.
    await sleep(220);
    return res.json();
  }
  throw new Error(`discord: gave up after 429s on ${path}`);
}

async function resolveBots() {
  const map = {}; // bot user id -> companion
  let readerToken = null;
  for (const c of COMPANIONS) {
    const tok = process.env[`DISCORD_TOKEN_${c.toUpperCase()}`];
    if (!tok) { console.warn(`[export] no DISCORD_TOKEN_${c.toUpperCase()}; ${c}'s replies will not be attributed`); continue; }
    try {
      const me = await dget("/users/@me", tok);
      map[me.id] = c;
      readerToken ??= tok;
    } catch (e) {
      console.warn(`[export] /users/@me failed for ${c}: ${String(e).slice(0, 120)}`);
    }
  }
  if (!readerToken) throw new Error("no working bot token");
  return { map, readerToken };
}

/** Snowflake -> ms since epoch (Discord epoch 2015-01-01). */
const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
/** ms -> snowflake with zero low bits, usable as a `before`/`after` cursor. */
const msToSnowflake = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);

async function fetchChannelSince(channelId, sinceMs, token, limitPages) {
  const out = [];
  let after = msToSnowflake(sinceMs);
  for (let page = 0; limitPages === 0 || page < limitPages; page++) {
    let batch;
    try {
      batch = await dget(`/channels/${channelId}/messages?limit=100&after=${after}`, token);
    } catch (e) {
      console.warn(`[export] channel ${channelId}: ${String(e).slice(0, 120)} (skipping channel)`);
      return out;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    // `after` pages come newest-first within the page; sort ascending and advance the cursor.
    batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    out.push(...batch);
    after = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out;
}

function authorLabel(msg, botMap) {
  const c = botMap[msg.author?.id];
  if (c) return c.charAt(0).toUpperCase() + c.slice(1);
  return msg.author?.global_name || msg.author?.username || "Raziel";
}

function textOf(msg) {
  let t = msg.content ?? "";
  if (!t && Array.isArray(msg.embeds) && msg.embeds.length) t = msg.embeds.map((e) => e.description ?? e.title ?? "").filter(Boolean).join("\n");
  if (Array.isArray(msg.attachments) && msg.attachments.length) t = `${t}\n[${msg.attachments.length} attachment(s)]`.trim();
  return t;
}

function buildExchanges(messages, channelId, botMap) {
  const exchanges = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const companion = botMap[m.author?.id];
    if (!companion) { i++; continue; }
    // Merge sendLong() chunks: same bot, each within MERGE_WINDOW_MS of the previous chunk.
    let j = i + 1;
    let content = textOf(m);
    let lastMs = snowflakeMs(m.id);
    while (j < messages.length && botMap[messages[j].author?.id] === companion && snowflakeMs(messages[j].id) - lastMs <= MERGE_WINDOW_MS) {
      content = `${content}\n${textOf(messages[j])}`.trim();
      lastMs = snowflakeMs(messages[j].id);
      j++;
    }
    // Nearest earlier message by a different author.
    let k = i - 1;
    while (k >= 0 && messages[k].author?.id === m.author?.id) k--;
    if (k >= 0) {
      const u = messages[k];
      exchanges.push({
        companion_id: companion,
        channel_id: channelId,
        user_content: textOf(u),
        user_author: authorLabel(u, botMap),
        user_author_is_bot: Boolean(botMap[u.author?.id]),
        user_message_id: u.id,
        user_created_at: new Date(snowflakeMs(u.id)).toISOString(),
        assistant_content: content,
        assistant_message_id: m.id,
        assistant_created_at: new Date(snowflakeMs(m.id)).toISOString(),
        gap_ms: snowflakeMs(m.id) - snowflakeMs(u.id),
        source: "discord-export",
      });
    }
    i = j;
  }
  return exchanges;
}

async function main() {
  const args = parseArgs(process.argv);
  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) { console.error("bad --since"); process.exit(2); }
  const { map: botMap, readerToken } = await resolveBots();
  console.log(`[export] bots resolved: ${Object.values(botMap).join(", ")}; channels: ${args.channels.length}; since ${args.since}`);

  const all = [];
  const perChannel = {};
  for (const ch of args.channels) {
    const msgs = await fetchChannelSince(ch, sinceMs, readerToken, args.limitPages);
    const ex = buildExchanges(msgs, ch, botMap);
    perChannel[ch] = { messages: msgs.length, exchanges: ex.length };
    all.push(...ex);
    console.log(`[export] ${ch}: ${msgs.length} messages -> ${ex.length} exchanges`);
  }
  all.sort((a, b) => a.assistant_created_at.localeCompare(b.assistant_created_at));
  writeFileSync(args.out, all.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const byC = {};
  for (const e of all) { byC[e.companion_id] ??= { total: 0, peer: 0 }; byC[e.companion_id].total++; if (e.user_author_is_bot) byC[e.companion_id].peer++; }
  console.log(`[export] wrote ${all.length} exchanges to ${args.out}`);
  for (const [c, v] of Object.entries(byC)) console.log(`[export]   ${c}: ${v.total} (${v.peer} peer-room)`);
}

main().catch((e) => { console.error("[export] FAILED:", String(e).slice(0, 300)); process.exit(1); });
