#!/usr/bin/env python3
"""Tests for `check_vault_queue` in health-check.py.

WHY THIS FILE EXISTS (K17, 2026-10-07..11): Second Brain writes the Obsidian vault through the
obsidian-rest adapter, which swallows a failed PUT and parks the write in a SQLite queue. When the
obsidian. hostname died with the LM Studio tunnel, 195 writes piled up over four days while
second_brain:reachable stayed green. Probe the QUEUE DEPTH, not the host.

Asserted: a backed-up queue warns; a drained or near-empty queue stays quiet; a /health without the
field says UNKNOWN instead of passing as healthy; garbage bodies never raise.

Run:  python3 ops/test_vault_queue_check.py
"""

import importlib.util
import json
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


def run(body):
    rep = hc.Report()
    hc.check_vault_queue(rep, body)
    return [(c["name"], c["severity"]) for c in rep.checks]


print("check_vault_queue")

r = run(json.dumps({"status": "ok", "vault_queue_pending": 195}))
check("195 queued -> warning", r == [("second_brain:vault_queue", "warning")], r)

r = run(json.dumps({"status": "ok", "vault_queue_pending": hc.VAULT_QUEUE_WARN}))
check("at threshold -> warning", r == [("second_brain:vault_queue", "warning")], r)

r = run(json.dumps({"status": "ok", "vault_queue_pending": 0}))
check("drained -> silent", r == [], r)

r = run(json.dumps({"status": "ok", "vault_queue_pending": hc.VAULT_QUEUE_WARN - 1}))
check("below threshold -> silent", r == [], r)

r = run(json.dumps({"status": "ok"}))
check("field missing -> notice (UNKNOWN, not fine)", r == [("second_brain:vault_queue", "notice")], r)

r = run("not json")
check("garbage body -> silent, no raise", r == [], r)

if FAILURES:
    print("\n%d FAILED" % len(FAILURES))
    sys.exit(1)
print("\nall passed")
