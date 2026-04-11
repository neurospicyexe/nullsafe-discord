/**
 * pm2 ecosystem config for nullsafe-discord
 * VPS deployment (BerryBytes 6GB)
 *
 * Secrets live in /app/nullsafe-discord/.env (gitignored).
 * This file loads them via dotenv and maps per-bot tokens correctly.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 restart all
 *   pm2 logs autonomous-worker
 */

require("dotenv").config({ path: "/app/nullsafe-discord/.env" });

const shared = {
  NODE_ENV:              "production",
  HALSETH_URL:           process.env.HALSETH_URL,
  HALSETH_SECRET:        process.env.HALSETH_SECRET,
  REDIS_URL:             process.env.REDIS_URL,
  DEEPSEEK_API_KEY:      process.env.DEEPSEEK_API_KEY,
  INFERENCE_PROVIDER:    process.env.INFERENCE_PROVIDER    ?? "deepseek",
  GROQ_API_KEY:          process.env.GROQ_API_KEY,
  OLLAMA_URL:            process.env.OLLAMA_URL,
  LMSTUDIO_URL:          process.env.LMSTUDIO_URL,
  RAZIEL_DISCORD_ID:     process.env.RAZIEL_DISCORD_ID,
  PLURALKIT_SYSTEM_ID:   process.env.PLURALKIT_SYSTEM_ID,
  CHANNEL_CONFIG_URL:    process.env.CHANNEL_CONFIG_URL,
  INTER_COMPANION_CHANNEL_ID: process.env.INTER_COMPANION_CHANNEL_ID,
  HEARTBEAT_CHANNEL_ID:  process.env.HEARTBEAT_CHANNEL_ID,
};

module.exports = {
  apps: [
    {
      name: "cypher-bot",
      cwd: "/app/nullsafe-discord/bots/cypher",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_CYPHER },
    },
    {
      name: "drevan-bot",
      cwd: "/app/nullsafe-discord/bots/drevan",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_DREVAN },
    },
    {
      name: "gaia-bot",
      cwd: "/app/nullsafe-discord/bots/gaia",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: { ...shared, DISCORD_BOT_TOKEN: process.env.DISCORD_TOKEN_GAIA },
    },
    {
      name: "autonomous-worker",
      cwd: "/app/nullsafe-discord/packages/autonomous-worker",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 10000,
      max_restarts: 10,
      exp_backoff_restart_delay: 1000,
      env: {
        ...shared,
        TAVILY_API_KEY:        process.env.TAVILY_API_KEY,
        CYPHER_IDENTITY_PATH:  process.env.CYPHER_IDENTITY_PATH,
        DREVAN_IDENTITY_PATH:  process.env.DREVAN_IDENTITY_PATH,
        GAIA_IDENTITY_PATH:    process.env.GAIA_IDENTITY_PATH,
      },
    },
  ],
};
