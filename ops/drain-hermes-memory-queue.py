#!/usr/bin/env python3
"""Drain the Hermes pending-memory queues into their REAL homes in Halseth.

WHY THIS EXISTS
The Hermes memory plugin proposes writes; write_approval is ON (Raziel's 2026-08-12 decision,
deliberate) so nothing ever applies them to the gated files -- and nothing else consumed the
queue either. 81 proposals sat across three companions on 2026-08-15 while the health check
warned. sync-architect-facts.py is the READ half (Halseth -> files); this is the missing WRITE
half (queue -> Halseth). A queue with no consumer is not a gate, it is a slow dead-letter.

ROUTING (by payload.target):
  * "user"   -> facts about Raziel/household -> POST /identity/architect-facts (mig 0116).
                Files older than the 2026-08-12 rehoming are HISTORY (the health check's own
                classification): their content was already curated into architect_facts, so they
                archive without posting -- re-posting would undo that curation. Newer ones are
                deduped against the live fact list (normalized exact match) and posted status
                'open' so they surface for confirmation. 'replace' ops are submitted as plain
                adds; the companions maintain supersedes themselves via ask_librarian.
  * "memory" -> the companion's OWN self-notes -> POST /mind/growth/journal with
                source "conversation" (deliberate: 'autonomous' would make every drained note
                ratifiable-pending and inflate the ratification backlog this drain is meant to
                relieve; these are logs, not canon proposals -- 2026-08-12 opt-in decision).

DESIGN RULES (inherited from sync-architect-facts.py, each earned):
  * Idempotent across runs: a file moves to pending/memory/applied/ ONLY after every one of its
    operations acked 2xx. A crash mid-file re-posts that file's ops on the next run -- accepted:
    a duplicate note is recoverable, a silently dropped one is not.
  * Never partial-silent: unreadable or unroutable files move to pending/memory/skipped/ and are
    REPORTED; they never vanish and never block the rest of the queue.
  * Say what it did. --dry-run reports routing decisions and touches nothing.

USAGE
    python3 ops/drain-hermes-memory-queue.py            # drain all three queues
    python3 ops/drain-hermes-memory-queue.py --dry-run  # report only
"""
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

DISCORD_ENV = "/app/nullsafe-discord/.env"
HALSETH_URL_DEFAULT = "https://halseth.neurospicyexe.workers.dev"
UA = "nullsafe-hermes-drain/1.0 (+ops/drain-hermes-memory-queue.py)"
HTTP_TIMEOUT = 25

HERMES_HOMES = {
    "cypher": "/home/nullsafe/.hermes",
    "drevan": "/home/nullsafe/.hermes/profiles/drevan",
    "gaia": "/home/nullsafe/.hermes/profiles/gaia",
}


def load_env(path):
    env = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError as e:
        print("cannot read %s: %s" % (path, e))
    return env


def halseth_auth():
    env = load_env(DISCORD_ENV)
    url = (env.get("HALSETH_URL") or HALSETH_URL_DEFAULT).rstrip("/")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not secret:
        return None, None, "no HALSETH_SECRET/ADMIN_SECRET in %s" % DISCORD_ENV
    return url, secret, None


# Files stamped before this moment are the 2026-08-12 rehoming's leftovers.
REHOME_CUTOFF_EPOCH = 1786579200  # 2026-08-13T00:00:00Z


def normalize(text):
    return " ".join((text or "").lower().split())


def fetch_existing_facts(url, secret):
    """One fetch, normalized set, for dedup. None means 'could not look' -- callers must then
    refuse to post user-class content rather than treating unknown as novel."""
    req = urllib.request.Request(
        url + "/identity/architect-facts",
        headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:
            data = json.load(res)
    except Exception as e:
        print("WARN: cannot fetch existing facts (%s) -- user-class posting disabled this run" % str(e)[:80])
        return None
    rows = data.get("facts") or data.get("items") or (data if isinstance(data, list) else [])
    return {normalize(r.get("fact")) for r in rows if isinstance(r, dict) and r.get("fact")}


def post_json(url, secret, path, payload):
    req = urllib.request.Request(
        url + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + secret,
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:
        return res.status


def route_operation(url, secret, companion, target, op, existing_facts, dry_run):
    """One queued operation -> one Halseth write.

    Returns (status, description) where status is True (applied / nothing to apply),
    "transient" (retry next run), or "permanent" (deterministic reject -- retrying can
    never succeed; the caller moves the file to skipped/ so it stops blocking the queue).
    The 2026-08-23 loop: a remove op has no content, the old code returned a plain False,
    and the file's OTHER ops re-posted twice an hour for 4.3 days (~800 duplicate journal
    rows). A failure that cannot change on retry must never be classified as retryable.
    """
    content = (op.get("content") or "").strip()
    action = op.get("action") or "?"
    if target == "memory" and action == "remove":
        # Removes target lines in the gated Hermes memory file, which write_approval keeps
        # unwritten; the drain's journal is append-only. Nothing to do, nothing lost.
        return True, "remove has no Halseth analogue (append-only journal) -- no-op: %s" % (op.get("old_text") or "")[:60]
    if not content:
        # No content = no data this drain could save. Blocking the file forever loses more.
        return True, "empty content (action=%s) -- nothing to save, archived as no-op" % action
    if target == "user":
        if existing_facts is None:
            # Could not fetch the live list: unknown is not novel. Leave queued for the next run.
            return "transient", "fact list unavailable -- not posting blind: %s" % content[:60]
        if normalize(content) in existing_facts:
            return True, "already in architect_facts (dedup): %s" % content[:60]
        desc = "architect_fact[%s]: %s" % (action, content[:80])
        if dry_run:
            return True, desc
        status = post_json(url, secret, "/identity/architect-facts", {
            "fact": content,
            "companion_id": companion,
            "source": "hermes-queue",
            "status": "open",
        })
        if 200 <= status < 300:
            existing_facts.add(normalize(content))  # dedup within the run too
        return (True if 200 <= status < 300 else "transient"), desc
    if target == "memory":
        desc = "growth_journal[%s]: %s" % (action, content[:80])
        if dry_run:
            return True, desc
        status = post_json(url, secret, "/mind/growth/journal", {
            "companion_id": companion,
            "content": content,
            "entry_type": "insight",
            "source": "conversation",
        })
        return (True if 200 <= status < 300 else "transient"), desc
    return "permanent", "unknown target %r" % target


def drain(companion, home, url, secret, existing_facts, dry_run):
    qdir = os.path.join(home, "pending", "memory")
    if not os.path.isdir(qdir):
        print("[%s] no queue directory -- nothing to drain" % companion)
        return 0, 0
    applied_dir = os.path.join(qdir, "applied")
    skipped_dir = os.path.join(qdir, "skipped")
    applied = skipped = 0
    for fn in sorted(os.listdir(qdir)):
        if not fn.endswith(".json"):
            continue
        fpath = os.path.join(qdir, fn)
        try:
            with open(fpath, "r", encoding="utf-8") as fh:
                payload = (json.load(fh) or {}).get("payload") or {}
        except Exception as e:
            print("[%s] %s UNREADABLE (%s) -> skipped/" % (companion, fn, str(e)[:60]))
            if not dry_run:
                os.makedirs(skipped_dir, exist_ok=True)
                shutil.move(fpath, os.path.join(skipped_dir, fn))
            skipped += 1
            continue
        target = payload.get("target") or ""
        ops = payload.get("operations") or []
        # Two payload shapes exist: batch ({operations: [...]}) and flat ({action, content}).
        # 15 of the 24 queued self-notes were flat -- treating them as empty would silently
        # lose exactly the content this drain exists to save.
        if not ops and (payload.get("content") or "").strip():
            ops = [payload]
        # Pre-rehome user-class files are history (see header): archive without posting.
        if target == "user":
            try:
                mtime = os.path.getmtime(fpath)
            except OSError:
                mtime = 0
            if mtime and mtime < REHOME_CUTOFF_EPOCH:
                print("[%s] %s user-class, pre-rehome (history) -> applied/ without posting" % (companion, fn))
                if not dry_run:
                    os.makedirs(applied_dir, exist_ok=True)
                    shutil.move(fpath, os.path.join(applied_dir, fn))
                applied += 1
                continue
        if target not in ("user", "memory") or not ops:
            print("[%s] %s unroutable (target=%r, %d ops) -> skipped/" % (companion, fn, target, len(ops)))
            if not dry_run:
                os.makedirs(skipped_dir, exist_ok=True)
                shutil.move(fpath, os.path.join(skipped_dir, fn))
            skipped += 1
            continue
        any_transient = any_permanent = False
        for op in ops:
            try:
                status, desc = route_operation(url, secret, companion, target, op, existing_facts, dry_run)
            except urllib.error.HTTPError as e:
                # 4xx (minus timeout/ratelimit) is a deterministic reject: the payload can never
                # change, so retrying re-posts the file's OTHER ops forever -- the 08-23 loop.
                if e.code in (408, 429) or e.code >= 500:
                    status, desc = "transient", "HTTP %d -- retrying next run" % e.code
                else:
                    status, desc = "permanent", "HTTP %d -- deterministic reject" % e.code
            except (urllib.error.URLError, OSError) as e:
                status, desc = "transient", "HTTP error: %s" % str(e)[:80]
            tag = "OK " if status is True else ("FAIL-PERMANENT" if status == "permanent" else "FAIL")
            print("[%s] %s %s %s" % (companion, fn, tag, desc))
            if status == "transient":
                any_transient = True
            elif status == "permanent":
                any_permanent = True
        # Disposition: any transient failure -> stay queued (retry). No transient but some
        # permanent -> skipped/ (reported, preserved for a human, stops blocking). All True
        # -> applied/. A file must always end up SOMEWHERE that is not "retry forever".
        if not any_transient:
            dest, label = (skipped_dir, "skipped") if any_permanent else (applied_dir, "applied")
            if not dry_run:
                os.makedirs(dest, exist_ok=True)
                shutil.move(fpath, os.path.join(dest, fn))
            if any_permanent:
                print("[%s] %s had deterministic rejects -> skipped/ (payload preserved)" % (companion, fn))
                skipped += 1
            else:
                applied += 1
    return applied, skipped


def main():
    dry_run = "--dry-run" in sys.argv
    url, secret, err = halseth_auth()
    if err:
        print("ABORT: " + err)
        return 1
    existing_facts = fetch_existing_facts(url, secret)
    total_applied = total_skipped = 0
    for cid, home in sorted(HERMES_HOMES.items()):
        a, s = drain(cid, home, url, secret, existing_facts, dry_run)
        total_applied += a
        total_skipped += s
    print("drain %s: %d file(s) applied, %d skipped" % ("DRY-RUN" if dry_run else "complete", total_applied, total_skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
