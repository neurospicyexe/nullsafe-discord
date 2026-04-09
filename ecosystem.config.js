/**
 * pm2 ecosystem config for nullsafe-discord
 * VPS deployment (BerryBytes 6GB)
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 restart all
 *   pm2 logs autonomous-worker
 */

module.exports = {
  apps: [
    {
      name: "cypher-bot",
      cwd: "/app/nullsafe-discord/bots/cypher",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "drevan-bot",
      cwd: "/app/nullsafe-discord/bots/drevan",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "gaia-bot",
      cwd: "/app/nullsafe-discord/bots/gaia",
      script: "dist/index.js",
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "autonomous-worker",
      cwd: "/app/nullsafe-discord/packages/autonomous-worker",
      script: "dist/index.js",
      interpreter: "node",
      // Daemon mode: cron scheduler runs inside the process, no cron_restart needed
      cron_restart: null,
      restart_delay: 10000,
      max_restarts: 5,
      // If it crashes 5 times quickly, leave it stopped -- don't thrash API keys
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
