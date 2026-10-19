#!/bin/sh
# Daily Jev calibration (T5 / P5). Reads the shadow log, writes the machine-readable report that
# ops/health-check.py (check_jev_calibration) surfaces through its normal Telegram path, and keeps
# the human-readable text beside it. No Halseth / Discord / Jev calls, no message text.
#
# Cron (VPS, user nullsafe), off the health-check minutes (:07/:22/:37/:52) and the 09:05 heartbeat:
#   17 8 * * * /app/nullsafe-discord/ops/jev-calibration-cron.sh >> /app/logs/jev-calibration.log 2>&1
#
# Re-baseline deliberately after an accepted change (theta move, Jev prompt change):
#   node scripts/jev-calibration.mjs --save-baseline --json /app/logs/jev-calibration.json
# Optional: LABELS=/app/logs/jev-labels.json adds precision/recall/AUROC + best theta to the report.
set -eu
cd /app/nullsafe-discord
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
LABEL_ARGS=""
[ -n "${LABELS:-}" ] && [ -f "$LABELS" ] && LABEL_ARGS="--labels $LABELS"
# shellcheck disable=SC2086
node scripts/jev-calibration.mjs --days "${JEV_CAL_DAYS:-7}" --json /app/logs/jev-calibration.json $LABEL_ARGS \
  > /app/logs/jev-calibration.txt
echo "$(date -u +%FT%TZ) jev-calibration ok"
