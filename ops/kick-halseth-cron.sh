#!/usr/bin/env bash
# Drive Halseth's every-minute scheduled work from the VPS (2026-08-15).
#
# WHY: Cloudflare stopped delivering scheduled events to the halseth worker (trigger registered,
# zero invocations in wrangler tail for hours) and every autonomic tick froze at once -- home,
# ferment, synthesis queue, roster, salience, stale-sweep, SOMA, narrative. POST
# /admin/run-scheduled runs the identical work; every rider self-gates on its own stamp, so this
# is safe alongside the Cloudflare cron whenever that recovers. Belt and suspenders BY DESIGN:
# leave both running; double delivery double-runs nothing.
#
# Cron: * * * * * /app/nullsafe-discord/ops/kick-halseth-cron.sh >> /app/logs/halseth-kick.log 2>&1
set -u
ENV_FILE=/app/nullsafe-discord/.env
URL_DEFAULT="https://halseth.neurospicyexe.workers.dev"

HALSETH_URL=$(grep -E '^HALSETH_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)
SECRET=$(grep -E '^(HALSETH_SECRET|ADMIN_SECRET)=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "${SECRET}" ]; then
  echo "$(date -u +%FT%TZ) ABORT: no HALSETH_SECRET/ADMIN_SECRET in $ENV_FILE"
  exit 1
fi

code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${SECRET}" \
  --max-time 50 \
  "${HALSETH_URL:-$URL_DEFAULT}/admin/run-scheduled")

# Log failures only; a green minute-cron would write 1440 identical lines a day.
if [ "$code" != "200" ]; then
  echo "$(date -u +%FT%TZ) run-scheduled returned $code"
fi
