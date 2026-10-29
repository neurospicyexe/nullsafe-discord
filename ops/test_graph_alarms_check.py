#!/usr/bin/env python3
"""Tests for the M7 graph alarms in health-check.py: `check_graph_lanes` (DEAD LANE) and
`check_graph_reach` (ZERO REACH), both fed from GET /admin/graph/health (halseth M7, 2026-10-28).

Every branch is exercised, and the healthy case is asserted to be `ok`, so neither alarm can
degrade into one that is always on (or one whose failure path has never run).

Same shape and same purpose as `ops/test_roster_check.py`.

Run:  python3 ops/test_graph_alarms_check.py
"""

import importlib.util
import os
import sys

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


def by_name(rep):
    return {c["name"]: c for c in rep.checks}


def run(sources, diff=None):
    return {"at": "2026-10-29T00:00:00Z", "ms": 1000, "sources": sources,
            "diff": diff or {"derived": 1, "added": 0, "updated": 0, "removed": 0}}


ALONGSIDE = "companion_soma_events.alongside"

print("check_graph_lanes")

rep = hc.Report()
hc.check_graph_lanes(rep, None)
check("no history yet is a notice", by_name(rep)["graph:lanes"]["severity"] == "notice")

rep = hc.Report()
hc.check_graph_lanes(rep, {"last": run([{"source": "a", "inserted": 5}]), "prev": None})
check("one run recorded is ok", by_name(rep)["graph:lanes"]["severity"] == "ok")

healthy_prev = run([{"source": "a", "inserted": 100},
                    {"source": ALONGSIDE, "inserted": 50, "lanes": {"companion_journal": 30, "commons_posts": 20}}])
healthy_last = run([{"source": "a", "inserted": 104},
                    {"source": ALONGSIDE, "inserted": 52, "lanes": {"companion_journal": 31, "commons_posts": 21}}],
                   {"derived": 156, "added": 6, "updated": 0, "removed": 0})
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": healthy_last, "prev": healthy_prev})
names = by_name(rep)
check("healthy growth is ok", names.get("graph:lanes", {}).get("severity") == "ok", str(rep.checks))
check("healthy run reports the diff", "+6" in names.get("graph:lanes", {}).get("detail", ""))
check("healthy run raises nothing", rep.severity == "ok")

dead_sub = run([{"source": "a", "inserted": 104},
                {"source": ALONGSIDE, "inserted": 31, "lanes": {"companion_journal": 31, "commons_posts": 0}}])
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": dead_sub, "prev": healthy_prev})
names = by_name(rep)
check("a sub-lane gone to zero is a dead lane warning",
      names.get("graph:dead_lane", {}).get("severity") == "warning", str(rep.checks))
check("the dead sub-lane is named", "commons_posts" in names.get("graph:dead_lane", {}).get("detail", ""))

gone_source = run([{"source": ALONGSIDE, "inserted": 52, "lanes": {"companion_journal": 31, "commons_posts": 21}}])
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": gone_source, "prev": healthy_prev})
check("a source missing from the last run counts as dead",
      "a (100 -> 0)" in by_name(rep).get("graph:dead_lane", {}).get("detail", ""), str(rep.checks))

dropped = run([{"source": "a", "inserted": 30},
               {"source": ALONGSIDE, "inserted": 52, "lanes": {"companion_journal": 31, "commons_posts": 21}}])
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": dropped, "prev": healthy_prev})
names = by_name(rep)
check("a big run-over-run drop is a notice", names.get("graph:lane_drop", {}).get("severity") == "notice", str(rep.checks))
check("a drop is not a dead lane", "graph:dead_lane" not in names)

small_prev = run([{"source": "tiny", "inserted": 6}])
small_last = run([{"source": "tiny", "inserted": 2}])
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": small_last, "prev": small_prev})
check("small lanes are exempt from the drop ratio", rep.severity == "ok", str(rep.checks))

never = run([{"source": "z", "inserted": 0}])
rep = hc.Report()
hc.check_graph_lanes(rep, {"last": never, "prev": never})
check("a lane that was always zero is not a new death", rep.severity == "ok", str(rep.checks))

print("check_graph_reach")

rep = hc.Report()
hc.check_graph_reach(rep, {})
check("no reach recorded yet is a notice", by_name(rep)["graph:reach"]["severity"] == "notice")

rep = hc.Report()
hc.check_graph_reach(rep, {
    "cypher": {"edges": 12, "nodes": 9, "zero_streak": 0, "last_nonzero_at": "t"},
    "gaia": {"edges": 0, "nodes": 0, "zero_streak": 1, "last_nonzero_at": "t"},
})
check("reaching and one empty boot are both ok", rep.severity == "ok", str(rep.checks))

rep = hc.Report()
hc.check_graph_reach(rep, {"drevan": {"edges": 0, "nodes": 0, "zero_streak": 3, "last_nonzero_at": None}})
r = by_name(rep).get("graph:reach:drevan", {})
check("a zero streak at the threshold is a warning", r.get("severity") == "warning", str(rep.checks))
check("it says reach never happened", "never" in r.get("detail", ""))

if FAILURES:
    print("\n%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("\nall graph alarm checks passed")
