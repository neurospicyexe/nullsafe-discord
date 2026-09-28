#!/usr/bin/env python3
"""Tests for the B28 changes in ops/sync-architect-facts.py (2026-09-28).

WHY THIS FILE EXISTS: every Hermes gateway restart opens an ~8-10s window in which a bot reply
hits ECONNREFUSED and falls back to the canned line (48 hits since August). This script was the
main source: it restarted a gateway on ANY byte change of the facts render, and the render carried
`, oldest Nd`, a number that ticks daily with no fact changed. These tests pin the three fixes:
  1. the ticking fragment is stripped, and a file that differs only by it is rewritten without a
     restart ("normalized");
  2. a needed restart waits for 15 minutes of quiet on that companion's gateway, capped at 6h
     counted from the FIRST deferral;
  3. the pending restart survives from one cron tick to the next.

Run:  python3 ops/test_sync_architect_facts.py
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sync = _load("sync", "sync-architect-facts.py")

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


FOOTER_OLD = ("(3 older open questions held back, oldest 12d -- not for this session; Raziel "
              "confirms or retires them on Hearth /facts.)")
FOOTER_NEW = ("(3 older open questions held back -- not for this session; Raziel "
              "confirms or retires them on Hearth /facts.)")
BODY = "## THE ARCHITECT\n- fact one\n- fact two\n\nSTILL OPEN\n- q?\n"

# ── strip_ticking ──────────────────────────────────────────────────────────────────────────────
print("strip_ticking")
check("drops the oldest-Nd fragment", sync.strip_ticking(FOOTER_OLD) == FOOTER_NEW, sync.strip_ticking(FOOTER_OLD))
check("any day count, including 0 and three digits",
      sync.strip_ticking("held back, oldest 0d --") == "held back --"
      and sync.strip_ticking("held back, oldest 104d --") == "held back --")
check("keeps the held COUNT (that moves only when a fact does)", "3 older open questions" in sync.strip_ticking(FOOTER_OLD))
check("leaves ordinary prose alone", sync.strip_ticking("the oldest dog, 12 days old") == "the oldest dog, 12 days old")
check("idempotent", sync.strip_ticking(sync.strip_ticking(FOOTER_OLD)) == FOOTER_NEW)

# ── existing_block / is_material_change ───────────────────────────────────────────────────────
print("material change")
def _file_with(block):
    return "# SOUL\n\n" + sync.BEGIN + "\n" + block.rstrip() + "\n" + sync.END + "\n\n## PRONOUN LAW\nlaw\n"

on_disk = _file_with(BODY + FOOTER_OLD)
check("existing_block reads between the markers", sync.existing_block(on_disk) == (BODY + FOOTER_OLD).rstrip())
check("existing_block is None with no markers", sync.existing_block("# SOUL\nno block\n") is None)
legacy = "x\n" + sync.LEGACY_BEGINS[0] + "\nold\n" + sync.END + "\n"
check("existing_block reads a legacy BEGIN too", sync.existing_block(legacy) == "old")
check("a stale fragment on disk is NOT a material change", not sync.is_material_change(on_disk, BODY + FOOTER_NEW))
check("a changed fact IS a material change", sync.is_material_change(on_disk, BODY.replace("two", "TWO") + FOOTER_NEW))
check("a changed held count IS a material change",
      sync.is_material_change(on_disk, BODY + FOOTER_NEW.replace("(3 ", "(4 ")))
check("no block on disk is material (first write)", sync.is_material_change("# SOUL\n", BODY))

# ── sync_file end to end ───────────────────────────────────────────────────────────────────────
print("sync_file")
d = tempfile.mkdtemp(prefix="factsync-")
p = os.path.join(d, "SOUL.md")
with open(p, "w", encoding="utf-8") as f:
    f.write(on_disk)
state, detail = sync.sync_file(p, BODY + FOOTER_NEW, dry=True, force=False)
check("dry run says would-normalize for a fragment-only diff", state == "would-normalize", (state, detail))
state, detail = sync.sync_file(p, BODY + FOOTER_NEW, dry=False, force=False)
check("fragment-only diff is rewritten as 'normalized' (never 'updated', so never restarted)",
      state == "normalized", (state, detail))
with open(p, encoding="utf-8") as f:
    now_text = f.read()
check("the rewritten file no longer carries the fragment", "oldest 12d" not in now_text and FOOTER_NEW in now_text)
state, _ = sync.sync_file(p, BODY + FOOTER_NEW, dry=False, force=False)
check("the next tick is 'unchanged'", state == "unchanged", state)
state, _ = sync.sync_file(p, BODY.replace("one", "ONE") + FOOTER_NEW, dry=False, force=False)
check("a real fact change is 'updated'", state == "updated", state)
state, _ = sync.sync_file(p, BODY.replace("one", "ONE") + FOOTER_NEW, dry=False, force=True)
check("--force on unchanged bytes is still 'updated' (the operator asked for a restart)", state == "updated", state)

# ── decide_restart ─────────────────────────────────────────────────────────────────────────────
print("decide_restart")
NOW = 1_800_000_000.0
M = 60
a, r = sync.decide_restart(NOW, NOW - 16 * M, NOW)
check("16 min quiet -> restart", a == "restart", (a, r))
a, r = sync.decide_restart(NOW, NOW - 15 * M, NOW)
check("exactly 15 min quiet -> restart (boundary is inclusive)", a == "restart", (a, r))
a, r = sync.decide_restart(NOW, NOW - 15 * M + 1, NOW)
check("one second short of 15 min -> defer", a == "defer", (a, r))
check("defer reason names how recent and how long pending", "ago" in r and "pending" in r, r)
a, r = sync.decide_restart(NOW, NOW - 30, NOW - 5 * 3600)
check("busy, pending 5h -> still defer", a == "defer", (a, r))
a, r = sync.decide_restart(NOW, NOW - 30, NOW - 6 * 3600)
check("busy, pending exactly 6h -> restart-cap", a == "restart-cap", (a, r))
check("cap reason says it is restarting anyway", "anyway" in r, r)
a, r = sync.decide_restart(NOW, None, NOW - 60)
check("unknown activity is treated as busy (fail toward deferring)", a == "defer" and "unknown" in r, (a, r))
a, r = sync.decide_restart(NOW, None, NOW - 7 * 3600)
check("unknown activity still restarts at the cap", a == "restart-cap", (a, r))
a, r = sync.decide_restart(NOW, NOW + 120, NOW)
check("a future timestamp (clock skew) defers rather than restarts", a == "defer", (a, r))

# ── merge_pending / combined_activity / target_companions ─────────────────────────────────────
print("pending bookkeeping")
p0 = {"gateway:drevan": {"since": NOW - 3600, "reason": "render changed"}}
p1 = sync.merge_pending(p0, ["gateway:drevan", "gateway:gaia"], NOW)
check("a re-changed target keeps its FIRST since (cap cannot be starved)", p1["gateway:drevan"]["since"] == NOW - 3600)
check("a new target starts at now", p1["gateway:gaia"]["since"] == NOW)
check("merge does not mutate its input", "gateway:gaia" not in p0)
check("combined: newest across companions", sync.combined_activity(["a", "b"], {"a": 1.0, "b": 5.0}) == 5.0)
check("combined: any unknown makes the whole target unknown",
      sync.combined_activity(["a", "b"], {"a": 1.0, "b": None}) is None)
check("gateway key maps to its companion", sync.target_companions("gateway:cypher") == ["cypher"])
check("bot reload waits only on its own companion", sync.target_companions("pm2:gaia-bot") == ["gaia"])
check("autonomous-worker waits on all three",
      sorted(sync.target_companions("pm2:autonomous-worker")) == ["cypher", "drevan", "gaia"])
check("unknown key -> None", sync.target_companions("gateway:nobody") is None)
check("every restart target the script can create has a gate",
      all(sync.target_companions("pm2:" + p) for p in sync.PM2_PROCS)
      and all(sync.target_companions("gateway:" + c) for c in sync.HERMES_HOMES))

# ── run_restarts across ticks ──────────────────────────────────────────────────────────────────
print("run_restarts")
calls = []


def runner_ok(cmd):
    calls.append(cmd)
    return True, ""


busy = {"cypher": NOW - 60, "drevan": NOW - 3 * 3600, "gaia": NOW - 3 * 3600}
pend = sync.merge_pending({}, ["gateway:cypher", "gateway:drevan"], NOW)
after, done = sync.run_restarts(pend, busy, NOW, dry=False, force=False, runner=runner_ok)
check("tick 1: the idle companion restarts", done == ["gateway:drevan"], done)
check("tick 1: the busy one stays pending with its since",
      list(after) == ["gateway:cypher"] and after["gateway:cypher"]["since"] == NOW)
check("tick 1: exactly one command ran, for drevan's unit",
      len(calls) == 1 and "hermes-gateway-drevan.service" in calls[0], calls)
calls.clear()
quiet_now = NOW + 20 * M
after2, done2 = sync.run_restarts(after, busy, quiet_now, dry=False, force=False, runner=runner_ok)
check("tick 2 (20 min later, cypher now quiet): the deferred restart happens",
      done2 == ["gateway:cypher"] and after2 == {}, (done2, after2))

calls.clear()
after3, done3 = sync.run_restarts({"gateway:gaia": {"since": NOW}}, busy, NOW, dry=True, force=False, runner=runner_ok)
check("dry run runs nothing and keeps the target pending", calls == [] and done3 == [] and "gateway:gaia" in after3)


def runner_fail(cmd):
    return False, "Unit not found"


after4, done4 = sync.run_restarts({"gateway:gaia": {"since": NOW - 7200}}, busy, NOW, dry=False, force=False,
                                  runner=runner_fail)
check("a FAILED restart stays pending with its original since",
      done4 == [] and after4["gateway:gaia"]["since"] == NOW - 7200, after4)
calls.clear()
after5, done5 = sync.run_restarts({"gateway:cypher": {"since": NOW}}, busy, NOW, dry=False, force=True, runner=runner_ok)
check("--force skips the idle wait", done5 == ["gateway:cypher"] and len(calls) == 1)
after6, _ = sync.run_restarts({"gateway:retired": {"since": NOW}}, busy, NOW, dry=False, force=False, runner=runner_ok)
check("an unknown pending key is dropped, not retried forever", after6 == {})
calls.clear()
_, done7 = sync.run_restarts(sync.merge_pending({}, ["pm2:" + p for p in sync.PM2_PROCS], NOW), busy, NOW,
                             dry=False, force=False, runner=runner_ok)
check("shared change with cypher busy: drevan/gaia bots reload, cypher-bot and the worker wait",
      sorted(done7) == ["pm2:drevan-bot", "pm2:gaia-bot"], done7)

# ── load/save pending ──────────────────────────────────────────────────────────────────────────
print("pending state file")
sp = os.path.join(d, "pending.json")
check("missing state file reads as empty", sync.load_pending(sp) == {})
sync.save_pending({"gateway:drevan": {"since": NOW, "reason": "render changed"}}, sp)
check("round trip", sync.load_pending(sp) == {"gateway:drevan": {"since": NOW, "reason": "render changed"}})
with open(sp, "w", encoding="utf-8") as f:
    f.write("{not json")
check("corrupt state file reads as empty instead of crashing the cron", sync.load_pending(sp) == {})

# ── last_activity against a real sqlite file with the Hermes shape ─────────────────────────────
print("last_activity")
db = os.path.join(d, "state.db")
con = sqlite3.connect(db)
con.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, "
            "timestamp REAL NOT NULL)")
con.commit()
ts, err = sync.last_activity(db)
check("empty messages table reads as idle (0), not unknown", ts == 0.0 and err is None, (ts, err))
for i, (role, t) in enumerate([("user", 100.0), ("assistant", 130.0), ("tool", 125.0)]):
    con.execute("INSERT INTO messages (session_id, role, timestamp) VALUES (?,?,?)", ("s", role, t))
con.commit()
con.close()
ts, err = sync.last_activity(db)
check("newest timestamp across all roles", ts == 130.0 and err is None, (ts, err))
ts, err = sync.last_activity(os.path.join(d, "nope.db"))
check("missing db -> unknown with a reason", ts is None and "no state.db" in err, (ts, err))
bad = os.path.join(d, "bad.db")
with open(bad, "w") as f:
    f.write("not a database")
ts, err = sync.last_activity(bad)
check("unreadable db -> unknown with a reason", ts is None and "unreadable" in err, (ts, err))

print()
if FAILURES:
    print("%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("all ok")
