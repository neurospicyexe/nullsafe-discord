#!/usr/bin/env python3
"""Wellness bridge (B8): pull wearable data from the Wellness Project MCP into Halseth.

Runs on the VPS from a systemd user timer, 07:30 and 16:00 America/Chicago (ops/systemd/).
Logic and tests live in ops/wellness_core.py; this file is the thin entry point.

    python3 ops/wellness-bridge.py                  # one run (the timer's job)
    python3 ops/wellness-bridge.py --backfill-from 2026-08-19   # one-off history (2 plan reads per 31 days)
    python3 ops/wellness-bridge.py --dry-run        # fetch + parse, write nothing, send nothing

Files (never printed): ~/.hermes/.wellness-tokens.json (from ops/wellness-auth.py), cooldown state
~/.hermes/.wellness-bridge-state.json. Halseth url/secret from /app/nullsafe-discord/.env; the Telegram
token and home channel from ~/.hermes/.env, the same route ops/health-check.py uses.

PLAN LIMIT: the Wellness free plan allows 3 analysis reads a day and an MCP list_* read counts as one
(measured 2026-11-01). A morning run is 2 reads (wearable + sleep), an afternoon run 1: exactly 3 a day,
with nothing left for Raziel's own Claude.ai use of the connector. The Pro plan ($9.99/mo) removes it.
"""
import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wellness_core as wc  # noqa: E402

HOME = os.path.expanduser("~")
TOKENS = os.environ.get("WELLNESS_TOKENS", os.path.join(HOME, ".hermes", ".wellness-tokens.json"))
STATE = os.environ.get("WELLNESS_STATE", os.path.join(HOME, ".hermes", ".wellness-bridge-state.json"))
DISCORD_ENV = "/app/nullsafe-discord/.env"
HERMES_ENV = os.path.join(HOME, ".hermes", ".env")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backfill-from")
    ap.add_argument("--no-sleep", action="store_true")
    a = ap.parse_args()

    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()
    state = wc.load_state(STATE)
    hermes_env = wc.read_env(HERMES_ENV)

    def notify(text):
        return False if a.dry_run else wc.telegram(text, hermes_env)

    def auth_alert():
        if wc.due(state, "auth_alert_at", wc.ALERT_COOLDOWN_H, now_ts) and notify(wc.AUTH_TEXT):
            state["auth_alert_at"] = now_ts

    try:
        tok = wc.read_tokens(TOKENS)
    except Exception:
        tok = None
    if not tok:
        print("wellness-bridge: no token file; run ops/wellness-auth.py on the workstation")
        auth_alert()
        if not a.dry_run:
            wc.save_state(STATE, state)
        return 2
    try:
        if tok.get("expires_at", 0) - 120 < now_ts:
            tok = wc.refresh_tokens(tok, now_ts)
            if not a.dry_run:
                wc.write_tokens(TOKENS, tok)
        wellness = wc.WellnessClient(tok["access_token"])
        env = wc.read_env(DISCORD_ENV)
        url, secret = env.get("HALSETH_URL"), env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
        if not url or not secret:
            print("wellness-bridge: no Halseth url/secret in the env file")
            return 3
        halseth = wc.HalsethClient(url, secret)
        if a.dry_run:
            halseth.put_day = lambda day, body: print("dry-run: would write", day, sorted(body))
        if a.backfill_from:
            return backfill(wellness, halseth, a.backfill_from, now)
        status = wc.run_once(wellness, halseth, state, now, notify, with_sleep=False if a.no_sleep else None)
        print("wellness-bridge: %s" % status)
        return 0
    except wc.AuthFailed:
        print("wellness-bridge: sign-in failed (token refresh refused)")
        auth_alert()
        return 2
    except Exception as e:  # a broken run must report, not loop
        print("wellness-bridge: failed: %s" % type(e).__name__)
        return 3
    finally:
        if not a.dry_run:
            try:
                wc.save_state(STATE, state)
            except Exception:
                pass


def backfill(wellness, halseth, start, now):
    """History in 31-day chunks (the tool's maximum), oldest first so baselines build forward."""
    d = date.fromisoformat(start)
    today = wc.local_today(now)
    try:
        history = wc._history_from_rows(halseth.wellness_rows(30))
    except Exception:
        history = {}
    n = 0
    while d <= today:
        e = min(d + timedelta(days=30), today)
        wear = wc.parse_wearable(wellness.list_wearable_data(d.isoformat(), e.isoformat()))
        sleep = wc.parse_sleep(wellness.list_sleep(d.isoformat(), e.isoformat()))
        for day, body in wc.build_day_payloads(wear, sleep, history, now):
            halseth.put_day(day, body)
            history[day] = {"hrv_resting": body.get("hrv_resting"), "resting_hr": body.get("resting_hr")}
            n += 1
        d = e + timedelta(days=1)
    print("wellness-bridge: backfilled %d day row(s)" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
