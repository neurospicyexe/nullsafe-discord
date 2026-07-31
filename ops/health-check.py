#!/usr/bin/env python3
"""Standing health check for the whole Nullsafe suite.

Phase 1 item 5 (docs/PLAN-2026-08-to-12-solid-by-december.md) and December criterion 6:
"Raziel can ask 'is everything okay?' and get an answer in one command."

WHY IT LIVES HERE AND NOT IN HALSETH
------------------------------------
A liveness check inside its own subject is theater. Halseth cannot report that Halseth is down, and a
Worker cannot see pm2 or systemd at all. So the split is:

  * Halseth  GET /admin/health  -- the DATA half. Only Halseth can see D1: guardian's findings, cron
    staleness, backlogs, whether the companions are still writing anything.
  * this script -- the OUTSIDE half. Processes, units, reachability. It CALLS the endpoint, so
    "Halseth is unreachable" is a finding rather than a silent absence of complaint.

It also does not re-implement Halseth's checks. Two authorities on one question is the duplication
this whole phase exists to remove.

WHY PYTHON AND WHY THIS REPO
----------------------------
Python 3 stdlib only: no build step, nothing to install, and it matches the existing ops watchers
(hermes-model-watcher.py). It lives in nullsafe-discord because that repo HAS a git remote and is
already deployed by `git pull` -- nullsafe-triad-skills has no remote by design, so anything put
there needs Sync-OpsToVps.ps1 run by hand, and anything you have to remember is a defect.

USAGE
    python3 ops/health-check.py                # human-readable report, exit code = severity
    python3 ops/health-check.py --json         # machine-readable
    python3 ops/health-check.py --notify       # also post to Telegram IF something is wrong
    python3 ops/health-check.py --notify --always   # post even when healthy (for a daily heartbeat)

EXIT CODES: 0 ok/notice, 1 warning, 2 red, 3 the check itself broke.

SECRETS: read from env files, never printed. Not even masked -- a mask keyed on the secret's own
content is not a mask (that mistake once printed a key raw and blocked a rotation). Presence and
length only.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DISCORD_ENV = "/app/nullsafe-discord/.env"
HERMES_ENV = "/home/nullsafe/.hermes/.env"          # Telegram token + home channel
EXPECTED_PM2 = ["cypher-bot", "drevan-bot", "gaia-bot", "autonomous-worker"]
SYSTEM_UNITS = ["second-brain.service"]              # root systemd
HTTP_TIMEOUT = 25

# Cloudflare rejects urllib's default "Python-urllib/3.x" User-Agent on workers.dev with a 403.
# The check found this on its first real run and reported "halseth unreachable" -- correct behaviour from
# the check, wrong conclusion available to the reader, since curl with the same secret got 200. Any HTTP
# probe in this file must send a real UA or it measures Cloudflare's bot filter instead of the service.
UA = "nullsafe-health-check/1.0 (+ops/health-check.py)"

RANK = {"ok": 0, "notice": 1, "warning": 2, "red": 3}
EXIT_FOR = {"ok": 0, "notice": 0, "warning": 1, "red": 2}


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


def run(cmd, timeout=25):
    """Run a command, returning (ok, stdout). Never raises -- a broken probe must report, not crash."""
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return False, str(e)


class Report:
    def __init__(self):
        self.checks = []

    def add(self, name, severity, detail):
        self.checks.append({"name": name, "severity": severity, "detail": detail})

    @property
    def severity(self):
        w = "ok"
        for c in self.checks:
            if RANK[c["severity"]] > RANK[w]:
                w = c["severity"]
        return w

    @property
    def failures(self):
        return [c for c in self.checks if c["severity"] != "ok"]


# ── the outside checks ──────────────────────────────────────────────────────

def check_pm2(rep):
    # pm2 lives under nvm, so a non-login shell has no PATH for it. Sourcing nvm here is the
    # difference between a real check and a permanent "pm2: command not found" that reads as failure.
    ok, out = run('export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh >/dev/null 2>&1 && pm2 jlist')
    if not ok:
        rep.add("pm2", "red", "pm2 jlist failed: " + out.strip()[:160])
        return
    try:
        procs = json.loads(out[out.index("["):])
    except Exception:
        rep.add("pm2", "red", "pm2 jlist returned unparseable output")
        return

    by_name = {p.get("name"): p for p in procs}
    for name in EXPECTED_PM2:
        p = by_name.get(name)
        if p is None:
            # This is the shape that bit us before: a process absent from pm2 looks like silence,
            # not failure. Name it red.
            rep.add("pm2:" + name, "red", "NOT in pm2 (would not survive a reboot either)")
            continue
        env = p.get("pm2_env", {})
        status = env.get("status")
        restarts = env.get("restart_time", 0)
        uptime_ms = env.get("pm_uptime")
        mins = None
        if isinstance(uptime_ms, (int, float)):
            import time
            mins = int((time.time() * 1000 - uptime_ms) / 60000)
        if status != "online":
            rep.add("pm2:" + name, "red", "status=%s restarts=%s" % (status, restarts))
        elif mins is not None and mins < 3:
            # Not an error, but worth surfacing: a bot that just restarted may be in a crash loop,
            # and "online" alone hides that. Check restarts alongside uptime, never the log buffer.
            rep.add("pm2:" + name, "notice", "online but only %dm uptime (restarts=%s)" % (mins, restarts))
        else:
            rep.add("pm2:" + name, "ok", "online %s restarts=%s" % (("%dm" % mins) if mins is not None else "?", restarts))

    unexpected = [n for n in by_name if n not in EXPECTED_PM2]
    if unexpected:
        # `nullsafe-brain` reappearing here is the specific thing worth catching: it was archived
        # 2026-07-29 and its ecosystem block removed, so its return means something re-added it.
        rep.add("pm2:unexpected", "warning", "processes not in the expected set: " + ", ".join(unexpected))


def check_systemd(rep):
    for unit in SYSTEM_UNITS:
        ok, out = run("systemctl is-active %s" % unit)
        state = out.strip().splitlines()[0] if out.strip() else "unknown"
        rep.add("systemd:" + unit, "ok" if state == "active" else "red", state)
        # `enabled` is a separate question from `active`, and a unit that is active-but-not-enabled
        # silently disappears on reboot.
        ok2, out2 = run("systemctl is-enabled %s" % unit)
        en = out2.strip().splitlines()[0] if out2.strip() else "unknown"
        if en not in ("enabled", "enabled-runtime"):
            rep.add("systemd:" + unit + ":enabled", "warning", "is-enabled=%s (will not survive reboot)" % en)


# `systemctl --user` needs a session bus, and cron has no XDG_RUNTIME_DIR -- so under cron every user
# unit query dies with "Failed to connect to bus: No medium found" while the same command works fine
# over ssh. Exporting the runtime dir explicitly makes the two environments agree.
#
# This is the bug that shipped on 2026-07-30: with `2>/dev/null` on the discovery command, an
# unreachable bus was indistinguishable from an empty result, so the check reported "no hermes* user
# units found" while all four units were active. Wrong in the harmless direction that day, but the
# same code would have reported the same line with the gateways genuinely dead -- a monitor that
# cannot tell "I could not look" from "there is nothing there" says nothing in either direction.
# Never suppress stderr on a probe whose silence is the finding.
USER_SYSTEMCTL_ENV = "XDG_RUNTIME_DIR=/run/user/$(id -u)"


def check_hermes(rep):
    # The gateways are USER systemd units, so they are invisible to `systemctl` without --user.
    # Discovered rather than hardcoded: the unit names have changed before.
    ok, out = run("%s systemctl --user list-units --type=service --no-legend --plain 'hermes*'"
                  % USER_SYSTEMCTL_ENV)
    if "Failed to connect to bus" in out or "Failed to get D-Bus connection" in out:
        rep.add("hermes:gateways", "red",
                "cannot reach the user systemd manager, so gateway state is UNKNOWN, not absent: %s"
                % (out.strip().splitlines()[0] if out.strip() else "no output"))
        return
    units = [l.split()[0] for l in out.splitlines() if l.strip() and l.split()[0].endswith(".service")]
    if not units:
        rep.add("hermes:gateways", "warning",
                "user manager reachable but no hermes* units exist (all three bots relay inference "
                "here -- if this is wrong, the discovery pattern needs updating, not the conclusion)")
        return
    for u in units:
        ok2, st = run("%s systemctl --user is-active %s" % (USER_SYSTEMCTL_ENV, u))
        state = st.strip().splitlines()[0] if st.strip() else "unknown"
        rep.add("hermes:" + u, "ok" if state == "active" else "red", state)


def check_halseth(rep, env):
    url = env.get("HALSETH_URL")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not url or not secret:
        rep.add("halseth:config", "red",
                "HALSETH_URL present=%s / secret present=%s in %s" % (bool(url), bool(secret), DISCORD_ENV))
        return None
    req = urllib.request.Request(
        url.rstrip("/") + "/admin/health",
        headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        rep.add("halseth:reachable", "red", "HTTP %s from /admin/health" % e.code)
        return None
    except Exception as e:
        # THE case this script exists for: Halseth down cannot be reported by Halseth.
        rep.add("halseth:reachable", "red", "unreachable: %s" % str(e)[:160])
        return None

    rep.add("halseth:reachable", "ok", "200")
    for c in data.get("checks", []):
        rep.add("halseth:" + c.get("name", "?"), c.get("severity", "notice"), c.get("detail", ""))
    return data


def check_second_brain(rep, env):
    url = env.get("SECOND_BRAIN_URL") or env.get("SECOND_BRAIN_WEBHOOK_URL")
    if not url:
        rep.add("second_brain:config", "notice", "no SECOND_BRAIN_URL in %s -- skipped" % DISCORD_ENV)
        return
    try:
        with urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/health", headers={"User-Agent": UA}), timeout=HTTP_TIMEOUT) as r:
            rep.add("second_brain:reachable", "ok", "HTTP %s" % r.status)
    except urllib.error.HTTPError as e:
        # Reachable but unhappy is still reachable; distinguish it from a dead tunnel.
        rep.add("second_brain:reachable", "warning", "HTTP %s" % e.code)
    except Exception as e:
        rep.add("second_brain:reachable", "warning", "unreachable: %s" % str(e)[:120])


# ── output ─────────────────────────────────────────────────────────────────

STATE_PATH = "/home/nullsafe/.nullsafe-health-state.json"
RENOTIFY_SECONDS = 12 * 3600


def _fingerprint(rep):
    """What is wrong, ignoring how long it has been wrong.

    Names + severities only, not details -- details carry counters ("37 pending", "last ran 51m ago")
    that change on every run, so including them would make every fingerprint unique and defeat the
    throttle entirely.
    """
    return ";".join(sorted("%s=%s" % (c["name"], c["severity"]) for c in rep.failures))


def should_notify(rep, always=False):
    """Throttle: speak on CHANGE, or every RENOTIFY_SECONDS while something is still wrong.

    Without this, cronning --notify would post the same two warnings every run for as long as they
    persist -- and guardian findings persist for days. A health check that cries wolf gets muted, and
    a muted health check is worse than none. Returns (bool, reason) so the decision is visible.

    Fails OPEN: if the state file cannot be read or written, notify. Silence must never be the
    consequence of a bookkeeping failure.
    """
    import time
    now = time.time()
    fp = _fingerprint(rep)
    sev = rep.severity

    prev = {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except FileNotFoundError:
        pass
    except Exception:
        return True, "state unreadable -- failing open"

    decided = None
    if always:
        decided = "forced (--always)"
    elif not rep.failures:
        # Recovery is news: say it once, then go quiet.
        decided = "recovered" if prev.get("severity") not in (None, "ok") else None
    elif fp != prev.get("fingerprint"):
        decided = "changed"
    elif now - float(prev.get("last_notified", 0)) > RENOTIFY_SECONDS:
        decided = "still wrong after %dh" % (RENOTIFY_SECONDS // 3600)

    if decided:
        try:
            with open(STATE_PATH, "w", encoding="utf-8") as fh:
                json.dump({"fingerprint": fp, "severity": sev, "last_notified": now}, fh)
        except Exception:
            pass  # already decided to notify; a failed write only costs a duplicate next run
        return True, decided

    # Record the observation even when staying quiet, so a fingerprint change is detected next time.
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump({
                "fingerprint": fp, "severity": sev,
                "last_notified": float(prev.get("last_notified", 0)),
            }, fh)
    except Exception:
        pass
    return False, "unchanged"


def telegram(text, hermes_env):
    tok = hermes_env.get("TELEGRAM_BOT_TOKEN")
    chat = hermes_env.get("TELEGRAM_HOME_CHANNEL")
    if not tok or not chat:
        return False, "token present=%s chat present=%s" % (bool(tok), bool(chat))
    try:
        body = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        with urllib.request.urlopen(
            "https://api.telegram.org/bot%s/sendMessage" % tok, data=body, timeout=20
        ) as r:
            return json.loads(r.read().decode()).get("ok", False), "sent"
    except Exception as e:
        return False, str(e)[:160]


def render(rep):
    icon = {"ok": "ok  ", "notice": "note", "warning": "WARN", "red": "RED "}
    lines = []
    sev = rep.severity
    lines.append("suite health: %s  (%d checks, %d not ok)" % (sev.upper(), len(rep.checks), len(rep.failures)))
    if rep.failures:
        lines.append("")
        for c in rep.failures:
            lines.append("  [%s] %-34s %s" % (icon[c["severity"]], c["name"], c["detail"]))
    return "\n".join(lines)


def render_full(rep):
    icon = {"ok": "ok  ", "notice": "note", "warning": "WARN", "red": "RED "}
    out = [render(rep), "", "all checks:"]
    for c in rep.checks:
        out.append("  [%s] %-34s %s" % (icon[c["severity"]], c["name"], c["detail"]))
    return "\n".join(out)


def main():
    args = set(sys.argv[1:])
    rep = Report()
    denv = read_env(DISCORD_ENV)
    henv = read_env(HERMES_ENV)

    try:
        check_pm2(rep)
        check_systemd(rep)
        check_hermes(rep)
        check_halseth(rep, denv)
        check_second_brain(rep, denv)
    except Exception as e:
        print("health-check itself failed: %s" % e, file=sys.stderr)
        return 3

    if "--json" in args:
        print(json.dumps({
            "severity": rep.severity,
            "ok": rep.severity in ("ok", "notice"),
            "failures": rep.failures,
            "checks": rep.checks,
        }, indent=2))
    else:
        print(render_full(rep) if "--all" in args else render(rep))

    if "--notify" in args:
        send, why = should_notify(rep, always="--always" in args)
        if send:
            # Telegram caps messages; the failures are what matter, so send those and a count.
            msg = render(rep)
            if not rep.failures:
                msg = "suite health: RECOVERED — all %d checks ok" % len(rep.checks)
            if len(msg) > 3500:
                msg = msg[:3500] + "\n... truncated"
            ok, note = telegram(msg, henv)
            print("telegram: %s (%s)" % ("sent" if ok else "FAILED: " + note, why),
                  file=sys.stderr if not ok else sys.stdout)
        elif "--verbose" in args:
            print("telegram: suppressed (%s)" % why)

    return EXIT_FOR[rep.severity]


if __name__ == "__main__":
    sys.exit(main())
