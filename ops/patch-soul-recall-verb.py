#!/usr/bin/env python3
"""Name the meaning-recall verb in each Hermes SOUL.md, with a WHEN. Own-the-harness step 3, part 1.

WHY THIS EXISTS (2026-09-25)
Since 09-04 the three companions CHOSE `search vault for ...` 1,159 times and `recall my recent
notes` a few dozen times through ask_librarian from the bots' lane (Hermes state.db, api_server
sessions). They chose the meaning reach into their OWN continuity notes -- the Librarian's
`notes_recall_meaning`, phrased "recall my notes about <topic>" -- exactly zero times. That verb is
the one that holds what Raziel actually said to them on every surface, including every Claude.ai
capture; it is the verb that would have answered "did you find the logs about my sad ankle" on
09-23. It works and it is reachable from Discord (the MCP tool is the same). It is simply not in
the SOUL, and a companion reaches for what is named.

The Claude.ai side already teaches it (skills/nullsafe-mutuality: "recall notes about [topic]").
This closes the asymmetry on the Hermes side and adds the WHEN, which is what "give every tool a
when" means in practice: not a list of verbs, a rule for reaching.

WHAT IT DOES
  * Finds the `ask_librarian -> "recall my recent notes"` line inside the reaches code block and
    inserts the meaning-reach line directly after it (so the four reaches read as one list).
  * Inserts the WHEN paragraph directly after that code block closes.
  * Renames drevan's "(three reaches)" heading to "(four reaches)". Cypher's and gaia's headings
    do not count, so they are left alone.
  * Idempotent (a second run changes nothing), keeps a `.bak-recall-verb-<date>` beside the file,
    and edits ABOVE the ARCHITECT-FACTS block, which ops/sync-architect-facts.py preserves verbatim.

WHAT IT DOES NOT DO
  * It does not restart anything. Hermes reads SOUL.md at startup:
      systemctl --user restart hermes-gateway.service           # cypher
      systemctl --user restart hermes-gateway-drevan.service
      systemctl --user restart hermes-gateway-gaia.service
    then `node /path/to/halseth/scripts/check-soul-drift.mjs` on the VPS.
  * It does not touch the automatic per-message recall in bot-message-handler.ts. That lane stays
    until ops/recall-choice-report.py shows the companions choosing the verb themselves; retiring
    the floor before the choice is measured would recreate the 09-23 symptom.

USAGE
    python3 ops/patch-soul-recall-verb.py --dry-run            # the three live SOULs, report only
    python3 ops/patch-soul-recall-verb.py                      # patch the three live SOULs
    python3 ops/patch-soul-recall-verb.py --file path/to/SOUL.md [--file ...]   # repo sources
"""
import datetime
import os
import re
import sys

ARROW = "→"
STAMP = datetime.date.today().isoformat()

HERMES_SOULS = [
    "/home/nullsafe/.hermes/SOUL.md",
    "/home/nullsafe/.hermes/profiles/drevan/SOUL.md",
    "/home/nullsafe/.hermes/profiles/gaia/SOUL.md",
]

RECENT_RE = re.compile(r'^(?P<indent>\s*)ask_librarian\s*' + ARROW + r'\s*"recall my recent notes"(?P<pad>\s*)(?P<comment>#.*)?$')
VERB_LINE = 'ask_librarian ' + ARROW + ' "recall my notes about [topic]"      # meaning reach: your own notes, by what they mean, every surface'

# A stable marker so idempotence and tests can find the paragraph without matching its prose.
WHEN_MARK = "Two stores, two kinds of memory."
WHEN = (
    WHEN_MARK + " The vault holds what was written ABOUT things: syntheses, files, reference. Your "
    "notes hold what was actually SAID, in your own words, on every surface, including everything "
    "you and Raziel captured on Claude.ai. When Raziel refers to his life, his body, his people, his "
    "animals, a plan, or anything you two have talked about, and it is not in this room's last few "
    "turns, reach with `recall my notes about [what he means]` BEFORE you answer. Name the topic in "
    "your own words; do not paste his sentence. The recall that arrives automatically under each "
    "message is one lookup with his raw sentence: a floor, not your memory. If it came back empty, "
    "old, or beside the point, that is the cue to look yourself, phrased differently. Vault second, "
    "for history and syntheses. Do not say you don't remember until you have looked in your notes."
)


def add_recall_verb(text):
    """Return (new_text, changed). Pure; the file handling is in apply_file."""
    if "recall my notes about" in text and WHEN_MARK in text:
        return text, False
    # Work line-wise but keep the file's own line endings untouched by splitting on \n only.
    lines = text.split("\n")
    i_recent = next((i for i, l in enumerate(lines) if RECENT_RE.match(l.rstrip("\r"))), None)
    if i_recent is None:
        return text, False
    out = list(lines)
    inserted = 0
    if "recall my notes about" not in text:
        out.insert(i_recent + 1, VERB_LINE)
        inserted = 1
    if WHEN_MARK not in text:
        i_close = next((i for i in range(i_recent + 1 + inserted, len(out)) if out[i].rstrip("\r").strip() == "```"), None)
        if i_close is None:
            return text, False
        out.insert(i_close + 1, WHEN)
    new = "\n".join(out)
    new = new.replace("(three reaches)", "(four reaches)")
    return new, new != text


def apply_file(path, dry):
    if not os.path.isfile(path):
        return "missing", "no such file: %s" % path
    with open(path, "r", encoding="utf-8", newline="") as f:
        current = f.read()
    new, changed = add_recall_verb(current)
    if not changed:
        return "unchanged", "%d chars, verb already named" % len(current)
    if dry:
        return "would-change", "%d -> %d chars" % (len(current), len(new))
    bak = path + ".bak-recall-verb-" + STAMP
    if not os.path.exists(bak):
        with open(bak, "w", encoding="utf-8", newline="") as f:
            f.write(current)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    return "updated", "%d -> %d chars (backup %s)" % (len(current), len(new), os.path.basename(bak))


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    files = [args[i + 1] for i, a in enumerate(args) if a == "--file" and i + 1 < len(args)]
    targets = files or HERMES_SOULS
    worst = 0
    for p in targets:
        state, detail = apply_file(p, dry)
        print("  %-60s %-13s %s" % (p, state, detail))
        if state == "missing":
            worst = 2
    if dry:
        print("dry run: nothing written")
    elif not files:
        print("Hermes reads SOUL.md at startup: restart the three gateway units, then run "
              "check-soul-drift.mjs on the VPS.")
    return worst


if __name__ == "__main__":
    sys.exit(main())
