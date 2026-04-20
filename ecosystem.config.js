/**
 * pm2 ecosystem config for nullsafe-discord
 * VPS deployment (BerryBytes 6GB)
 *
 * Secrets live in /app/nullsafe-discord/.env (gitignored).
 * This file loads them via dotenv and maps per-bot tokens correctly.
 *
 * Usage:
 *   pm2 start ecosystem.config.js        # first-time start
 *   pm2 reload ecosystem.config.js       # rolling restart (scoped to this file only)
 *   pm2 logs autonomous-worker
 */

require("dotenv").config({ path: "/app/nullsafe-discord/.env" });

const shared = {
  NODE_ENV:              "production",
  // Force IPv4-first DNS resolution -- prevents ENETUNREACH on VPS where IPv6 is unrouted.
  NODE_OPTIONS:          "--dns-result-order=ipv4first",
  HALSETH_URL:           process.env.HALSETH_URL,
  HALSETH_SECRET:        process.env.HALSETH_SECRET,
  REDIS_URL:             process.env.REDIS_URL,
  DEEPSEEK_API_KEY:      process.env.DEEPSEEK_API_KEY,
  INFERENCE_PROVIDER:    process.env.INFERENCE_PROVIDER    ?? "deepseek",
  GROQ_API_KEY:          process.env.GROQ_API_KEY,
  OLLAMA_URL:            process.env.OLLAMA_URL,
  LMSTUDIO_URL:          process.env.LMSTUDIO_URL,
  OWNER_DISCORD_ID:        process.env.OWNER_DISCORD_ID,
  OWNER_NAME:              process.env.OWNER_NAME              ?? "the primary user",
  BLUE_DISCORD_ID:         process.env.BLUE_DISCORD_ID         ?? "1289019462724354068",
  PLURALKIT_SYSTEM_ID:     process.env.PLURALKIT_SYSTEM_ID,
  BLUE_PK_SYSTEM_ID:       process.env.BLUE_PK_SYSTEM_ID       ?? "szplj",
  CHANNEL_CONFIG_URL:    process.env.CHANNEL_CONFIG_URL,
  INTER_COMPANION_CHANNEL_ID: process.env.INTER_COMPANION_CHANNEL_ID,
  HEARTBEAT_CHANNEL_ID:  process.env.HEARTBEAT_CHANNEL_ID,
  // Brain relay: set INFERENCE_MODE=brain to route inference through Phoenix Brain.
  // When "direct" (default), each bot calls DeepSeek directly.
  INFERENCE_MODE:        process.env.INFERENCE_MODE        ?? "direct",
  BRAIN_URL:             process.env.BRAIN_URL             ?? "http://127.0.0.1:8001",
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
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_CYPHER },
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
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_DREVAN },
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
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_GAIA },
    },
    {
      // Phoenix Brain -- FastAPI inference service.
      // Bots relay ThoughtPackets here when INFERENCE_MODE=brain.
      // Runs on port 8001 (same VPS as bots; loopback only -- no external exposure needed).
      // Requires: Python venv at /app/nullsafe-phoenix/venv, .env.brain at cwd.
      name: "nullsafe-brain",
      cwd: "/app/nullsafe-phoenix",
      script: "services/brain/main.py",
      interpreter: "/app/nullsafe-phoenix/venv/bin/python3",
      autorestart: true,
      restart_delay: 8000,
      max_restarts: 15,
      min_uptime: "30s",
      kill_timeout: 8000,
      exp_backoff_restart_delay: 2000,
      error_file: "/app/logs/nullsafe-brain-error.log",
      out_file: "/app/logs/nullsafe-brain-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        // shared/contracts.py lives at repo root -- PYTHONPATH must include it.
        PYTHONPATH:            "/app/nullsafe-phoenix",
        HALSETH_URL:           process.env.HALSETH_URL,
        HALSETH_ADMIN_SECRET:  process.env.HALSETH_SECRET,
        // Halseth IS the WebMind for now -- /mind/* endpoints are identical.
        WEBMIND_URL:           process.env.HALSETH_URL,
        DEEPSEEK_API_KEY:      process.env.DEEPSEEK_API_KEY,
        INFERENCE_ENABLED:     "true",
        SYNTHESIS_ENABLED:     process.env.BRAIN_SYNTHESIS_ENABLED ?? "false",
        SYNTHESIS_INTERVAL:    process.env.BRAIN_SYNTHESIS_INTERVAL ?? "1200",
        BRAIN_HOST:            "127.0.0.1",
        IDENTITY_DIR:          "/app/nullsafe-phoenix/services/brain/identity/data",
      },
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
        TAVILY_API_KEY:        process.env.TAVILY_API_KEY,
        CYPHER_IDENTITY_PATH:  process.env.CYPHER_IDENTITY_PATH,
        DREVAN_IDENTITY_PATH:  process.env.DREVAN_IDENTITY_PATH,
        GAIA_IDENTITY_PATH:    process.env.GAIA_IDENTITY_PATH,
      },
    },
    {
      name: "voice-sidecar",
      script: "services/voice-sidecar/server.py",
      interpreter: "/app/nullsafe-discord/services/voice-sidecar/venv/bin/python3",
      cwd: "/app/nullsafe-discord",
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      env: {
        HOST: "127.0.0.1",
        PORT: "5001",
        WHISPER_MODEL: "base",
        KOKORO_SPEED: "1.0",
      },
    },
  ],
};
