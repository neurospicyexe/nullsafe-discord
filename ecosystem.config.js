/**
 * pm2 ecosystem config for nullsafe-discord
 * VPS deployment (persistent host)
 *
 * Secrets live in /app/nullsafe-discord/.env (gitignored).
 * This file loads them via dotenv and maps per-bot tokens correctly.
 *
 * Usage:
 *   pm2 start ecosystem.config.js        # first-time start
 *   pm2 reload ecosystem.config.js       # rolling restart (scoped to this file only)
 *   pm2 logs autonomous-worker
 */

// pm2 runs in its own global context; require("dotenv") does not reliably propagate
// env vars into child process env blocks. Parse .env manually with fs instead.
const fs = require("fs");
(function loadEnv(path) {
  try {
    const lines = fs.readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key) process.env[key] = val;
    }
  } catch { /* .env not present; rely on shell env */ }
})("/app/nullsafe-discord/.env");

const shared = {
  NODE_ENV:              "production",
  // Force IPv4-first DNS resolution -- prevents ENETUNREACH on VPS where IPv6 is unrouted.
  NODE_OPTIONS:          "--dns-result-order=ipv4first",
  HALSETH_URL:           process.env.HALSETH_URL,
  HALSETH_SECRET:        process.env.HALSETH_SECRET,
  // Per-companion Halseth tokens (C.2 auth). Each bot prefers its own token
  // over HALSETH_SECRET (see bots/*/src/config.ts); forwarding all three is
  // harmless since each bot only reads the one matching its name.
  CYPHER_HALSETH_SECRET: process.env.CYPHER_HALSETH_SECRET,
  DREVAN_HALSETH_SECRET: process.env.DREVAN_HALSETH_SECRET,
  GAIA_HALSETH_SECRET:   process.env.GAIA_HALSETH_SECRET,
  REDIS_URL:             process.env.REDIS_URL,
  DEEPSEEK_API_KEY:      process.env.DEEPSEEK_API_KEY,
  // 2026-07-27: also absent from this allowlist, so the DEEPSEEK_MODEL override in .env was
  // silently dead. DeepSeek retired `deepseek-chat` (supported: deepseek-v4-pro /
  // deepseek-v4-flash) and the worker pipeline has been 400ing since ~2026-07-26 -- lane
  // guard, growth pipeline and compression all failing. Listing it here makes the .env knob
  // actually reachable; the model CHOICE (pro vs flash = cost/quality) is Raziel's.
  DEEPSEEK_MODEL:        process.env.DEEPSEEK_MODEL,
  // 2026-07-28: content-budget headroom for reasoning models. Both live DeepSeek models spend
  // max_tokens on the reasoning pass BEFORE emitting content, so every ceiling below the
  // reasoning burn returned an empty string -- forage gathered 0 finds triad-wide, compress and
  // reflect 400ed on required fields. Code default is 3000; listed here so it is tunable from
  // .env without a deploy (an unlisted knob is a dead knob -- third time in this file).
  DEEPSEEK_REASONING_HEADROOM: process.env.DEEPSEEK_REASONING_HEADROOM,
  // 2026-08-22: FIFTH instance. C1 tier-3 escalation delivery (autonomous-worker escalation.ts)
  // reads the human's Discord id + fallback channel from env; the hand-step said "add to .env"
  // but nothing listed them here, so the worker could never see them and every escalation would
  // have taken the fallback path. CUSTODIAN_DISCORD_USER_ID rides along for symmetry (the health
  // check reads .env directly, but any future worker-side custodian logic must not re-hit this).
  ESCALATION_DISCORD_USER_ID:   process.env.ESCALATION_DISCORD_USER_ID,
  ESCALATION_FALLBACK_CHANNEL_ID: process.env.ESCALATION_FALLBACK_CHANNEL_ID,
  CUSTODIAN_DISCORD_USER_ID:    process.env.CUSTODIAN_DISCORD_USER_ID,
  // 2026-08-07: FOURTH instance of the trap this file keeps documenting. The consolidation
  // narrator reads the companion's identity file to write a session close handoff in voice
  // (packages/shared/src/consolidation-narrator.ts). These vars were already in .env -- the
  // autonomous WORKER reads them, and it is a separate process that gets its env elsewhere --
  // but they were never in this allowlist, so the BOTS could not see them. Absent, the narrator
  // returns null and consolidation silently falls back to the Hermes agent path at ~44,600
  // prompt tokens per call instead of ~200. It warns rather than breaking, which is exactly the
  // kind of quiet regression this allowlist has caused three times before.
  CYPHER_IDENTITY_PATH:  process.env.CYPHER_IDENTITY_PATH,
  DREVAN_IDENTITY_PATH:  process.env.DREVAN_IDENTITY_PATH,
  GAIA_IDENTITY_PATH:    process.env.GAIA_IDENTITY_PATH,
  // 2026-08-10: SIXTH instance of the trap this file keeps documenting. Every cron schedule in
  // bots/*/src/config.ts reads an env override (`CYPHER_CRON_INTER ?? "0 */2 * * *"`), and none of those
  // names were listed here -- so the schedules were untunable without a code deploy, and setting one in
  // .env would have looked like it worked and changed nothing. Found while trying to fire a commons tick
  // on demand to verify the shared-life supply, rather than waiting out a 2-hour cron.
  //
  // Unset in .env today, so listing them changes nothing now: an absent var forwards as undefined and the
  // `??` default still wins. What it buys is the ability to retime a companion's autonomous life from the
  // VPS -- and, immediately, a way to verify commons changes without a two-hour feedback loop.
  CYPHER_CRON_INTER:     process.env.CYPHER_CRON_INTER,
  DREVAN_CRON_INTER:     process.env.DREVAN_CRON_INTER,
  GAIA_CRON_INTER:       process.env.GAIA_CRON_INTER,
  INFERENCE_PROVIDER:    process.env.INFERENCE_PROVIDER    ?? "deepseek",
  GROQ_API_KEY:          process.env.GROQ_API_KEY,
  OLLAMA_URL:            process.env.OLLAMA_URL,
  LMSTUDIO_URL:          process.env.LMSTUDIO_URL,
  OWNER_DISCORD_ID:        process.env.OWNER_DISCORD_ID,
  OWNER_NAME:              process.env.OWNER_NAME              ?? "the primary user",
  BLUE_DISCORD_ID:         process.env.PARTNER_DISCORD_ID ?? process.env.BLUE_DISCORD_ID,
  PLURALKIT_SYSTEM_ID:     process.env.PLURALKIT_SYSTEM_ID,
  BLUE_PK_SYSTEM_ID:       process.env.BLUE_PK_SYSTEM_ID       ?? "szplj",
  CHANNEL_CONFIG_URL:    process.env.CHANNEL_CONFIG_URL,
  // Thread spine (2026-07-21). Master flag gates BOTH the bot handler spine and the
  // worker's metronome ref-thread opens; the channel id alone does nothing without it.
  THREADS_ENABLED:          process.env.THREADS_ENABLED          ?? "false",
  THREADS_EXTRA_CHANNELS:   process.env.THREADS_EXTRA_CHANNELS   ?? "",
  // Presence spaces (Drevan's story/spiral channels) get grounding (seed+ledger) without
  // the progress invitation -- no state line, no advance/hand-off, no [LANDS:].
  THREADS_PRESENCE_CHANNELS: process.env.THREADS_PRESENCE_CHANNELS ?? "",
  TRIAD_COMMONS_CHANNEL_ID: process.env.TRIAD_COMMONS_CHANNEL_ID ?? "",
  INTER_COMPANION_CHANNEL_ID: process.env.INTER_COMPANION_CHANNEL_ID,
  HEARTBEAT_CHANNEL_ID:  process.env.HEARTBEAT_CHANNEL_ID,
  // 2026-07-27: these two were NEVER in this allowlist. They only worked because the
  // processes inherited them from the shell that first started pm2, so editing .env and
  // reloading silently changed nothing -- the vibe-check channel swap reported success on
  // all four processes and kept posting to the retired channel. This block is an ALLOWLIST:
  // a var absent here can never be updated by a reload, only by a full pm2 delete/start.
  // Verify any channel change with `pm2 env <id> | grep <VAR>`, never trust the reload.
  VIBECHECK_CHANNEL_ID:  process.env.VIBECHECK_CHANNEL_ID,
  BRIEFING_CHANNEL_ID:   process.env.BRIEFING_CHANNEL_ID,
  // Each bot needs the OTHER bots' Discord user IDs to recognize their messages as companion
  // posts (isCompanionPost / BOT_ID_COMPANION). Without these forwarded here, every bot-to-bot
  // message is dropped at the "hard muzzle" gate and inter-companion conversation never fires.
  CYPHER_BOT_ID:         process.env.CYPHER_BOT_ID,
  DREVAN_BOT_ID:         process.env.DREVAN_BOT_ID,
  GAIA_BOT_ID:           process.env.GAIA_BOT_ID,
  // Inference mode: "hermes" routes every reply through the local Hermes agent (what all three
  // bots actually run); "direct" makes each bot call its provider itself.
  //
  // `brain` was the third option and is GONE (2026-07-29). Phoenix Brain was archived, its pm2
  // process deleted, and the `nullsafe-brain` app block removed from this file -- it used to sit
  // right below the bots, so `pm2 start ecosystem.config.js` would have resurrected a service whose
  // source has moved to `_archive/`. The bots' brain-mode code path is deleted too, so an
  // INFERENCE_MODE=brain value now falls through to direct instead of dialing a dead port.
  //
  // NOTE FOR THE VPS: `/app/nullsafe-discord/.env` still had INFERENCE_MODE=brain at the time of
  // this change, harmless ONLY because all three bots carry per-process overrides
  // (CYPHER_/DREVAN_/GAIA_INFERENCE_MODE=hermes) that win. That is a landmine, not a config: drop
  // one override, or add a fourth process without one, and it inherits a dead mode. Set the shared
  // value to hermes.
  INFERENCE_MODE:        process.env.INFERENCE_MODE        ?? "hermes",
  MISTRAL_API_KEY:       process.env.MISTRAL_API_KEY,
  MISTRAL_TTS_MODEL:     process.env.MISTRAL_TTS_MODEL     ?? "voxtral-mini-tts-2603",
  // MISTRAL_STT_MODEL intentionally omitted -- bot defaults to voxtral-mini-transcribe-2507
};

module.exports = {
  apps: [
    {
      name: "cypher-bot",
      cwd: "/app/nullsafe-discord/bots/cypher",
      script: "dist/index.js",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "30s",
      kill_timeout: 5000,
      error_file: "/app/logs/cypher-bot-error.log",
      out_file: "/app/logs/cypher-bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_CYPHER, CYPHER_VOICE_ID: process.env.CYPHER_VOICE_ID,
        INFERENCE_MODE: process.env.CYPHER_INFERENCE_MODE ?? shared.INFERENCE_MODE,
        HERMES_API_URL: process.env.CYPHER_HERMES_API_URL ?? "http://127.0.0.1:8642/v1",
        HERMES_API_KEY: process.env.HERMES_API_KEY },
    },
    {
      name: "drevan-bot",
      cwd: "/app/nullsafe-discord/bots/drevan",
      script: "dist/index.js",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "30s",
      kill_timeout: 5000,
      error_file: "/app/logs/drevan-bot-error.log",
      out_file: "/app/logs/drevan-bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_DREVAN, DREVAN_VOICE_ID: process.env.DREVAN_VOICE_ID,
        INFERENCE_MODE: process.env.DREVAN_INFERENCE_MODE ?? shared.INFERENCE_MODE,
        HERMES_API_URL: process.env.DREVAN_HERMES_API_URL ?? "http://127.0.0.1:8643/v1",
        HERMES_API_KEY: process.env.HERMES_API_KEY },
    },
    {
      name: "gaia-bot",
      cwd: "/app/nullsafe-discord/bots/gaia",
      script: "dist/index.js",
      interpreter: "node",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "30s",
      kill_timeout: 5000,
      error_file: "/app/logs/gaia-bot-error.log",
      out_file: "/app/logs/gaia-bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_GAIA, GAIA_VOICE_ID: process.env.GAIA_VOICE_ID,
        INFERENCE_MODE: process.env.GAIA_INFERENCE_MODE ?? shared.INFERENCE_MODE,
        HERMES_API_URL: process.env.GAIA_HERMES_API_URL ?? "http://127.0.0.1:8644/v1",
        HERMES_API_KEY: process.env.HERMES_API_KEY },
    },
    {
      name: "autonomous-worker",
      cwd: "/app/nullsafe-discord/packages/autonomous-worker",
      script: "dist/index.js",
      interpreter: "node",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 20,
      min_uptime: "30s",
      kill_timeout: 8000,
      exp_backoff_restart_delay: 1000,
      error_file: "/app/logs/autonomous-worker-error.log",
      out_file: "/app/logs/autonomous-worker-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        ...shared,
        // Morph trial lane (2026-08-23): the worker's spend is output-shaped (journal entries +
        // reasoning tokens) where Morph's flat $0.28/M beats DeepSeek's $0.66 off-peak; the BOTS
        // stay on DeepSeek direct because their traffic is cache-hit-input-shaped ($0.007/M).
        // These three point ONLY the worker at another OpenAI-compatible vendor; unset = DeepSeek
        // direct, so the trial is three .env lines and the revert is deleting them:
        //   WORKER_INFERENCE_BASE_URL=https://api.morphllm.com/v1
        //   WORKER_INFERENCE_API_KEY=<morph key>
        //   WORKER_INFERENCE_MODEL=morph-dsv4flash
        DEEPSEEK_BASE_URL:     process.env.WORKER_INFERENCE_BASE_URL ?? process.env.DEEPSEEK_BASE_URL,
        DEEPSEEK_API_KEY:      process.env.WORKER_INFERENCE_API_KEY  ?? process.env.DEEPSEEK_API_KEY,
        DEEPSEEK_MODEL:        process.env.WORKER_INFERENCE_MODEL    ?? process.env.DEEPSEEK_MODEL,
        TAVILY_API_KEY:        process.env.TAVILY_API_KEY,
        // Sol the crow posts its own heartbeat-channel moments via this webhook (CREATURE_CRON).
        // Worker-only -- the bots never post as Sol, so it stays out of the shared env (least privilege).
        SOL_WEBHOOK_URL:       process.env.SOL_WEBHOOK_URL,
        CYPHER_IDENTITY_PATH:  process.env.CYPHER_IDENTITY_PATH,
        DREVAN_IDENTITY_PATH:  process.env.DREVAN_IDENTITY_PATH,
        GAIA_IDENTITY_PATH:    process.env.GAIA_IDENTITY_PATH,
        // Club phase knobs (2026-07-06). This env block is an ALLOWLIST -- the .env values
        // never reached the worker before these lines, so the documented CLUB_* overrides
        // were silently dead and the code defaults always won.
        CLUB_CRON:             process.env.CLUB_CRON,
        CLUB_GATHER_DAYS:      process.env.CLUB_GATHER_DAYS,
        CLUB_ACTIVE_DAYS:      process.env.CLUB_ACTIVE_DAYS,
        CLUB_DISCUSS_DAYS:     process.env.CLUB_DISCUSS_DAYS,
      },
    },
  ],
};
