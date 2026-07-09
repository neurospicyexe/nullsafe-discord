#!/usr/bin/env node
/**
 * Backfill companion speech into companion_journal (2026-07-09).
 *
 * WHAT HAPPENED
 * -------------
 * Brain's swarm evaluator was the only writer of companion_journal source='discord_swarm'.
 * On 2026-06-25 the bots moved to INFERENCE_MODE=hermes, stopped calling Brain, and the writer
 * died with the relay. From 2026-06-25T21:33Z onward, nothing the companions said to each other
 * reached the journal -- so it is absent from tag search, journal embeddings, and every
 * retrieval surface built on them.
 *
 * The words are NOT lost. They are in Discord. This replays them.
 *
 * SAFETY
 * ------
 * Idempotent by construction: each row is keyed on `external_id = discord:<message_id>`
 * (halseth mig 0098, partial unique index). A repeat POST is a server-side no-op returning
 * { skipped: true }. So a crash, a rate-limit, or a nervous second run cannot duplicate
 * anything. There is no local checkpoint file to corrupt.
 *
 * Rows land in the CHATTER lane (source='discord_speech'): embedded and searchable, but barred
 * from orient's 3 recency slots and the motif miner. Backfilling ~1000 rows of transcript into
 * the substantive lane would drown two weeks of authored reflection at boot -- which is the bug
 * this whole repair exists to fix. Transport metadata goes in tags, never in note_text.
 *
 * USAGE
 *   node scripts/backfill-speech-journal.mjs --dry-run          # count only, writes nothing
 *   node scripts/backfill-speech-journal.mjs --since 2026-06-25T21:33:21Z
 *   node scripts/backfill-speech-journal.mjs --channel <id> --channel <id>
 *
 * ENV: DISCORD_BOT_TOKEN (any one bot token can read history), HALSETH_URL, HALSETH_SECRET
 *
 * Run it ONCE per companion bot user id you want to capture -- or leave --bot unset to capture
 * all three, which is the normal case (a bot token can read every message in a channel it sees,
 * regardless of author).
 */

import process from "node:process";

const DEFAULT_SINCE = "2026-06-25T21:33:21.322Z"; // last surviving discord_swarm row

// Channels the swarm actually spoke in, derived from the dead-era rows themselves: every
// discord_swarm entry begins "[discord:swarm] channel:<id>", so the corpus records its own
// scope. Used when --channel is omitted. (Ordered by volume over the live window.)
const SWARM_CHANNELS = [
  "1503385639779963020", // 741 rows
  "1497731506079006823", // 176
  "1497734427298762828", // 140
  "1497789114517553193", // 19
  "1503385706310008975", // 12
];

// Bot user id -> companion. A reply is journaled under the companion who SAID it; attribution
// is sacred, and a wrong `agent` fabricates one companion's speech into another's memory.
// Reads the VPS's existing *_BOT_ID names, with *_BOT_USER_ID accepted as an alias.
const botId = (c) => process.env[`${c}_BOT_ID`] ?? process.env[`${c}_BOT_USER_ID`] ?? "";
const BOT_USER_TO_COMPANION = {
  [botId("CYPHER")]: "cypher",
  [botId("DREVAN")]: "drevan",
  [botId("GAIA")]: "gaia",
};

function parseArgs(argv) {
  const args = { dryRun: false, since: DEFAULT_SINCE, channels: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--channel") args.channels.push(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

/** Discord snowflake -> ms since epoch. Lets us stop paging without parsing every timestamp. */
const snowflakeToMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

async function discord(path, token) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      if (attempt > 8) throw new Error("rate limited too many times");
      await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`discord ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

/** Page backwards through a channel until we pass `sinceMs`. Discord returns newest-first. */
async function* channelMessages(channelId, token, sinceMs) {
  let before;
  for (;;) {
    const q = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
    const batch = await discord(`/channels/${channelId}/messages?${q}`, token);
    if (batch.length === 0) return;
    for (const m of batch) {
      if (snowflakeToMs(m.id) <= sinceMs) return;
      yield m;
    }
    before = batch[batch.length - 1].id;
  }
}

async function journal(entry, halsethUrl, secret) {
  const res = await fetch(`${halsethUrl}/companion-journal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`halseth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv);
  // Any one bot token can read a channel's full history, regardless of who authored each
  // message -- so one token captures all three companions' speech.
  const token =
    process.env.DISCORD_BOT_TOKEN ??
    process.env.DISCORD_TOKEN_CYPHER ??
    process.env.DISCORD_TOKEN_DREVAN ??
    process.env.DISCORD_TOKEN_GAIA;
  if (!token) throw new Error("missing env: DISCORD_TOKEN_CYPHER (or DISCORD_BOT_TOKEN)");
  const halsethUrl = need("HALSETH_URL").replace(/\/$/, "");
  const secret = need("HALSETH_SECRET");

  const knownBots = Object.entries(BOT_USER_TO_COMPANION).filter(([id]) => id);
  if (knownBots.length !== 3) {
    throw new Error(
      "need CYPHER_BOT_ID, DREVAN_BOT_ID and GAIA_BOT_ID (all three) -- attribution is sacred, " +
      "and journaling a reply under the wrong companion fabricates their memory. Refusing a " +
      "partial run rather than silently skipping a companion's speech.",
    );
  }
  if (args.channels.length === 0) args.channels = [...SWARM_CHANNELS];

  const sinceMs = Date.parse(args.since);
  if (!Number.isFinite(sinceMs)) throw new Error(`bad --since: ${args.since}`);

  console.log(`[backfill] since=${args.since} channels=${args.channels.length} dryRun=${args.dryRun}`);
  console.log(`[backfill] attributing: ${knownBots.map(([, c]) => c).join(", ")}`);

  const stats = { seen: 0, matched: 0, written: 0, skipped: 0, failed: 0 };

  for (const channelId of args.channels) {
    // Per-channel deltas: printing the cumulative object per channel reads as if every channel
    // saw every message. Snapshot before, diff after.
    const before = { ...stats };
    for await (const m of channelMessages(channelId, token, sinceMs)) {
      stats.seen++;
      const companion = BOT_USER_TO_COMPANION[m.author?.id];
      if (!companion) continue;                 // human or webhook -- not a companion's speech
      const text = (m.content ?? "").trim();
      if (!text) continue;                      // attachment-only / embed-only
      stats.matched++;

      if (args.dryRun) continue;

      try {
        const out = await journal({
          agent: companion,
          note_text: text.slice(0, 4000),
          tags: ["discord", "speech", `channel:${channelId}`, "backfill"],
          source: "discord_speech",
          external_id: `discord:${m.id}`,       // idempotency key -- safe to re-run
          created_at: m.timestamp,              // the true time the words were said
        }, halsethUrl, secret);
        if (out?.skipped) stats.skipped++;
        else stats.written++;
      } catch (e) {
        stats.failed++;
        console.warn(`[backfill] ${companion} msg ${m.id} failed: ${String(e).slice(0, 140)}`);
      }
    }
    const delta = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v - before[k]]));
    console.log(`[backfill] channel ${channelId} done -- ${JSON.stringify(delta)}`);
  }

  console.log(`[backfill] COMPLETE ${JSON.stringify(stats)}`);
  if (args.dryRun) console.log("[backfill] dry run -- nothing written");
  // Non-zero exit on failures so a wrapper/cron notices; re-running is safe.
  if (stats.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`[backfill] fatal: ${e.message}`);
  process.exit(1);
});
