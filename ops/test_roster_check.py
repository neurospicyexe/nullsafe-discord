#!/usr/bin/env python3
"""Tests for `check_roster` in health-check.py (roster lookup, halseth mig 0117).

WHY THIS FILE EXISTS: the first version of `check_roster` reported failures with severity
`"critical"`, which is not in this script's `RANK` (`ok`/`notice`/`warning`/`red`). It would have
raised `KeyError` the first time anything was actually wrong -- i.e. exactly when it was needed, and
never before. A check whose failure path is never executed is not a check.

So every branch is exercised here, and the healthy case is asserted to be `ok` so the whole thing
cannot degrade into an alarm that is always on.

Same shape and same purpose as `ops/test_companion_memory_check.py`.

Run:  python3 ops/test_roster_check.py
"""

import importlib.util
import json
import os
import sys
import urllib.request

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


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run_check(stats, who, raise_stats=False, raise_who=False):
    """Run check_roster against stubbed HTTP responses; return the Report."""
    def fake_urlopen(req, timeout=None):
        if "/roster/stats" in req.full_url:
            if raise_stats:
                raise OSError("connection refused")
            return _Resp(stats)
        if raise_who:
            raise OSError("connection refused")
        return _Resp(who)

    original = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen
    try:
        rep = hc.Report()
        hc.check_roster(rep, {"HALSETH_URL": "http://stub", "ADMIN_SECRET": "x"})
        # Touch .severity inside the patch window so a bad severity string fails loudly here.
        rep.severity
        return rep
    finally:
        urllib.request.urlopen = original


HEALTHY_STATS = {
    "members": 538, "with_pronouns": 463, "without_pronouns": 75, "with_description": 208,
    "fetched_at": "2026-08-13T11:20:50Z", "age_hours": 3.2, "system_id_configured": True,
    "recent_syncs": [],
}
EMPTY_STATS = {
    "members": 0, "with_pronouns": 0, "without_pronouns": 0, "with_description": 0,
    "fetched_at": None, "age_hours": None, "system_id_configured": True,
    "recent_syncs": [{"status": "http_error", "detail": "HTTP 429"}],
}


def names(rep):
    return {c["name"]: c["severity"] for c in rep.checks}


def main():
    print("== every severity string used is valid (the bug that prompted this file)")
    for label, rep in [
        ("healthy", run_check(HEALTHY_STATS, {"status": "not_found"})),
        ("empty", run_check(EMPTY_STATS, {"status": "unavailable", "reason": "cache empty"})),
    ]:
        bad = [c["severity"] for c in rep.checks if c["severity"] not in hc.RANK]
        check("%s: all severities in RANK" % label, not bad, bad)

    print("== healthy roster is ok, so the alarm is not always on")
    rep = run_check(HEALTHY_STATS, {"status": "not_found"})
    check("severity is ok", rep.severity == "ok", rep.severity)
    check("no failures", rep.failures == [], rep.failures)
    check("freshness reports pronoun counts, not a quality score",
          "463 with pronouns" in names_detail(rep, "roster:freshness"))

    print("== empty cache is red on BOTH the size and the probe")
    rep = run_check(EMPTY_STATS, {"status": "unavailable", "reason": "cache empty"})
    n = names(rep)
    check("severity red", rep.severity == "red", rep.severity)
    check("roster:size red", n.get("roster:size") == "red", n)
    check("roster:probe red", n.get("roster:probe") == "red", n)

    print("== a stale roster is red even while lookups still answer")
    stale = dict(HEALTHY_STATS, age_hours=200.0)
    rep = run_check(stale, {"status": "not_found"})
    n = names(rep)
    check("roster:freshness red", n.get("roster:freshness") == "red", n)
    check("roster:probe still ok", n.get("roster:probe") == "ok", n)
    check("the message says the cron STOPPED",
          "STOPPED" in names_detail(rep, "roster:freshness"))

    print("== an unset system id is named as a config fault, not an empty roster")
    rep = run_check(dict(EMPTY_STATS, system_id_configured=False),
                    {"status": "unavailable", "reason": "PLURALKIT_SYSTEM_ID is unset"})
    n = names(rep)
    check("roster:config red", n.get("roster:config") == "red", n)

    print("== 'cannot look' is never reported as ok")
    rep = run_check(HEALTHY_STATS, {}, raise_stats=True)
    n = names(rep)
    check("unreachable stats warns, does not pass", n.get("roster:stats") == "warning", n)
    check("says UNKNOWN not ok", "UNKNOWN" in names_detail(rep, "roster:stats"))
    rep = run_check(HEALTHY_STATS, {}, raise_who=True)
    check("unreachable probe warns", names(rep).get("roster:probe") == "warning", names(rep))

    print("== an impossible status is surfaced rather than swallowed")
    rep = run_check(HEALTHY_STATS, {"status": "found"})
    check("a nonexistent name returning 'found' warns",
          names(rep).get("roster:probe") == "warning", names(rep))

    print("== missing url/secret is a notice, not a false pass")
    rep = hc.Report()
    hc.check_roster(rep, {})
    check("notice only", names(rep).get("roster:config") == "notice", names(rep))
    check("nothing claimed ok", not any(c["severity"] == "ok" for c in rep.checks), rep.checks)

    print()
    if FAILURES:
        print("FAILED %d assertion(s): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("all roster health-check assertions passed")
    return 0


def names_detail(rep, name):
    for c in rep.checks:
        if c["name"] == name:
            return c["detail"]
    return ""


if __name__ == "__main__":
    sys.exit(main())
