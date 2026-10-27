#!/usr/bin/env python3
"""Tests for `check_backups` in health-check.py.

WHY THIS FILE EXISTS (2026-10-27): before this there were no backups of Halseth D1 or Second Brain.
The backup runs on the workstation; the VPS only sees the marker it writes after a VERIFIED backup.
So the alarm is staleness: anything that stops a verified backup (failed export, broken script, task
not firing, workstation off) must warn, and a fresh marker must stay quiet.

Run:  python3 ops/test_backup_check.py
"""

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("hc", os.path.join(HERE, "health-check.py"))
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)

FAILURES = []
NOW = 1_800_000_000.0
H = 3600.0


def check(label, cond, detail=""):
    if cond:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s %s" % (label, detail))
        FAILURES.append(label)


def run(content):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as fh:
        if content is not None:
            fh.write(content if isinstance(content, str) else json.dumps(content))
    if content is None:
        os.remove(path)
    rep = hc.Report()
    hc.check_backups(rep, path=path, now=NOW)
    if os.path.exists(path):
        os.remove(path)
    return {c["name"]: c["severity"] for c in rep.checks}


print("check_backups")
r = run({"d1_at": NOW - 2 * H, "sb_at": NOW - 3 * 24 * H})
check("fresh d1 + sb -> ok", r == {"backup:d1": "ok", "backup:second_brain": "ok"}, r)

r = run({"d1_at": NOW - 40 * H, "sb_at": NOW - 3 * 24 * H})
check("d1 40h old -> warning", r.get("backup:d1") == "warning", r)
check("  ...sb still ok", r.get("backup:second_brain") == "ok", r)

r = run({"d1_at": NOW - 2 * H, "sb_at": NOW - 10 * 24 * H})
check("sb 10d old -> warning", r.get("backup:second_brain") == "warning", r)

r = run({"d1_at": NOW - 2 * H})
check("sb never verified -> warning", r.get("backup:second_brain") == "warning", r)

r = run(None)
check("no marker -> warning (never silent)", r == {"backup:marker": "warning"}, r)

r = run("{not json")
check("garbage marker -> warning, no raise", r == {"backup:marker": "warning"}, r)

r = run({"d1_at": "yesterday", "sb_at": NOW})
check("non-numeric stamp -> warning", r.get("backup:d1") == "warning", r)

if FAILURES:
    print("\n%d FAILED" % len(FAILURES))
    sys.exit(1)
print("\nall ok")
