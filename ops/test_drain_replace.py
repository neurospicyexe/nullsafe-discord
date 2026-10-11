#!/usr/bin/env python3
"""Tests for 'replace' handling in ops/drain-hermes-memory-queue.py (2026-10-11).

A 'replace' op used to post as a plain add, so the old fact survived beside its replacement.
Run:  python3 ops/test_drain_replace.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("drain", os.path.join(HERE, "drain-hermes-memory-queue.py"))
drain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drain)

FAILURES = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else " " + str(detail)))
    if not cond:
        FAILURES.append(name)


def facts():
    return {
        drain.normalize("Raziel drinks oat milk lattes"): "id-latte",
        drain.normalize("Lucy is a Dalmatian"): "id-lucy",
        drain.normalize("Lucy likes walks"): "id-walks",
    }


print("find_replaced_fact")
check("exact match (case/space-insensitive)", drain.find_replaced_fact(facts(), "  raziel drinks OAT milk  lattes ") == "id-latte")
check("unique containment (fragment of stored fact)", drain.find_replaced_fact(facts(), "oat milk lattes") == "id-latte")
check("ambiguous containment -> None", drain.find_replaced_fact(facts(), "Lucy") is None)
check("no match -> None", drain.find_replaced_fact(facts(), "something else entirely") is None)
check("empty old_text -> None", drain.find_replaced_fact(facts(), "") is None and drain.find_replaced_fact(facts(), None) is None)
check("None fact list -> None", drain.find_replaced_fact(None, "x") is None)

print("route_operation")
posts = []
drain.post_json = lambda url, secret, path, payload: (posts.append((path, payload)) or 201)

ef = facts()
st, desc = drain.route_operation("u", "s", "cypher", "user",
    {"action": "replace", "old_text": "Raziel drinks oat milk lattes", "content": "Raziel drinks black coffee"}, ef, False)
check("replace posts supersedes_id", st is True and posts[-1][1].get("supersedes_id") == "id-latte", posts[-1])
check("replaced row dropped from the in-run list", drain.normalize("Raziel drinks oat milk lattes") not in ef)
check("new content added for in-run dedup", drain.normalize("Raziel drinks black coffee") in ef)

posts.clear()
st, _ = drain.route_operation("u", "s", "cypher", "user",
    {"action": "replace", "old_text": "never stored", "content": "A brand new fact"}, facts(), False)
check("replace with no match falls back to a plain add", st is True and "supersedes_id" not in posts[-1][1], posts)

posts.clear()
st, _ = drain.route_operation("u", "s", "cypher", "user",
    {"action": "add", "old_text": "Lucy is a Dalmatian", "content": "Another fact"}, facts(), False)
check("add never supersedes even if old_text is present", "supersedes_id" not in posts[-1][1])

posts.clear()
st, _ = drain.route_operation("u", "s", "cypher", "user",
    {"action": "replace", "old_text": "Lucy is a Dalmatian", "content": "Lucy is a Dalmatian"}, facts(), False)
check("replace with identical content is a dedup no-op", st is True and not posts)

posts.clear()
st, desc = drain.route_operation("u", "s", "cypher", "user",
    {"action": "replace", "old_text": "Lucy is a Dalmatian", "content": "Lucy is a spotted Dalmatian"}, facts(), True)
check("dry-run posts nothing, reports the supersede", st is True and not posts and "supersedes" in desc, desc)

print("\n%d failure(s)" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
