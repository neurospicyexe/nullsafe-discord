#!/usr/bin/env python3
"""Tests for the verb classifier in ops/recall-choice-report.py.

WHY: the report decides whether the automatic per-message recall (bot-message-handler.ts, one
lookup with Raziel's raw sentence) can be retired in favour of the companion CHOOSING to look. That
decision rests on counting chosen `recall my notes about ...` calls, so the classifier that finds
them in Hermes's tool_calls JSON has to be right about the phrasings the Librarian routes
(patterns.ts notes_recall_meaning triggers) and must not mistake a WRITE that contains the word
"notes" for a recall (the first pass did exactly that: "note to cypher: thank you..." counted as
recall).

Run:  python3 ops/test_recall_choice_report.py
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("rcr", os.path.join(HERE, "recall-choice-report.py"))
rcr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rcr)

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


print("classify")
cases = [
    ("recall my notes about the ankle", "recall-notes-meaning"),
    ("Recall notes about Blue's truck", "recall-notes-meaning"),
    ("what did i note about the MRI", "recall-notes-meaning"),
    ("do i have notes on Missouri", "recall-notes-meaning"),
    ("what have i carried about the dogs", "recall-notes-meaning"),
    ("search my continuity notes for the fall", "recall-notes-meaning"),
    ("recall my recent notes", "recall-recent"),
    ("search vault for Jude Vega Merlin", "vault-search"),
    ("search the vault for Rome", "vault-search"),
    ("what do i know about Heidi", "vault-search"),
    ("read the file discord-live/1/2.md", "read-file"),
    ("open my session", "session-open"),
    ("identity check, come back to me, load your full kernel", "identity"),
    ("Write a companion note for drevan: Crash opened with just Dre?", "write"),
    ("note to cypher: thank you for tracing the root", "write"),
    ("Log a feeling for gaia: steady -- the perimeter held", "write"),
    ("Update my state: heat warm", "write"),
    ("list my open tasks with their weight", "task"),
    ("What is present that I haven't looked at yet?", "other"),
    ("", "other"),
]
for q, want in cases:
    got = rcr.classify(q)
    check("%r -> %s" % (q[:40], want), got == want, "got %s" % got)

print("extract")
tc = json.dumps([
    {"function": {"name": "mcp_halseth_ask_librarian", "arguments": json.dumps({"companion_id": "drevan", "request": "recall my notes about the ankle"})}},
    {"function": {"name": "web_search", "arguments": "{}"}},
    {"function": {"name": "mcp_halseth_ask_librarian", "arguments": "not json"}},
])
got = rcr.librarian_requests(tc)
check("extracts only ask_librarian requests", got == ["recall my notes about the ankle"], got)
check("garbage tool_calls yields empty, never raises", rcr.librarian_requests("{{{") == [])
check("null tool_calls yields empty", rcr.librarian_requests(None) == [])

print("aggregate")
rows = [
    ("2026-09-20 10:00:00", "recall my notes about x"),
    ("2026-09-20 11:00:00", "search vault for y"),
    ("2026-09-21 09:00:00", "recall my recent notes"),
    ("2026-09-21 09:30:00", "recall my notes about z"),
]
agg = rcr.aggregate(rows)
check("per-day buckets", sorted(agg) == ["2026-09-20", "2026-09-21"], sorted(agg))
check("counts by verb", agg["2026-09-20"]["recall-notes-meaning"] == 1 and agg["2026-09-20"]["vault-search"] == 1, agg)
check("second day", agg["2026-09-21"]["recall-notes-meaning"] == 1 and agg["2026-09-21"]["recall-recent"] == 1, agg)

print("render")
text = rcr.render({"drevan": agg, "gaia": {}}, since="2026-09-20")
check("renders a header with the since date", "since 2026-09-20" in text, text[:120])
check("renders each companion", "drevan" in text and "gaia" in text)
check("renders the meaning-recall total", "recall-notes-meaning" in text)
check("no em dash in output", "—" not in text)

print("reach summary")
reach_lines = [
    {"ts": "2026-09-26T02:30:00Z", "companion": "drevan", "outcome": "reached", "topic": "the Subway sandwich", "ms": 1800},
    {"ts": "2026-09-26T02:35:00Z", "companion": "drevan", "outcome": "declined", "topic": None, "ms": 900},
    {"ts": "2026-09-26T02:40:00Z", "companion": "drevan", "outcome": "timeout", "topic": None, "ms": 20000},
    {"ts": "2026-09-27T01:00:00Z", "companion": "gaia", "outcome": "reached", "topic": "the perimeter", "ms": 1500},
]
summ = rcr.summarize_reach(reach_lines)
check("per companion per day outcomes", summ["drevan"]["2026-09-26"]["reached"] == 1 and summ["drevan"]["2026-09-26"]["declined"] == 1 and summ["drevan"]["2026-09-26"]["timeout"] == 1, summ)
check("second companion", summ["gaia"]["2026-09-27"]["reached"] == 1, summ)
text = rcr.render_reach(summ, [l for l in reach_lines if l.get("topic")])
check("renders outcomes and the topics reached for", "reached=1" in text and "drevan" in text and "Subway" in text, text[:300])
check("garbage lines are skipped, never raise", rcr.summarize_reach([{"nope": 1}, None, "x"]) == {})

print()
if FAILURES:
    print("%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("all ok (incl. reach)")
