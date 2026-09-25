#!/usr/bin/env python3
"""Does the companion CHOOSE to look? Read-only read-out of ask_librarian verbs from the Hermes
state.dbs, per companion, per day. Own-the-harness step 3, the instrument.

WHY THIS EXISTS (2026-09-25)
Step 3 of docs/PLAN-own-the-harness-v2-2026-09-24.md: "a chosen recall verb replaces automatic
one-shot vault injection." The automatic lane (bot-message-handler.ts: one vault lookup plus one
own-notes lookup per message, query = Raziel's raw sentence) cannot be retired on principle; it
fixed the 09-23 ankle symptom. It can be retired when this report shows the companions reaching
for `recall my notes about ...` themselves, in the bots' lane, at a rate that covers what the
automatic lane was catching. Until this number moves, the floor stays.

Baseline, measured 09-25 on sessions since 09-04 (api_server = the bots):
    cypher   246 calls   vault-search 60   recall-recent  0   recall-notes-meaning 0
    drevan  1333 calls   vault-search 997  recall-recent ~12  recall-notes-meaning 0
    gaia     376 calls   vault-search 102  recall-recent 12   recall-notes-meaning 0

Read-only: opens each state.db with `mode=ro`, never contacts Halseth, Discord or Hermes. The
tool name is `mcp_halseth_ask_librarian` (the MCP prefix), not `ask_librarian`; the first pass
of this measurement missed all 1,955 calls by grepping the short name.

USAGE (on the VPS)
    python3 ops/recall-choice-report.py                 # since 14 days ago
    python3 ops/recall-choice-report.py --since 2026-09-04
    python3 ops/recall-choice-report.py --json
"""
import collections
import datetime
import json
import os
import re
import sqlite3
import sys

HERMES_HOMES = {
    "cypher": "/home/nullsafe/.hermes",
    "drevan": "/home/nullsafe/.hermes/profiles/drevan",
    "gaia": "/home/nullsafe/.hermes/profiles/gaia",
}
TOOL = "mcp_halseth_ask_librarian"

# Order matters: a WRITE that mentions "notes" must be caught as a write before the recall
# patterns see it. Recall triggers mirror halseth src/librarian/patterns.ts (notes_recall_meaning
# and sb_search) so this report counts what the Librarian would actually route.
_WRITE = re.compile(r"^(write|log|update|record|note to|note for|how i feel|capture|i've concluded|declare)\b", re.I)
_RECALL_MEANING = re.compile(r"recall (my )?notes about|recall continuity notes|search my continuity notes|my continuity notes about|what did i note about|do i have notes on|what have i carried about", re.I)
_RECALL_RECENT = re.compile(r"recall my recent notes", re.I)
_VAULT = re.compile(r"search (the )?vault|vault for|search my notes|what do i know about", re.I)
_READ = re.compile(r"^read (the )?file\b", re.I)
_SESSION = re.compile(r"open my session", re.I)
_IDENTITY = re.compile(r"identity check|load (your|my) full kernel|orient", re.I)
_TASK = re.compile(r"\btasks?\b", re.I)

VERBS = ["recall-notes-meaning", "recall-recent", "vault-search", "read-file", "session-open",
         "identity", "write", "task", "other"]


def classify(request):
    q = (request or "").strip()
    if not q:
        return "other"
    if _WRITE.search(q):
        return "write"
    if _RECALL_MEANING.search(q):
        return "recall-notes-meaning"
    if _RECALL_RECENT.search(q):
        return "recall-recent"
    if _VAULT.search(q):
        return "vault-search"
    if _READ.search(q):
        return "read-file"
    if _SESSION.search(q):
        return "session-open"
    if _IDENTITY.search(q):
        return "identity"
    if _TASK.search(q):
        return "task"
    return "other"


def librarian_requests(tool_calls_json):
    """The `request` strings of every ask_librarian call in one assistant message's tool_calls."""
    if not tool_calls_json:
        return []
    try:
        calls = json.loads(tool_calls_json)
    except Exception:
        return []
    out = []
    for tc in calls or []:
        fn = (tc or {}).get("function") or {}
        if fn.get("name") != TOOL:
            continue
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            continue
        if isinstance(args, dict):
            out.append(str(args.get("request") or ""))
    return out


def aggregate(rows):
    """rows: iterable of (timestamp_text, request). -> {day: {verb: n}}"""
    agg = collections.defaultdict(lambda: collections.Counter())
    for ts, req in rows:
        agg[str(ts)[:10]][classify(req)] += 1
    return {d: dict(c) for d, c in agg.items()}


def read_profile(home, since_epoch):
    db_path = os.path.join(home, "state.db")
    if not os.path.isfile(db_path):
        return None, "no state.db at %s" % home
    try:
        db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
        cur = db.execute(
            "select datetime(m.timestamp, 'unixepoch') ts, m.tool_calls from messages m "
            "join sessions s on s.id = m.session_id "
            "where s.source = 'api_server' and m.role = 'assistant' and m.tool_calls is not null "
            "and m.timestamp >= ?", (since_epoch,))
        rows = []
        for ts, tcj in cur:
            for req in librarian_requests(tcj):
                rows.append((ts, req))
        db.close()
        return aggregate(rows), None
    except Exception as e:
        return None, str(e)[:120]


def render(per_companion, since):
    out = ["# Chosen recall read-out (ask_librarian verbs, bots' lane) since %s" % since, ""]
    for cid in sorted(per_companion):
        agg = per_companion[cid] or {}
        total = collections.Counter()
        for day in agg.values():
            total.update(day)
        n = sum(total.values())
        out.append("## %s: %d calls" % (cid, n))
        out.append("  " + "  ".join("%s=%d" % (v, total.get(v, 0)) for v in VERBS))
        if agg:
            out.append("  per day (recall-notes-meaning / recall-recent / vault-search):")
            for day in sorted(agg):
                d = agg[day]
                out.append("    %s  %3d / %3d / %3d" % (day, d.get("recall-notes-meaning", 0), d.get("recall-recent", 0), d.get("vault-search", 0)))
        out.append("")
    out.append("The floor (automatic per-message recall in bot-message-handler.ts) can go when "
               "recall-notes-meaning is a daily habit for each companion, not before.")
    return "\n".join(out)


def main():
    args = sys.argv[1:]
    since = None
    if "--since" in args:
        since = args[args.index("--since") + 1]
    if not since:
        since = (datetime.date.today() - datetime.timedelta(days=14)).isoformat()
    since_epoch = datetime.datetime.strptime(since, "%Y-%m-%d").timestamp()
    per = {}
    errors = {}
    for cid, home in HERMES_HOMES.items():
        agg, err = read_profile(home, since_epoch)
        per[cid] = agg or {}
        if err:
            errors[cid] = err
    if "--json" in args:
        print(json.dumps({"since": since, "per_companion": per, "errors": errors}, indent=2))
    else:
        print(render(per, since))
        for cid, err in errors.items():
            print("  (%s: could not read: %s)" % (cid, err), file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
