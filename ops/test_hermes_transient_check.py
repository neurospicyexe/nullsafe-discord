#!/usr/bin/env python3
"""Tests for `check_hermes`'s transient-restart tolerance in health-check.py.

WHY THIS FILE EXISTS (2026-08-13 09:00, observed live): `sync-architect-facts.py` restarted all
three Hermes gateways because a real architect fact had landed (render 8685 -> 9019 chars). The
health check ran in the same second, sampled `hermes-gateway.service` as `deactivating`, and paged
RED for a service that was serving again two seconds later. Raziel got that report twice, because
the `*/15` check and the `0 9 --always` heartbeat both fired at 09:00 too.

The cron offsets now avoid that specific three-way collision, but a restart can also come from the
model watcher, a manual deploy, or scale_to_zero. **A health check that cries RED at a scheduled
restart trains you to ignore RED**, so the tolerance has to hold on its own rather than depend on
scheduling.

The tolerance must NOT swallow a real hang: a gateway stuck `deactivating` is exactly what
TimeoutStopSec=210 exists for, and it has to stay red. Both halves are asserted here.

Run:  python3 ops/test_hermes_transient_check.py
"""

import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("hc", os.path.join(HERE, "health-check.py"))
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)

FAILURES = []


def check(label, cond, detail=""):
    if cond:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s %s" % (label, detail))
        FAILURES.append(label)


UNIT_LIST = "hermes-gateway.service loaded active running Hermes Agent Gateway\n"


def run_with(states):
    """Drive check_hermes with a scripted sequence of `is-active` answers.

    `states` is consumed one entry per is-active call; the last entry repeats forever, so a
    permanently-stuck unit is expressible.
    """
    seq = list(states)
    calls = {"n": 0}

    def fake_run(cmd, timeout=25):
        if "list-units" in cmd:
            return True, UNIT_LIST
        if "is-active" in cmd:
            calls["n"] += 1
            s = seq.pop(0) if len(seq) > 1 else seq[0]
            return True, s + "\n"
        return True, ""

    orig_run, orig_sleep = hc.run, time.sleep
    hc.run = fake_run
    time.sleep = lambda _s: None          # the real loop waits ~12s; not in a test
    try:
        rep = hc.Report()
        hc.check_hermes(rep)
        rep.severity                      # touch it so an invalid severity string fails loudly
        return rep, calls["n"]
    finally:
        hc.run = orig_run
        time.sleep = orig_sleep


def only(rep):
    return rep.checks[0] if rep.checks else {"name": "?", "severity": "?", "detail": ""}


def main():
    print("== a healthy unit still passes on the first sample (no added latency)")
    rep, n = run_with(["active"])
    check("severity ok", rep.severity == "ok", rep.severity)
    check("sampled once, not re-polled", n == 1, "is-active calls=%d" % n)

    print("== a unit caught MID-RESTART is ok once it lands active")
    for transient in ("deactivating", "activating", "reloading"):
        rep, _n = run_with([transient, "active"])
        c = only(rep)
        check("%s -> active is ok" % transient, c["severity"] == "ok", c)
        check("%s says it was mid-restart" % transient, "mid-restart" in c["detail"], c["detail"])

    print("== the real 09:00 shape: deactivating, then activating, then active")
    rep, _n = run_with(["deactivating", "activating", "active"])
    check("resolves to ok", rep.severity == "ok", only(rep))

    print("== a unit STUCK transitioning is still RED (the tolerance must not swallow a hang)")
    rep, n = run_with(["deactivating"])
    c = only(rep)
    check("stays red", c["severity"] == "red", c)
    check("names it a hang, not a transition", "hang" in c["detail"], c["detail"])
    check("gave up rather than polling forever", n <= 8, "is-active calls=%d" % n)

    print("== a genuinely FAILED unit is red immediately, not retried into ok")
    for bad in ("failed", "inactive", "unknown"):
        rep, _n = run_with([bad])
        c = only(rep)
        check("%s is red" % bad, c["severity"] == "red", c)

    print("== a unit that transitions into FAILED is red, not excused as a restart")
    rep, _n = run_with(["deactivating", "failed"])
    c = only(rep)
    check("deactivating -> failed is red", c["severity"] == "red", c)

    print("== every severity string used is valid")
    for states in (["active"], ["deactivating", "active"], ["deactivating"], ["failed"]):
        rep, _n = run_with(states)
        bad = [c["severity"] for c in rep.checks if c["severity"] not in hc.RANK]
        check("severities in RANK for %s" % states, not bad, bad)

    print()
    if FAILURES:
        print("FAILED %d assertion(s): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("all hermes transient-restart assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
