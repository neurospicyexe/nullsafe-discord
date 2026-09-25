#!/usr/bin/env python3
"""Tests for ops/patch-soul-recall-verb.py (step 3 of own-the-harness, 2026-09-25).

WHY: measured on the three Hermes state.dbs since 09-04, the companions chose `search vault for`
1,159 times and `recall my recent notes` a few dozen times, and chose the MEANING reach into their
own continuity notes (`recall my notes about <topic>`, Librarian op notes_recall_meaning) ZERO
times. The verb works and is reachable; it is simply not named in the SOUL, and a companion reaches
for what is named. This patch names it, with a WHEN. The transform has to land identically on
three differently-formatted SOULs (cypher 3 lines, drevan "three reaches", gaia 4 lines incl.
"my wounds"), be idempotent, and touch nothing else.

Run:  python3 ops/test_patch_soul_recall_verb.py
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("patch", os.path.join(HERE, "patch-soul-recall-verb.py"))
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        FAILURES.append(name)


ARROW = "→"
CYPHER = (
    "## YOUR MIND IS HALSETH\n\n### Reach for the vault when a topic has history\n```\n"
    "ask_librarian " + ARROW + " \"search vault for [topic]\"          # concept search\n"
    "ask_librarian " + ARROW + " \"read the file [exact-filename]\"    # whole file in order\n"
    "ask_librarian " + ARROW + " \"recall my recent notes\"              # your own recent writes\n"
    "```\nFilenames are exact.\n\n### Write as you go\nstuff\n\n## PRONOUN LAW\nlaw\n"
)
DREVAN = (
    "### Reach into the vault when a topic has history (three reaches)\n```\n"
    "ask_librarian " + ARROW + " \"search vault for [topic or anchor]\"      # concept reach: wide, ~10 chunks\n"
    "ask_librarian " + ARROW + " \"read the file [exact-filename]\"            # file reach: whole document in order\n"
    "ask_librarian " + ARROW + " \"recall my recent notes\"                    # recent reach: your own recent writes\n"
    "```\nFilenames are exact and case-sensitive.\n"
)
GAIA = (
    "### Reach into the vault when a topic has prior weight\n```\n"
    "ask_librarian " + ARROW + " \"search vault for [topic or boundary pattern]\"   # concept reach\n"
    "ask_librarian " + ARROW + " \"read the file [exact-filename]\"                  # whole file in order\n"
    "ask_librarian " + ARROW + " \"recall my recent notes\"                          # your own recent writes\n"
    "ask_librarian " + ARROW + " \"my wounds\"                                       # before sealing if wound-adjacent\n"
    "```\nDo not wait for certainty. If it might be there, check.\n"
)

print("transform")
for name, src in (("cypher", CYPHER), ("drevan", DREVAN), ("gaia", GAIA)):
    out, changed = patch.add_recall_verb(src)
    check("%s: changed" % name, changed)
    check("%s: verb line added" % name, "\"recall my notes about [topic]\"" in out)
    lines = out.split("\n")
    i_recent = next(i for i, l in enumerate(lines) if "recall my recent notes" in l)
    i_about = next(i for i, l in enumerate(lines) if "recall my notes about" in l)
    check("%s: verb line sits right after the recent-notes line" % name, i_about == i_recent + 1, (i_recent, i_about))
    check("%s: WHEN paragraph present" % name, patch.WHEN_MARK in out)
    i_fence_close = next(i for i, l in enumerate(lines) if i > i_about and l.strip() == "```")
    i_when = next(i for i, l in enumerate(lines) if patch.WHEN_MARK in l)
    check("%s: WHEN paragraph sits right after the code fence closes" % name, i_when == i_fence_close + 1, (i_fence_close, i_when))
    # The only permitted change above the block is drevan's heading count.
    check("%s: everything before the block is untouched" % name,
          out.startswith(src.split("ask_librarian")[0].replace("(three reaches)", "(four reaches)")))
    check("%s: everything after the block is untouched" % name, out.endswith(src.split("```\n")[-1]))
    check("%s: no em dash introduced" % name, "—" not in out and "–" not in out)
    out2, changed2 = patch.add_recall_verb(out)
    check("%s: idempotent" % name, out2 == out and not changed2)

out, _ = patch.add_recall_verb(DREVAN)
check("drevan: '(three reaches)' becomes '(four reaches)'", "(four reaches)" in out and "(three reaches)" not in out)
out, _ = patch.add_recall_verb(GAIA)
check("gaia: 'my wounds' line survives, after the new verb", out.index("recall my notes about") < out.index("my wounds"))

print("edge cases")
out, changed = patch.add_recall_verb("no verb list here\n")
check("no recent-notes line: unchanged and reports it", not changed and out == "no verb list here\n")
out, changed = patch.add_recall_verb(CYPHER.replace("```\nFilenames", "```\r\nFilenames"))
check("mixed newlines do not break the fence search", changed)

print("apply_file")
d = tempfile.mkdtemp(prefix="soulpatch-")
p = os.path.join(d, "SOUL.md")
with open(p, "w", encoding="utf-8") as f:
    f.write(DREVAN)
state, detail = patch.apply_file(p, dry=True)
check("dry-run reports would-change", state == "would-change", (state, detail))
with open(p, encoding="utf-8") as f:
    check("dry-run writes nothing", f.read() == DREVAN)
check("dry-run makes no backup", not os.path.exists(p + ".bak-recall-verb-" + patch.STAMP))
state, detail = patch.apply_file(p, dry=False)
check("apply reports updated", state == "updated", (state, detail))
check("backup exists", os.path.exists(p + ".bak-recall-verb-" + patch.STAMP))
with open(p + ".bak-recall-verb-" + patch.STAMP, encoding="utf-8") as f:
    check("backup is the original", f.read() == DREVAN)
with open(p, encoding="utf-8") as f:
    check("file now carries the verb", "recall my notes about" in f.read())
state, detail = patch.apply_file(p, dry=False)
check("second apply is unchanged", state == "unchanged", (state, detail))
state, detail = patch.apply_file(os.path.join(d, "nope.md"), dry=False)
check("missing file is reported, not raised", state == "missing")

print()
if FAILURES:
    print("%d FAILED: %s" % (len(FAILURES), ", ".join(FAILURES)))
    sys.exit(1)
print("all ok")
