#!/usr/bin/env python3
"""Tests for `check_jev_calibration` in health-check.py (T5 / P5 standing Jev calibration).

Asserted: warnings in the report surface as checks with their own severity; a clean report is ok;
a missing, unreadable or stale report WARNS (a dead calibration cron must not read as "no drift");
notices stay notices.

Run:  python3 ops/test_jev_calibration_check.py
"""
import importlib.util
import json
import os
import sys
import tempfile
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


def run(body, age_h=0.0, raw=None, missing=False):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "cal.json")
    if not missing:
        with open(p, "w") as fh:
            fh.write(raw if raw is not None else json.dumps(body))
        t = time.time() - age_h * 3600
        os.utime(p, (t, t))
    rep = hc.Report()
    hc.check_jev_calibration(rep, path=p)
    return [(c["name"], c["severity"]) for c in rep.checks]


print("check_jev_calibration")
r = run({"rows": 100, "window_days": 7, "warnings": [{"companion": "drevan", "name": "write_rate_shift", "severity": "warning", "detail": "x"}]})
check("drift warning surfaces", r == [("jev:calibration:drevan:write_rate_shift", "warning")], r)
r = run({"rows": 100, "window_days": 7, "warnings": []})
check("clean report is ok", r == [("jev:calibration", "ok")], r)
r = run({"warnings": [{"companion": "all", "name": "baseline_created", "severity": "notice", "detail": "x"}]})
check("notice stays notice", r == [("jev:calibration:all:baseline_created", "notice")], r)
r = run({"warnings": []}, age_h=50)
check("stale report warns", r == [("jev:calibration", "warning")], r)
r = run(None, missing=True)
check("missing report warns", r == [("jev:calibration", "warning")], r)
r = run(None, raw="{not json")
check("garbage report warns, never raises", r == [("jev:calibration", "warning")], r)

if FAILURES:
    print("\n%d FAILED" % len(FAILURES))
    sys.exit(1)
print("\nall passed")
