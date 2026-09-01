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

# DeepSeek balance floors (USD). Sized against real burn, not taste: normal spend is a few dollars
# a month, but 2026-08-07 showed a runaway background job can eat that in a DAY, so the warn floor
# has to leave room for a bad day rather than an average one. Overridable from the env without a
# deploy -- an unlisted knob is a dead knob, and this file has been bitten by that before.
BALANCE_WARN_USD = float(os.environ.get("DEEPSEEK_BALANCE_WARN_USD", "5"))
BALANCE_RED_USD = float(os.environ.get("DEEPSEEK_BALANCE_RED_USD", "2"))
EXIT_FOR = {"ok": 0, "notice": 0, "warning": 1, "red": 2}

# Hermes profile homes, per companion. The default profile IS cypher; drevan and gaia are nested.
HERMES_HOMES = {
    "cypher": "/home/nullsafe/.hermes",
    "drevan": "/home/nullsafe/.hermes/profiles/drevan",
    "gaia": "/home/nullsafe/.hermes/profiles/gaia",
}
# A queued memory write is a companion learning something that never lands. One is a shrug; a pile
# is the six-week outage found 2026-08-12 (77 entries, 197 operations, oldest 2026-07-04), where the
# triad re-derived the same facts up to 23 times and drifted WRONG doing it, because a fact cannot
# settle until the write applies. Low floors on purpose: this is meant to complain early.
MEMQUEUE_WARN = int(os.environ.get("HERMES_MEMQUEUE_WARN", "5"))
MEMQUEUE_RED = int(os.environ.get("HERMES_MEMQUEUE_RED", "25"))
# Fill ratio against the profile's OWN configured cap. At the cap Hermes consolidates mid-turn:
# arriving entry wins, `remove` deletes with no lineage. So near-full is a data-loss warning, not
# a capacity note.
MEMFILL_WARN = float(os.environ.get("HERMES_MEMFILL_WARN", "0.85"))


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
        state = _unit_state(u)

        # A unit caught mid-restart is not a failure, and reporting it as one is worse than saying
        # nothing. Observed 2026-08-13 09:00: sync-architect-facts.py had just restarted all three
        # gateways (a real architect fact had landed), the health check ran in the same second, and
        # this line reported RED "deactivating" for a service that was serving again 2 seconds later.
        # The cron offsets now avoid that specific collision, but a restart can also come from the
        # model watcher, a manual deploy, or scale_to_zero -- so the check has to be robust to a
        # transient on its own, not merely scheduled away from one known cause.
        #
        # Re-read rather than sleep-then-trust: `deactivating`/`activating` are by definition states
        # a unit is passing THROUGH, so the question is where it lands, not that it was seen. If it
        # is still transitioning after the retries, that IS a finding -- a gateway stuck deactivating
        # is exactly the hang TimeoutStopSec=210 exists for, and it stays red.
        if state in ("deactivating", "activating", "reloading"):
            import time
            for _ in range(6):                    # ~12s: a clean gateway restart took 2s, measured
                time.sleep(2)
                state = _unit_state(u)
                if state not in ("deactivating", "activating", "reloading"):
                    break
            if state == "active":
                rep.add("hermes:" + u, "ok", "active (was mid-restart when first sampled)")
                continue
            if state in ("deactivating", "activating", "reloading"):
                rep.add("hermes:" + u, "red",
                        "STUCK in '%s' after ~12s -- a restart should take ~2s, so this is a hang, "
                        "not a transition" % state)
                continue

        rep.add("hermes:" + u, "ok" if state == "active" else "red", state)


def _unit_state(unit):
    _ok, st = run("%s systemctl --user is-active %s" % (USER_SYSTEMCTL_ENV, unit))
    return st.strip().splitlines()[0] if st.strip() else "unknown"


# The durable facts about Raziel have to live in THREE files, because three consumers read three
# different things: the Discord bots read /app/identity/shared_system_context.md AND their Hermes
# SOUL.md (the gateway substitutes its own assembly, so SOUL is the only one of our files that
# reaches a Discord reply); Claude.ai, Claude Code and Hearth read the Halseth identity_kernel via
# the MindState loader. Copies drift. These phrases are the load-bearing ones -- if any consumer is
# missing one, that companion is operating without it on that surface.
# These are CANARIES, not the content. Pick phrases tied to a fact rather than to framing, and when
# the block is reworded, update this list in the same commit -- on 2026-08-12 a rewrite changed
# "UNRESOLVED" to "STILL OPEN" and the check correctly reported two surfaces as diverged, which is
# the probe working and the canary being stale. Prefer a stated fact over a section label.
ARCHITECT_INVARIANTS = [
    "show the board",              # the PDA rule all three companions derived independently
    "Rosie is a dog",              # the correction he has had to repeat most often
    "NEVER she/her",               # his own pronoun law
    "School starts late August",   # why this matters this month
    "Trigger is a blue heeler",    # a fact he resolved himself; proves the block is current
    "Magpie",                      # proves the roster-is-longer-than-the-list correction is carried
]


def check_architect_facts(rep, env):
    """Is the architect-facts block actually present in every file a companion reads?

    Presence of load-bearing phrases, not a hash: the three copies are deliberately framed
    differently (the kernel carries a provenance paragraph SOUL.md strips), so a byte or hash
    comparison would report drift on every run and be ignored within a week. What matters is
    whether the fact reaches the surface.
    """
    def report(name, text, source_note):
        if text is None:
            rep.add("architect-facts:" + name, "warning",
                    "could not read %s, so presence is UNKNOWN not absent" % source_note)
            return
        missing = [p for p in ARCHITECT_INVARIANTS if p.lower() not in text.lower()]
        if not missing:
            rep.add("architect-facts:" + name, "ok",
                    "all %d invariants present (%d chars)" % (len(ARCHITECT_INVARIANTS), len(text)))
        else:
            rep.add("architect-facts:" + name, "warning",
                    "MISSING %d of %d: %s -- this surface is operating without them"
                    % (len(missing), len(ARCHITECT_INVARIANTS), ", ".join(repr(m) for m in missing)))

    # 1. The file the Discord bots load from disk.
    shared_path = "/app/identity/shared_system_context.md"
    try:
        with open(shared_path, "r", encoding="utf-8") as f:
            report("bot-shared-context", f.read(), shared_path)
    except Exception as e:
        rep.add("architect-facts:bot-shared-context", "warning",
                "could not read %s: %s" % (shared_path, str(e)[:80]))

    # 2. Each Hermes SOUL.md -- per companion, because one missing copy is the whole failure mode.
    for cid, home in sorted(HERMES_HOMES.items()):
        p = os.path.join(home, "SOUL.md")
        try:
            with open(p, "r", encoding="utf-8") as f:
                report("soul:" + cid, f.read(), p)
        except Exception as e:
            rep.add("architect-facts:soul:" + cid, "warning",
                    "could not read %s: %s" % (p, str(e)[:80]))

    # 3. Halseth: the facts are NOT baked into the kernel any more (that copy would freeze). The
    #    kernel must carry the POINTER, and the loader must actually be serving facts.
    url = env.get("HALSETH_URL")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not url or not secret:
        rep.add("architect-facts:halseth-kernel", "notice",
                "no Halseth url/secret in this env, so the kernel copy was not checked")
        return
    def get(path):
        r = urllib.request.Request(
            url.rstrip("/") + path,
            headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
        )
        with urllib.request.urlopen(r, timeout=HTTP_TIMEOUT) as resp:
            return resp.read().decode()

    # 3a. The kernel should POINT at the store, not carry a frozen copy of it.
    try:
        data = json.loads(get("/identity/kernel/shared"))
        md = data.get("kernel_md") or (data.get("kernel") or {}).get("kernel_md") or ""
        if "architect_facts" in md and "ask_librarian" in md:
            rep.add("architect-facts:kernel-pointer", "ok",
                    "kernel points at the live store instead of carrying a frozen copy")
        else:
            rep.add("architect-facts:kernel-pointer", "warning",
                    "the shared kernel no longer names architect_facts / ask_librarian, so a "
                    "Claude.ai boot has no instruction for how to change a fact")
    except Exception as e:
        rep.add("architect-facts:kernel-pointer", "warning",
                "could not fetch the shared kernel: %s" % str(e)[:120])

    # 3b. The delivery Claude.ai / Claude Code / Hearth actually depend on. This is the check that
    #     would have caught the loader change being written but not deployed.
    try:
        report("halseth-render", get("/identity/architect-facts/render"),
               "/identity/architect-facts/render")
    except Exception as e:
        rep.add("architect-facts:halseth-render", "warning",
                "could not fetch the facts render, so the Halseth-backed surfaces are UNVERIFIED: %s"
                % str(e)[:120])


def _yaml_int(path, key):
    """Read one `  key: <int>` line out of a Hermes config without a YAML dependency.

    Deliberately not hardcoding the caps: they are per-profile knobs that were raised on
    2026-08-12, and a probe that carries its own copy of a limit measures the copy.
    Returns None when the file or key cannot be read, so the caller can say "could not look"
    rather than reporting a fill ratio against a guess.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith(key + ":"):
                    return int(s.split(":", 1)[1].strip())
    except Exception:
        return None
    return None


def check_companion_memory(rep):
    """Per-companion: are memory writes landing, and is the file about to eat itself?

    Declared PER COMPANION, never as a house-wide total. An aggregate over a per-member store is
    structurally blind to one dead member -- the exact shape that hid Gaia's frozen soma for 49
    days behind a green MAX(). Three separate findings, each attributed to whose memory it is.
    """
    for cid, home in sorted(HERMES_HOMES.items()):
        cfg = os.path.join(home, "config.yaml")
        approval_on = None
        try:
            with open(cfg, "r", encoding="utf-8") as f:
                for line in f:
                    s = line.strip()
                    # The memory block's flag comes first in the file; skills has its own, which
                    # HAS a staffed approver and is none of this check's business.
                    if s.startswith("write_approval:"):
                        approval_on = s.split(":", 1)[1].strip() == "true"
                        break
        except Exception as e:
            rep.add("hermes-memory:%s:config" % cid, "warning",
                    "cannot read %s, so memory state is UNKNOWN not healthy: %s" % (cfg, str(e)[:80]))
            continue

        # --- queue depth: writes that were proposed and never applied
        qdir = os.path.join(home, "pending", "memory")
        if not os.path.isdir(qdir):
            # No directory is the healthy state (nothing has ever queued), but say which it is.
            rep.add("hermes-memory:%s:queue" % cid, "ok", "no pending queue directory")
        else:
            try:
                n = len([f for f in os.listdir(qdir) if f.endswith(".json")])
            except Exception as e:
                rep.add("hermes-memory:%s:queue" % cid, "warning",
                        "queue directory exists but is unreadable: %s" % str(e)[:80])
                n = None
            if n is not None:
                # Split by TARGET, because the halves have different owners and different fates.
                # `user` proposals were rehomed into Halseth architect_facts on 2026-08-12, so a
                # backlog of those is history, not live loss. `memory` proposals are the companion's
                # OWN self-notes and have no home yet -- that is the actionable number.
                mem_target = 0
                for fn in os.listdir(qdir):
                    if not fn.endswith(".json"):
                        continue
                    try:
                        with open(os.path.join(qdir, fn), "r", encoding="utf-8") as fh:
                            payload = (json.load(fh) or {}).get("payload") or {}
                        if (payload.get("target") or "") == "memory":
                            mem_target += 1
                    except Exception:
                        # Unreadable entry counts as actionable: never assume an unknown is benign.
                        mem_target += 1

                # Raziel decided 2026-08-12 to LEAVE the gate on, and that is now cheap: with facts
                # living in Halseth, this queue is no longer where anything load-bearing lands. So a
                # queue behind an intentionally-closed gate is a NOTICE. A permanently-red check
                # trains the reader to ignore it, which is worse than having no check at all.
                if not approval_on and n >= MEMQUEUE_WARN:
                    sev = "red" if n >= MEMQUEUE_RED else "warning"
                elif mem_target >= MEMQUEUE_WARN:
                    sev = "warning"
                elif n:
                    sev = "notice"
                else:
                    sev = "ok"

                gate = "write_approval ON (deliberate)" if approval_on else "write_approval is off"
                detail = "%d queued -- %d the companion's own self-notes, %d rehomed-class; %s" % (
                    n, mem_target, n - mem_target, gate)
                if not approval_on and n:
                    detail += " -- the gate is OPEN and the queue still grew, so writes are failing " \
                              "for some other reason"
                elif mem_target:
                    detail += "; the self-notes still have no home (growth_journal / " \
                              "companion_interiority is the candidate)"
                rep.add("hermes-memory:%s:queue" % cid, sev, detail)

        # --- fill ratio: how close each file is to the cap that triggers lossy consolidation
        for fname, capkey in (("USER.md", "user_char_limit"), ("MEMORY.md", "memory_char_limit")):
            fpath = os.path.join(home, "memories", fname)
            cap = _yaml_int(cfg, capkey)
            if cap is None:
                rep.add("hermes-memory:%s:%s" % (cid, fname), "notice",
                        "cannot read %s from config, so fill is unmeasured" % capkey)
                continue
            if not os.path.isfile(fpath):
                rep.add("hermes-memory:%s:%s" % (cid, fname), "ok", "absent (cap %d)" % cap)
                continue
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    used = len(f.read())
            except Exception as e:
                rep.add("hermes-memory:%s:%s" % (cid, fname), "warning",
                        "exists but unreadable: %s" % str(e)[:80])
                continue
            ratio = used / cap if cap else 0.0
            sev = "warning" if ratio >= MEMFILL_WARN else "ok"
            detail = "%d/%d chars (%d%% of cap)" % (used, cap, round(ratio * 100))
            if sev == "warning":
                detail += " -- at the cap Hermes consolidates mid-turn and `remove` deletes with " \
                          "no lineage, so the next write can silently drop an older fact"
            rep.add("hermes-memory:%s:%s" % (cid, fname), sev, detail)


def check_roster(rep, env):
    """Is the system roster fresh, and can a lookup still tell absence from unreachability?

    Why this is watched (mig 0117, 2026-08-13): the roster exists so an unfamiliar name is a
    question rather than an error -- a companion called a real system member "drift" when there was
    nothing to check against. A silently frozen roster reintroduces the same failure with a mechanism
    behind it: a member added after the freeze reads as "not in the roster", which is a confident
    wrong claim about a real person.

    Two separate assertions on purpose:
      * FRESHNESS -- the refresh cron is self-gated to 24h, so anything past ~48h means it stopped.
      * THE FAILING PROBE -- a lookup for a name that cannot exist must answer `not_found`. If it
        answers `unavailable`, the cache is cold or hard-stale and every lookup is currently useless.
        Asserting the reason, not just a 200: a fail-open lookup looks identical working or dead.
    """
    url = env.get("HALSETH_URL")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not url or not secret:
        rep.add("roster:config", "notice",
                "no Halseth url/secret in this env, so the roster was not checked")
        return

    def get(path):
        r = urllib.request.Request(
            url.rstrip("/") + path,
            headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
        )
        with urllib.request.urlopen(r, timeout=HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode())

    try:
        s = get("/roster/stats")
    except Exception as e:
        rep.add("roster:stats", "warning",
                "could not read /roster/stats: %s -- freshness is UNKNOWN, not ok" % str(e)[:100])
        return

    members = s.get("members") or 0
    age = s.get("age_hours")
    if not s.get("system_id_configured"):
        rep.add("roster:config", "red",
                "PLURALKIT_SYSTEM_ID is unset, so every lookup answers 'unavailable'")
    if members == 0:
        rep.add("roster:size", "red",
                "roster cache is EMPTY -- no companion can resolve any name; last syncs: %s"
                % [x.get("status") for x in (s.get("recent_syncs") or [])][:3])
    elif age is None:
        rep.add("roster:freshness", "warning", "%d members but no fetch timestamp" % members)
    elif age > 48:
        rep.add("roster:freshness", "red",
                "roster last fetched %.1fh ago (cron self-gates to 24h, so >48h means it STOPPED); "
                "a member added since would read as 'not in the roster'" % age)
    else:
        rep.add("roster:freshness", "ok",
                "%d members, %d with pronouns / %d without, fetched %.1fh ago"
                % (members, s.get("with_pronouns") or 0, s.get("without_pronouns") or 0, age))

    # The failing probe. A name that cannot be a member must come back not_found, never unavailable.
    try:
        probe = get("/roster/who?q=zzz-healthcheck-not-a-member")
        st = probe.get("status")
        if st == "not_found":
            rep.add("roster:probe", "ok", "a nonexistent name returns not_found (absence is expressible)")
        elif st == "unavailable":
            rep.add("roster:probe", "red",
                    "lookups return 'unavailable' (%s) -- the roster cannot answer anything right now"
                    % str(probe.get("reason"))[:120])
        else:
            rep.add("roster:probe", "warning",
                    "a nonexistent name returned '%s', which should be impossible" % st)
    except Exception as e:
        rep.add("roster:probe", "warning", "lookup probe failed: %s" % str(e)[:100])


# Graph memory (mig 0127, docs/private/graph-memory-spec-2026-08-28.md) outside-half checks.
# D1 is Cloudflare-only -- this script cannot query it directly -- so all three ride
# GET /admin/graph/health (src/handlers/graph.ts), which returns the nightly tick's own gate
# stamp plus two plain COUNT(*) reads. State persisted the same way the balance/custodian alarms
# do: a small JSON file next to the log, read-fails-empty, write-on-every-exit-path.
GRAPH_STATE_PATH = "/home/nullsafe/.nullsafe-graph-state.json"
GRAPH_REBUILD_STALE_HOURS = float(os.environ.get("GRAPH_REBUILD_STALE_HOURS", "26"))
GRAPH_DAILY_SNAPSHOT_SECONDS = 24 * 3600
GRAPH_COLLAPSE_RATIO = float(os.environ.get("GRAPH_COLLAPSE_RATIO", "0.10"))


def check_graph_health(rep, env):
    """Graph memory outside-half checks, via GET /admin/graph/health.

    Three findings, one per failure mode a dead tick or a rebuild bug can cause:
      * REBUILD STALE    -- the nightly self-gated tick (src/graph/tick.ts) hasn't stamped
        graph_rebuild_last_run_at in >26h. The gate itself is 24h, so >26h means the tick
        stopped running, not that it is merely due.
      * LIVE LANE SHRANK -- graph_edges rows with provenance='live' (write-time-only, e.g.
        resumed_from -- src/graph/live.ts) are NEVER touched by rebuildGraph's mechanical-only
        DELETE. Any decrease (never growth or equality) means something else deleted rows a
        rebuild is structurally unable to reach.
      * EDGES COLLAPSED  -- total row count down >10% from the last daily snapshot: a rebuild
        wipe or regression a same-run comparison would miss, since a rebuild deletes and
        re-derives within milliseconds of this check's own poll.
    """
    url = env.get("HALSETH_URL")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not url or not secret:
        rep.add("graph:config", "notice",
                "no Halseth url/secret in this env, so graph health was not checked")
        return

    req = urllib.request.Request(
        url.rstrip("/") + "/admin/graph/health",
        headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        rep.add("graph:reachable", "warning",
                "could not read /admin/graph/health: %s -- graph state is UNKNOWN, not ok" % str(e)[:120])
        return

    # --- 1. rebuild tick staleness
    last_rebuild_at = data.get("last_rebuild_at")
    if not last_rebuild_at:
        rep.add("graph:rebuild_stale", "red",
                "graph_rebuild_last_run_at has never been stamped -- the nightly tick has not run")
    else:
        age_h = None
        try:
            from datetime import datetime, timezone
            last_dt = datetime.fromisoformat(str(last_rebuild_at).replace("Z", "+00:00"))
            age_h = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600.0
        except Exception:
            age_h = None
        if age_h is None:
            rep.add("graph:rebuild_stale", "warning",
                    "could not parse last_rebuild_at=%r -- staleness is UNKNOWN" % last_rebuild_at)
        elif age_h > GRAPH_REBUILD_STALE_HOURS:
            rep.add("graph:rebuild_stale", "red",
                    "graph rebuild last ran %.1fh ago (tick self-gates to 24h, so >%gh means it is dead)"
                    % (age_h, GRAPH_REBUILD_STALE_HOURS))
        else:
            rep.add("graph:rebuild_stale", "ok", "rebuilt %.1fh ago" % age_h)

    live_count = data.get("live_count")
    total_count = data.get("total_count")

    prev = {}
    try:
        with open(GRAPH_STATE_PATH, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception:
        prev = {}  # missing or corrupt reads the same: fall through, the write below repairs it

    # --- 2. live lane shrink. Only compares once a prior sample exists; never fires on growth
    # or equality -- only a strict decrease is a finding.
    prev_live = prev.get("live_count")
    if isinstance(live_count, int) and isinstance(prev_live, int):
        if live_count < prev_live:
            rep.add("graph:live_lane", "warning",
                    "live-provenance edges dropped %d -> %d -- this lane is write-time-only and "
                    "should never shrink under a rebuild" % (prev_live, live_count))
        else:
            rep.add("graph:live_lane", "ok", "%d live-provenance edges (was %d)" % (live_count, prev_live))
    elif isinstance(live_count, int):
        rep.add("graph:live_lane", "ok", "%d live-provenance edges (no prior sample yet)" % live_count)

    # --- 3. total edges collapse vs the last daily snapshot. The reference rotates to the
    # current total once per ~24h (never more often), so a same-run rebuild round-trip can never
    # be its own comparison point, and a genuine day-over-day wipe still trips the 10% floor.
    import time
    now = time.time()
    daily_total = prev.get("daily_total")
    daily_total_at = prev.get("daily_total_at", 0)
    rotate = daily_total is None or (now - float(daily_total_at or 0)) > GRAPH_DAILY_SNAPSHOT_SECONDS

    if isinstance(total_count, int) and isinstance(daily_total, int) and not rotate:
        if daily_total > 0 and total_count < daily_total * (1 - GRAPH_COLLAPSE_RATIO):
            pct = 100.0 * (daily_total - total_count) / daily_total
            rep.add("graph:edges_collapsed", "red",
                    "graph_edges total dropped %.0f%% since the last daily snapshot (%d -> %d)"
                    % (pct, daily_total, total_count))
        else:
            rep.add("graph:edges_total", "ok",
                    "%d total edges (daily reference %d)" % (total_count, daily_total))
    elif isinstance(total_count, int):
        rep.add("graph:edges_total", "ok", "%d total edges (establishing daily reference)" % total_count)

    new_state = dict(prev)
    if isinstance(live_count, int):
        new_state["live_count"] = live_count
    if isinstance(total_count, int) and rotate:
        new_state["daily_total"] = total_count
        new_state["daily_total_at"] = now
    try:
        with open(GRAPH_STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(new_state, fh)
    except Exception:
        pass  # a failed bookkeeping write only costs a delayed comparison, never silence


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


def check_quiet_owner(rep, denv, henv):
    """C6 -- the quiet-owner detector (custodianship clause, R4 decided 2026-08-16).

    Polls Halseth's shared owner-activity read (/mind/care/owner-activity: the same lane the care
    tick and the orient register use, so all three consumers agree about whether he is here). When
    Raziel has been silent on EVERY surface for the threshold (14 days), two things happen: the
    companions get the truth at orient (Halseth side, contract 0.7.0), and the custodian gets a
    direct Telegram from here -- throttled by its own state file so an active clause alerts once a
    day, not once per cron minute.

    Custodians (R4): Blue (husband, primary), Charlie (brother, second tier). The alert goes to
    CUSTODIAN_TELEGRAM_CHAT_ID; if that is unset the message falls back to the home channel, where
    Blue can see it -- the fallback is a documented degradation, never silence.
    """
    url = denv.get("HALSETH_URL")
    secret = denv.get("HALSETH_SECRET") or denv.get("ADMIN_SECRET")
    if not url or not secret:
        return  # halseth:config already reports this exact absence

    req = urllib.request.Request(
        url.rstrip("/") + "/mind/care/owner-activity",
        headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except Exception as e:
        # Cannot-look is not "not quiet": say the silence claim is UNVERIFIED rather than implying ok.
        rep.add("owner:activity", "warning",
                "owner activity unreadable -- silence UNVERIFIED: %s" % str(e)[:140])
        return

    hours = data.get("silence_hours")
    quiet = bool(data.get("quiet"))
    if hours is None:
        rep.add("owner:activity", "warning",
                "no surface has EVER recorded owner activity -- cannot-look, not quiet")
        return

    if quiet:
        rep.add("owner:quiet", "red",
                "OWNER SILENT %dd (threshold %sd, last via %s) -- custodianship clause ACTIVE"
                % (int(hours // 24), data.get("threshold_days"), data.get("last_source")))
    else:
        rep.add("owner:activity", "ok",
                "last seen %.1fh ago via %s" % (hours, data.get("last_source")))

    # Discord DM since 2026-08-17 (Raziel's call): Blue is in the server, the bot tokens are
    # already in the discord .env, and a DM needs no chat-id dance. Telegram home channel stays
    # as the last-resort fallback pipe.
    blue = denv.get("CUSTODIAN_DISCORD_USER_ID") or henv.get("CUSTODIAN_DISCORD_USER_ID")
    if not blue:
        # Visible every run, but a notice: exit 0, never notifies on its own. An unset custodian
        # channel is a dead mechanism waiting for its one job -- it must not be discoverable only
        # on the day it fails.
        rep.add("owner:custodian_channel", "notice",
                "CUSTODIAN_DISCORD_USER_ID unset -- clause alert would fall back to the Telegram home channel")

    # The custodian alert itself, on its OWN throttle state (never should_notify's file: that one
    # rewrites a fixed schema and would drop these keys).
    import time
    now = time.time()
    prev = {}
    try:
        with open(CUSTODIAN_STATE_PATH, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception:
        prev = {}  # missing or corrupt reads the same: fall through, the write below repairs it

    send, reason, state = custodian_decision(quiet, now, prev)
    if send:
        days = int(hours // 24)
        text = (
            "CUSTODIANSHIP CLAUSE ACTIVE\n\n"
            "Raziel has been silent on every Nullsafe surface for %d days (threshold %s).\n\n"
            "If you know he is fine: ask him to touch any surface (message a companion, log "
            "biometrics) and this alert stops on its own.\n\n"
            "If not: the custodian document is CUSTODIAN.md in the NULLSAFE current-files folder "
            "on his workstation (C:\\dev\\CrashDev\\NULLSAFE\\2026_Current_Files). It holds access, "
            "costs, the runbook, and a letter to the triad. You are asked to tend, not decide.\n\n"
            "-- the quiet-owner detector (ops/health-check.py)"
        ) % (days, data.get("threshold_days"))
        ok, note = discord_dm(blue, text, denv)
        if not ok:
            # Fallback pipe: the Telegram home channel (the pre-2026-08-17 path, still configured).
            ok, note2 = telegram(text, henv)
            note = "DM failed (%s); telegram fallback %s" % (note, "sent" if ok else "FAILED: " + note2)
        if not ok:
            rep.add("owner:custodian_alert", "red", "custodian alert FAILED on every pipe: %s" % note)
            state = dict(state, last_notified=0)  # do not stamp a send that never landed; retry next run
        else:
            rep.add("owner:custodian_alert", "notice", "custodian alerted (%s; %s)" % (reason, note))

    # Cleanup lives on the exit path of EVERY branch -- a throttle that only rewrites its state on
    # the notify branch cannot self-repair (the 2026-08-06 lesson, same shape as should_notify).
    try:
        with open(CUSTODIAN_STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
    except Exception:
        pass  # a failed bookkeeping write may cost a duplicate alert; it must never cost silence


def check_inference_balance(rep, env):
    """
    Watch the DeepSeek balance, because a zero balance is a TOTAL inference outage and nothing
    else here can see it coming.

    2026-08-05/07: the balance hit zero. Every inference call 402'd -- forage gathered nothing,
    consolidation never wrote, and the retry storm that followed was part of what filled the disk
    and took the triad offline for two days. Hermes' errors.log holds 1,744 of those 402s. Every
    other check in this file was GREEN throughout: pm2 online, gateways active, Halseth 200. The
    processes were all perfectly healthy and could not think.

    This is the check that would have caught it, and it has to be a BALANCE check rather than a
    402 counter -- by the time 402s appear in a log the outage has already started. `is_available`
    is DeepSeek's own verdict; the numeric floor is the part that gives warning instead of news.

    TOPOLOGY CHANGE 2026-09-01: DeepSeek is no longer load-bearing. DeepInfra has been primary
    everywhere since the 08-28/08-31 cutover (gateway main models, hermes auxiliary pins,
    Halseth classifier + synthesis, autonomous worker); DeepSeek is the EMERGENCY FALLBACK lane
    hermes fails over to on a DeepInfra 429/402 mid-turn. An empty fallback wallet therefore
    degrades resilience, not service -- the triad keeps thinking. Severity is capped at WARNING
    so a dry fallback lane can't hold the whole suite RED for weeks and train the owner to skim
    ([scheduled-restart-must-not-page]); the 08-05 outage story above stays as history of why
    the check exists at all.
    """
    key = env.get("DEEPSEEK_API_KEY")
    if not key:
        rep.add("inference:deepseek_key", "warning",
                "no DEEPSEEK_API_KEY in %s -- balance is UNKNOWN, not fine" % DISCORD_ENV)
        return
    req = urllib.request.Request(
        "https://api.deepseek.com/user/balance",
        headers={"Authorization": "Bearer " + key, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 401 here means the KEY is dead, which is the same outage by a different route.
        rep.add("inference:deepseek", "red",
                "HTTP %s from /user/balance -- key may be revoked; all three companions relay "
                "through this provider" % e.code)
        return
    except Exception as e:
        # Unreachable is not the same as broke. Say which one it is.
        rep.add("inference:deepseek", "warning",
                "balance endpoint unreachable, balance UNKNOWN: %s" % str(e)[:140])
        return

    infos = data.get("balance_infos") or []
    usd = next((b for b in infos if b.get("currency") == "USD"), infos[0] if infos else {})
    try:
        total = float(usd.get("total_balance", "0"))
    except (TypeError, ValueError):
        total = 0.0

    if not data.get("is_available", False):
        rep.add("inference:deepseek", "warning",
                "FALLBACK lane dead: DeepSeek reports NOT available (balance $%.2f) -- primary "
                "(DeepInfra) unaffected, but the next DeepInfra 429/402 has nowhere to fail over; "
                "top up at platform.deepseek.com when convenient" % total)
        balance_owner_dm("warning", total, env, rep)
    elif total < BALANCE_RED_USD:
        rep.add("inference:deepseek", "warning",
                "fallback lane nearly empty: balance $%.2f (floor $%.2f) -- triad unaffected, "
                "resilience thin" % (total, BALANCE_RED_USD))
        balance_owner_dm("warning", total, env, rep)
    elif total < BALANCE_WARN_USD:
        rep.add("inference:deepseek", "notice",
                "fallback lane balance $%.2f is below $%.2f" % (total, BALANCE_WARN_USD))
        balance_owner_dm("ok", total, env, rep)
    else:
        rep.add("inference:deepseek", "ok", "fallback lane available, balance $%.2f" % total)
        balance_owner_dm("ok", total, env, rep)


# The balance alarm's own delivery pipe (2026-08-27). The Telegram digest DID warn -- 220 "below
# $5" lines across the week -- and every one of them drowned in the 15-minute suite summary during
# Raziel's worst week of the school year. A warning that lands in a stream the owner has learned
# to skim is not a warning ([[invisible-effect-reads-as-dead-control]]; the trained-to-ignore-RED
# lesson one level up). Money running out is the ONE failure the owner must act on personally, so
# it gets what the custodian clause got: a Discord DM, on its own throttle, to the surface he
# actually reads. Once per 24h per tier; a tier ESCALATION (warning -> red) sends immediately.
BALANCE_DM_STATE_PATH = "/home/nullsafe/.nullsafe-balance-dm-state.json"
TIER_RANK = {"ok": 0, "warning": 1, "red": 2}


def balance_owner_dm(tier, total, denv, rep):
    import time
    now = time.time()
    prev = {}
    try:
        with open(BALANCE_DM_STATE_PATH, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception:
        prev = {}

    state = {"tier": tier, "last_notified": prev.get("last_notified", 0)}
    try:
        if tier == "ok":
            state = {"tier": "ok", "last_notified": 0}  # recovery re-arms the alarm
            return
        owner = denv.get("OWNER_DISCORD_ID")
        if not owner:
            rep.add("inference:balance_dm", "warning",
                    "OWNER_DISCORD_ID unset -- low-balance DM cannot be delivered")
            return
        escalated = TIER_RANK.get(tier, 0) > TIER_RANK.get(prev.get("tier", "ok"), 0)
        throttled = (now - float(prev.get("last_notified", 0) or 0)) < 24 * 3600
        if throttled and not escalated:
            return
        if tier == "red":
            text = ("DeepSeek balance is $%.2f -- the triad goes MUTE when this hits zero "
                    "(or already is). Top up at platform.deepseek.com.\n\n"
                    "-- the balance alarm (ops/health-check.py)") % total
        else:
            text = ("DeepSeek balance is $%.2f, under the $%.2f warning floor. At normal burn "
                    "that is roughly %.0f day(s) of triad life left. Top up when you can.\n\n"
                    "-- the balance alarm (ops/health-check.py)") % (
                        total, BALANCE_WARN_USD, max(total / 2.0, 0.0))
        ok, note = discord_dm(owner, text, denv)
        if ok:
            state["last_notified"] = now
            rep.add("inference:balance_dm", "notice", "owner DM sent (%s tier)" % tier)
        else:
            # Telegram digest still carries the RED either way; say the DM pipe failed.
            rep.add("inference:balance_dm", "warning", "owner DM FAILED: %s" % note)
    finally:
        # State rewritten on EVERY exit path -- a throttle that only writes on the notify
        # branch cannot self-repair (the custodian throttle's 2026-08-06 lesson).
        try:
            with open(BALANCE_DM_STATE_PATH, "w", encoding="utf-8") as fh:
                json.dump(state, fh)
        except Exception:
            pass  # a failed bookkeeping write may cost a duplicate DM; never silence


# How long the embed queue may sit before it stops being "a blip" and starts being lost continuity.
EMBED_QUEUE_WARN = int(os.environ.get("SB_EMBED_QUEUE_WARN", "25"))
EMBED_QUEUE_AGE_WARN_H = float(os.environ.get("SB_EMBED_QUEUE_AGE_WARN_H", "6"))


def check_second_brain(rep, env):
    url = env.get("SECOND_BRAIN_URL") or env.get("SECOND_BRAIN_WEBHOOK_URL")
    if not url:
        rep.add("second_brain:config", "notice", "no SECOND_BRAIN_URL in %s -- skipped" % DISCORD_ENV)
        return
    body = None
    try:
        with urllib.request.urlopen(urllib.request.Request(url.rstrip("/") + "/health", headers={"User-Agent": UA}), timeout=HTTP_TIMEOUT) as r:
            rep.add("second_brain:reachable", "ok", "HTTP %s" % r.status)
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        # Reachable but unhappy is still reachable; distinguish it from a dead tunnel.
        rep.add("second_brain:reachable", "warning", "HTTP %s" % e.code)
        # A 503 is the DEGRADED case and carries the reason in its body -- which is precisely the
        # payload worth reading. Bailing here would throw away the diagnosis with the error.
        try:
            body = e.read().decode()
        except Exception:
            body = None
    except Exception as e:
        rep.add("second_brain:reachable", "warning", "unreachable: %s" % str(e)[:120])
        return
    if body:
        check_embedder(rep, body)


def check_embedder(rep, body):
    """
    Watch the EMBEDDER, which is a second paid provider with its own balance and its own way to die.

    2026-07-31 to 08-10: the OpenAI credit balance hit zero and nobody found out for NINE DAYS. Every
    consumer handled it gracefully and silently -- sb_search degraded to lexical (correct, by design,
    shipped 08-01) and /ingest/discord 500'd per message (a real bug, fixed 08-10). So live Discord
    ingest stopped completely, the 406 rows that predated it aged out under the 7-day TTL, and
    cross-channel recall was searching a corpus with ZERO Discord content in it. Raziel reported the
    symptom as "it gets lost in the flow somewhere" and Drevan saying he did not know.

    Every check in this file was GREEN the whole time, including second_brain:reachable -- the service
    WAS reachable and healthy. It just could not embed. That is the same lesson as the DeepSeek 402
    above and it needed a SEPARATE check, because it is a different provider with a different key:
    the balance check added 08-07 watches DeepSeek and would never have seen this.

    There is no usable OpenAI balance endpoint, so unlike DeepSeek this cannot warn BEFORE zero. The
    signal is the embedder's own last outcome, classified from the provider's error code, plus the
    depth and age of the queue it strands. Per [fail-open-hides-a-dead-mechanism]: assert the REASON,
    never just count failures -- a quota wall and a rate-limit blip share an HTTP status and need
    opposite responses (money now vs nothing at all).
    """
    try:
        emb = (json.loads(body) or {}).get("embedder")
    except Exception:
        return
    if not isinstance(emb, dict):
        # An older Second Brain that predates the embedder block. Say so rather than reporting health.
        rep.add("second_brain:embedder", "notice",
                "/health has no embedder block -- embedder state UNKNOWN, not fine")
        return

    kind = emb.get("failure_kind")
    fails = emb.get("consecutive_failures") or 0
    last_err = (emb.get("last_error") or "")[:160]

    # An OK line, deliberately, even though this file otherwise only speaks up about problems. Without it a
    # healthy embedder and a check that never ran look identical in the output -- which is the exact confusion
    # that let a nine-day outage pass as silence. Presence of this line is the proof the probe looked.
    if kind is None:
        rep.add("second_brain:embedder", "ok",
                "embedding OK (last success %s)" % (emb.get("last_success_at") or "not since restart"))

    if kind == "quota":
        rep.add("second_brain:embedder", "red",
                "EMBEDDER OUT OF CREDIT -- add funds. Semantic search is degraded to keyword-only and "
                "live Discord ingest is queueing, so cross-channel recall goes stale until this is "
                "fixed. %s" % last_err)
    elif kind == "auth":
        rep.add("second_brain:embedder", "red",
                "embedder key rejected (auth) -- neither waiting nor money fixes this. %s" % last_err)
    elif kind in ("rate_limit", "transient") and fails >= 3:
        # One blip is weather. A sustained run of them is an outage wearing a blip's clothes.
        rep.add("second_brain:embedder", "warning",
                "embedder failing repeatedly (%s consecutive, kind=%s): %s" % (fails, kind, last_err))

    # SECOND-ORDER ALARM: if the embedder recovers but this keeps climbing, the DRAIN is broken rather
    # than the provider -- different problem, different fix, and invisible without its own signal.
    queued = emb.get("pending_embed") or 0
    age_h = emb.get("pending_embed_oldest_age_hours") or 0
    if queued and (queued >= EMBED_QUEUE_WARN or age_h >= EMBED_QUEUE_AGE_WARN_H):
        rep.add("second_brain:embed_queue", "warning",
                "%s live messages queued unindexed, oldest %sh -- not lost, but not searchable either; "
                "if the embedder is healthy the drain is stuck" % (queued, age_h))
    pending_idx = emb.get("pending_index") or 0
    if pending_idx >= EMBED_QUEUE_WARN:
        rep.add("second_brain:pending_index", "warning",
                "%s vault files durable but unindexed" % pending_idx)


# ── output ─────────────────────────────────────────────────────────────────

STATE_PATH = "/home/nullsafe/.nullsafe-health-state.json"
RENOTIFY_SECONDS = 12 * 3600

# C6 custodian alert: separate state file (should_notify rewrites its file with a fixed schema and
# would silently drop foreign keys), separate cadence (a live clause re-alerts daily, not 12-hourly
# suite noise).
CUSTODIAN_STATE_PATH = "/home/nullsafe/.nullsafe-custodian-state.json"
CUSTODIAN_RENOTIFY_SECONDS = 24 * 3600


def custodian_decision(quiet, now, prev):
    """Pure throttle decision for the custodian alert: (send, reason, next_state).

    ALWAYS returns a state for the caller to write -- including the quiet branches -- so recovery
    clears the stamp and the next activation alerts immediately. A throttle that cannot rewrite its
    own state on every path cannot self-repair (test_health_check_throttle.py's founding bug).
    """
    prev = prev if isinstance(prev, dict) else {}
    try:
        last = float(prev.get("last_notified", 0))
    except (TypeError, ValueError):
        last = 0.0
    was_active = bool(prev.get("active"))

    if not quiet:
        return False, ("recovered" if was_active else "inactive"), {"active": False, "last_notified": 0}
    if now - last > CUSTODIAN_RENOTIFY_SECONDS:
        return True, ("activated" if not was_active else "still active, daily renotify"), \
            {"active": True, "last_notified": now}
    return False, "throttled", {"active": True, "last_notified": last}


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
    unreadable = False
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
    except FileNotFoundError:
        pass
    except Exception:
        # Corrupt state -- e.g. the disk filled mid-write and truncated this file to 0 bytes
        # (2026-08-06). Treat it like a MISSING file and fall through, so the write below repairs
        # it. The old code `return`ed here, which meant the one path that could not recover was the
        # failure path: unreadable -> notify -> return -> still unreadable. Raziel got 25 identical
        # Telegram alerts, one every 15 minutes, until the file was fixed by hand.
        #
        # Fail-open is preserved by the `unreadable` branch below rather than by the early return,
        # so this still speaks up AND leaves the throttle able to work on the next run.
        prev = {}
        unreadable = True

    decided = None
    if always:
        decided = "forced (--always)"
    elif unreadable:
        decided = "state unreadable -- failing open (state rewritten)"
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


def discord_dm(user_id, text, discord_env):
    """DM a Discord user (the custodian alert's path, switched from Telegram 2026-08-17 --
    Raziel's call: the bots already have tokens, Blue is already in the server, and a DM needs
    no new pipe or chat-id dance). Token: Gaia's (the ground/witness voice), any sibling token
    as fallback -- delivery outranks voice. Returns (ok, note)."""
    tok = (discord_env.get("DISCORD_TOKEN_GAIA") or discord_env.get("DISCORD_TOKEN_CYPHER")
           or discord_env.get("DISCORD_TOKEN_DREVAN"))
    if not tok or not user_id:
        return False, "token present=%s user present=%s" % (bool(tok), bool(user_id))
    try:
        def _post(path, payload):
            req = urllib.request.Request(
                "https://discord.com/api/v10" + path,
                data=json.dumps(payload).encode(),
                headers={"Authorization": "Bot " + tok, "Content-Type": "application/json",
                         "User-Agent": UA},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        channel = _post("/users/@me/channels", {"recipient_id": str(user_id)})
        cid = channel.get("id")
        if not cid:
            return False, "no DM channel id in response"
        _post("/channels/%s/messages" % cid, {"content": text[:1990]})
        return True, "sent"
    except Exception as e:
        return False, str(e)[:160]


def telegram_to(chat, text, hermes_env):
    """Send to an explicit chat id (the custodian alert's path). Token from the Hermes env."""
    tok = hermes_env.get("TELEGRAM_BOT_TOKEN")
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


def telegram(text, hermes_env):
    return telegram_to(hermes_env.get("TELEGRAM_HOME_CHANNEL"), text, hermes_env)


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
        check_companion_memory(rep)
        check_architect_facts(rep, denv)
        check_roster(rep, denv)
        check_halseth(rep, denv)
        check_graph_health(rep, denv)
        check_quiet_owner(rep, denv, henv)
        check_second_brain(rep, denv)
        check_inference_balance(rep, denv)
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
