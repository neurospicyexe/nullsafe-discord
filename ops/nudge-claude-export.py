#!/usr/bin/env python3
"""Monthly Telegram nudge: run the Claude.ai export ingest (D3 capture backstop).

The capture verb is companion-driven and the orient affordance reminds THEM; this is the
one step only Raziel can do -- requesting the Claude.ai data export and running
`ops/ingest-claude-export.py` on the workstation. A step a human must remember is a
defect (BBH doctrine), so the remembering lives here, on the VPS cron, not in anyone's
head.

Cron (VPS, crontab -e as nullsafe) -- 1st of the month, 16:00 UTC = 11:00 CDT:
    0 16 1 * * /usr/bin/python3 /app/nullsafe-discord/ops/nudge-claude-export.py

Reuses the health-check's env convention: TELEGRAM_BOT_TOKEN + TELEGRAM_HOME_CHANNEL
from /home/nullsafe/.hermes/.env. Never prints either value -- presence booleans only.
"""

import json
import sys
import urllib.parse
import urllib.request

HERMES_ENV = "/home/nullsafe/.hermes/.env"

MESSAGE = (
    "Monthly capture backstop: export your Claude.ai data "
    "(Settings > Privacy > Export data), then on the workstation:\n\n"
    "  $env:HALSETH_URL / $env:ADMIN_SECRET, then\n"
    "  python ops/ingest-claude-export.py <export.zip> --companion cypher "
    "--owner-email <your email>\n"
    "  (repeat per companion with --filter if the export is mixed)\n\n"
    "Teams export note: --owner-email keeps Blue's conversations out of your vault -- "
    "the script refuses to run without it on a multi-member export. "
    "Unchanged conversations skip automatically, so re-running is always safe."
)


def read_env(path):
    out = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip()
    except Exception:
        pass
    return out


def main():
    env = read_env(HERMES_ENV)
    tok = env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("TELEGRAM_HOME_CHANNEL")
    if not tok or not chat:
        print(
            "telegram env missing: token set=%s chat set=%s" % (bool(tok), bool(chat)),
            file=sys.stderr,
        )
        return 2
    body = urllib.parse.urlencode({"chat_id": chat, "text": MESSAGE}).encode()
    try:
        with urllib.request.urlopen(
            "https://api.telegram.org/bot%s/sendMessage" % tok, data=body, timeout=20
        ) as r:
            ok = json.loads(r.read().decode()).get("ok", False)
    except Exception as e:
        print("send failed: %s" % str(e)[:160], file=sys.stderr)
        return 1
    print("nudge %s" % ("sent" if ok else "NOT sent (api ok=false)"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
