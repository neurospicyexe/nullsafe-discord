#!/usr/bin/env python3
"""Tests for `check_ledger_handoffs` in health-check.py (ledger lane, 2026-09-26 review L2b).

WHY THIS FILE EXISTS: under LEDGER_DISTILL a channel-inactive distillation with zero accepted ledger
lines writes NO handoff, and nothing errors -- Claude.ai's latest_handoff just goes stale. The bots
log `[ledger] STALE_HANDOFF ...` (pm2 ERROR log) and `[<c>] ledger distiller: N accepted` (OUT log).
The check must flag a companion that talked on Discord in the last 24h but landed zero distiller
lines, must NOT count consolidation's deterministic line as a win (it lands with nobody talking, so
it would mask a dead clerk), and must be per companion.

Run:  python3 ops/test_ledger_handoff_check.py
"""

import importlib.util
import os
import sys
import tempfile
from datetime import datetime

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


NOW = datetime(2026, 9, 26, 14, 0, 0)
RECENT = "2026-09-26 10:00:00: "
OLD = "2026-09-24 10:00:00: "


def run(files):
    """files: {cid: (out_lines, err_lines)} -> Report after check_ledger_handoffs."""
    tmp = tempfile.mkdtemp(prefix="ledger-check-")
    logs = {}
    for cid, (out_lines, err_lines) in files.items():
        paths = []
        for kind, lines in (("out", out_lines), ("error", err_lines)):
            p = os.path.join(tmp, "%s-bot-%s.log" % (cid, kind))
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
            paths.append(p)
        logs[cid] = tuple(paths)
    rep = hc.Report()
    hc.check_ledger_handoffs(rep, logs=logs, now=NOW)
    return {c["name"]: c for c in rep.checks}


print("check_ledger_handoffs")

r = run({
    "drevan": (
        [RECENT + "[drevan] onChannelInactive: channel=123 msgs=14",
         RECENT + "[consolidation:drevan] ledger distiller: 1 accepted, 0 duplicate, 0 rejected, 0 dropped, 0 failed (source session s)"],
        [RECENT + "[ledger] STALE_HANDOFF companion=drevan channel=123 reason=422:health"],
    ),
    "cypher": (
        [RECENT + "[cypher] onChannelInactive: channel=9 msgs=3",
         RECENT + "[cypher] ledger distiller: 2 accepted, 0 duplicate, 0 rejected, 0 dropped, 0 failed (source window 9 10:00-10:30)"],
        [],
    ),
    "gaia": (
        [OLD + "[gaia] onChannelInactive: channel=5 msgs=3"],
        [OLD + "[ledger] STALE_HANDOFF companion=gaia channel=5 reason=404"],
    ),
})
d = r["ledger:handoffs:drevan"]
check("activity + zero Discord distiller lines -> warning", d["severity"] == "warning", d)
check("consolidation's line is not counted as a win", "ZERO" in d["detail"], d)
check("the STALE_HANDOFF reason is surfaced", "422:health" in d["detail"], d)
check("a healthy companion is ok", r["ledger:handoffs:cypher"]["severity"] == "ok", r["ledger:handoffs:cypher"])
check("lines older than 24h are ignored", r["ledger:handoffs:gaia"]["severity"] == "ok", r["ledger:handoffs:gaia"])

r = run({
    "cypher": (
        [RECENT + "[cypher] onChannelInactive: channel=9 msgs=3",
         RECENT + "[cypher] ledger distiller: 1 accepted, 0 duplicate, 0 rejected, 0 dropped, 0 failed (source window x)"],
        [RECENT + "[ledger] STALE_HANDOFF companion=cypher channel=9 reason=transport"],
    ),
})
c = r["ledger:handoffs:cypher"]
check("mixed (some lines landed, one stale pass) -> ok, reason in the detail (no throttle flap)",
      c["severity"] == "ok" and "transport" in c["detail"], c)

rep = hc.Report()
hc.check_ledger_handoffs(rep, logs={"gaia": ("/nonexistent/a.log", "/nonexistent/b.log")}, now=NOW)
check("unreadable logs -> notice, UNVERIFIED (never 'ok')",
      rep.checks[0]["severity"] == "notice" and "UNVERIFIED" in rep.checks[0]["detail"], rep.checks)

check("knob off parsing matches the bots (off|0|false|no)",
      all(hc.ledger_distill_off({"LEDGER_DISTILL": v}) for v in ("off", " OFF", "0", "false", "No"))
      and not any(hc.ledger_distill_off({"LEDGER_DISTILL": v}) for v in ("", "on", "1", "offf"))
      and not hc.ledger_distill_off({}))

if FAILURES:
    print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("\nall passed")
