#!/usr/bin/env python3
"""Tests for ops/soul_cap.py, `check_soul_cap` in health-check.py, and the pre-write guard in
sync-architect-facts.py.

WHY THIS FILE EXISTS (2026-09-25): Hermes truncates SOUL.md to 70%+20% OF THE CAP the moment the
file crosses it (prompt_builder.py:1717), and with `context_file_max_chars: null` the cap is not a
number but a boot-time probe of the provider's /models endpoint: probe OK -> 262k window -> 62,914
cap; probe fails -> the static "qwen" default of 131k -> 31,457 cap, which cuts 9.5k out of the
middle of Drevan's identity file. Nothing logged which one a given boot got. The fix is to PIN the
cap (one author: us) and to assert, at write time and on the standing health check, that every
SOUL.md sits under cap minus margin. These tests cover every branch, including the "cap unpinned"
branch, which is the one that must stay RED so the probe can never quietly come back.

Run:  python3 ops/test_soul_cap_check.py
"""

import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sc = _load("soul_cap", "soul_cap.py")
hc = _load("hc", "health-check.py")
sync = _load("sync", "sync-architect-facts.py")

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


def _home(cap_line, soul_chars):
    d = tempfile.mkdtemp(prefix="soulcap-")
    with open(os.path.join(d, "config.yaml"), "w", encoding="utf-8") as f:
        f.write("model:\n  default: x\n%s\nfile_read_max_chars: 100000\n" % cap_line)
    with open(os.path.join(d, "SOUL.md"), "w", encoding="utf-8") as f:
        f.write("s" * soul_chars)
    return d


# ── read_pinned_cap ────────────────────────────────────────────────────────────────────────────
print("read_pinned_cap")
check("pinned int is read", sc.read_pinned_cap(os.path.join(_home("context_file_max_chars: 60000", 1), "config.yaml")) == 60000)
check("null reads as None (unpinned)", sc.read_pinned_cap(os.path.join(_home("context_file_max_chars: null", 1), "config.yaml")) is None)
check("missing key reads as None", sc.read_pinned_cap(os.path.join(_home("other: 1", 1), "config.yaml")) is None)
check("missing file reads as None", sc.read_pinned_cap("/nonexistent/config.yaml") is None)
check("zero or negative reads as None (Hermes ignores <= 0)", sc.read_pinned_cap(os.path.join(_home("context_file_max_chars: 0", 1), "config.yaml")) is None)

# ── assess ─────────────────────────────────────────────────────────────────────────────────────
print("assess")
sev, detail = sc.assess(size=37_800, cap=60_000, margin=3_000)
check("comfortably under is ok", sev == "ok", detail)
check("ok detail names size, cap and headroom", "37,800" in detail and "60,000" in detail and "22,200" in detail, detail)
sev, detail = sc.assess(size=58_000, cap=60_000, margin=3_000)
check("inside the margin is warning", sev == "warning", detail)
sev, detail = sc.assess(size=60_000, cap=60_000, margin=3_000)
check("at the cap is red (Hermes cuts at >= cap)", sev == "red", detail)
sev, detail = sc.assess(size=37_832, cap=31_457, margin=3_000)
# int(31457*0.7) + int(31457*0.2) = 22,019 + 6,291 = 28,310 kept, exactly as prompt_builder.py does it.
check("over the cap is red and says how much is cut", sev == "red" and "9,522" in detail, detail)
sev, detail = sc.assess(size=1_000, cap=None, margin=3_000)
check("unpinned cap is red regardless of size", sev == "red", detail)
check("unpinned detail names the probe", "probe" in detail.lower(), detail)

# ── check_soul_cap in health-check.py ──────────────────────────────────────────────────────────
print("check_soul_cap")
homes = {
    "cypher": _home("context_file_max_chars: 60000", 30_000),
    "drevan": _home("context_file_max_chars: 60000", 58_500),
    "gaia": _home("context_file_max_chars: null", 34_000),
}
rep = hc.Report()
hc.check_soul_cap(rep, homes=homes, margin=3_000)
by = {c["name"]: c for c in rep.checks}
check("one entry per profile", set(by) == {"soul-cap:cypher", "soul-cap:drevan", "soul-cap:gaia"}, sorted(by))
check("cypher ok", by["soul-cap:cypher"]["severity"] == "ok", by["soul-cap:cypher"])
check("drevan warning inside margin", by["soul-cap:drevan"]["severity"] == "warning", by["soul-cap:drevan"])
check("gaia red because unpinned", by["soul-cap:gaia"]["severity"] == "red", by["soul-cap:gaia"])
check("overall severity is red", rep.severity == "red", rep.severity)
missing = {"cypher": os.path.join(tempfile.mkdtemp(), "nope")}
rep2 = hc.Report()
hc.check_soul_cap(rep2, homes=missing, margin=3_000)
check("unreadable SOUL is warning, not silence", rep2.checks and rep2.checks[0]["severity"] == "warning", rep2.checks)
rep3 = hc.Report()
hc.check_soul_cap(rep3, homes={"cypher": homes["cypher"]}, margin=3_000)
check("a healthy profile alone is ok (the check cannot be an always-on alarm)", rep3.severity == "ok", rep3.severity)

# ── pre-write guard in sync-architect-facts.py ─────────────────────────────────────────────────
print("sync guard")
h = _home("context_file_max_chars: 60000", 10)
soul = os.path.join(h, "SOUL.md")
with open(soul, "w", encoding="utf-8") as f:
    f.write("# head\n\n## PRONOUN LAW\nlaw\n")
state, detail = sync.sync_file(soul, "- fact " * 200, dry=False, force=False, cap=60_000, margin=3_000)
check("a fitting block is written", state == "updated", (state, detail))
state, detail = sync.sync_file(soul, "x" * 57_500, dry=False, force=False, cap=60_000, margin=3_000)
check("a block that would breach cap-margin is refused", state == "refused", (state, detail))
with open(soul, encoding="utf-8") as f:
    kept = f.read()
check("refused write leaves the file untouched", "- fact " in kept and "x" * 100 not in kept)
check("refusal detail says the numbers", "60,000" in detail and "57,5" in detail.replace(",", "").replace("57500", "57,5") or "57" in detail, detail)
state, detail = sync.sync_file(soul, "y" * 57_500, dry=True, force=False, cap=60_000, margin=3_000)
check("dry run reports the refusal the same way", state == "refused", (state, detail))
state, detail = sync.sync_file(soul, "z" * 100, dry=False, force=False, cap=None, margin=3_000)
check("unpinned cap refuses too (no number, no write)", state == "refused" and "probe" in detail.lower(), (state, detail))

print()
if FAILURES:
    print("%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("all ok")
