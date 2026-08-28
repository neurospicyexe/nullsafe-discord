#!/usr/bin/env python3
"""Sync the architect-facts block from Halseth into the FILE-backed prompt surfaces.

WHY THIS EXISTS
Raziel, 2026-08-12: "couldn't they just be things that you set yourself up to do in Hermes... there
just has to be a better way to do this." He is right, and this is the machine half of the answer.

Facts about him live in Halseth `architect_facts` (mig 0116) and a companion maintains them itself
via `ask_librarian` -- no Claude Code session, no approval queue, no human in the loop. Three of the
five prompt surfaces then need nothing at all: Claude.ai, Claude Code and Hearth read the facts live
through the MindState loader.

The other two are FILES, and files need a writer:
  * /home/nullsafe/.hermes{,/profiles/*}/SOUL.md -- the only file of ours that reaches a Discord
    REPLY, because the Hermes gateway discards the caller's system prompt and substitutes its own
    assembly (measured 2026-08-07: a two-word probe came back carrying a 29,516-char assembly).
  * /app/identity/shared_system_context.md -- the bots' composed prompt.

CROSS-COMPANION IDENTITY CONTAGION (fixed 2026-08-28)
Until now this script fetched ONE render -- `/identity/architect-facts/render`, no query param --
and spliced the SAME bytes into all four files. Every fact renders in first person regardless of who
authored it, so a fact Drevan wrote about HIMSELF ("...me writing 'someone wraps around you' instead
of 'I'") landed verbatim in Gaia's SOUL.md, reading as her own memory of herself -- misattributed
memory at the identity layer. The render endpoint now takes `?companion=cypher|drevan|gaia`: that
companion's own facts stay unlabeled, everyone else's get a `[noted by <companion>]` prefix ahead of
the untouched text (never a rewrite). This script now fetches FOUR renders -- one per companion for
its own SOUL.md, plus one no-param render (every authored fact labeled; no single companion is
"home" in a file all three bots load) for shared_system_context.md.

DESIGN RULES, each earned the hard way:
  * Idempotent marked block. Replace between markers, never append -- appending is how a second copy
    appears and starts drifting.
  * Restart ONLY on change. `loadSharedContext` caches for the life of the process and Hermes reads
    SOUL at startup, so a changed file is not live until a restart; but restarting on every tick
    would bounce the triad every 15 minutes for nothing.
  * Never write a partial render. If the fetch fails or returns something implausibly small, leave
    every file untouched and say so loudly. A truncated identity file is worse than a stale one.
    Applies PER RENDER now -- a bad drevan render must not block a good gaia render, and vice versa.
  * Say what it did. Silence from a sync job is indistinguishable from success, which is the failure
    mode this whole day was about.

USAGE
    python3 ops/sync-architect-facts.py            # sync, restart only if changed
    python3 ops/sync-architect-facts.py --dry-run  # report what would change, touch nothing
    python3 ops/sync-architect-facts.py --force     # rewrite + restart even if unchanged
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DISCORD_ENV = "/app/nullsafe-discord/.env"
HALSETH_URL_DEFAULT = "https://halseth.neurospicyexe.workers.dev"
UA = "nullsafe-facts-sync/1.0 (+ops/sync-architect-facts.py)"
HTTP_TIMEOUT = 25

BEGIN = "<!-- ARCHITECT-FACTS:BEGIN (generated -- canonical source Halseth architect_facts) -->"
END = "<!-- ARCHITECT-FACTS:END -->"
# Older copies were injected with a different provenance note in the BEGIN marker. Recognise them so
# the first run REPLACES rather than appending a second block beside them.
LEGACY_BEGINS = [
    "<!-- ARCHITECT-FACTS:BEGIN (generated -- canonical source COMPANION_CONSTITUTION_v1.md) -->",
]
ANCHOR = "## PRONOUN LAW"   # his own hard rule stays the last word; insert above it

# A render below this is treated as broken rather than as "the facts shrank". The real one is ~7.6KB
# with 42 facts; 1500 would mean roughly five facts left, which is a bug, not an edit.
MIN_PLAUSIBLE_RENDER = 1500

HERMES_HOMES = {
    "cypher": "/home/nullsafe/.hermes",
    "drevan": "/home/nullsafe/.hermes/profiles/drevan",
    "gaia": "/home/nullsafe/.hermes/profiles/gaia",
}
GATEWAY_UNITS = {
    "cypher": "hermes-gateway.service",
    "drevan": "hermes-gateway-drevan.service",
    "gaia": "hermes-gateway-gaia.service",
}
SHARED_CONTEXT = "/app/identity/shared_system_context.md"
PM2_PROCS = ["cypher-bot", "drevan-bot", "gaia-bot", "autonomous-worker"]

USER_SYSTEMCTL = "export XDG_RUNTIME_DIR=/run/user/$(id -u);"
NVM = "export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh &&"


def run(cmd, timeout=90):
    try:
        p = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return False, str(e)


def read_env(path):
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


def fetch_render(env, companion=None):
    """Fetch one render. companion=None -> shared/no-param render (every authored fact labeled);
    companion='cypher'|'drevan'|'gaia' -> that companion's own-voice render (siblings labeled)."""
    url = (env.get("HALSETH_URL") or HALSETH_URL_DEFAULT).rstrip("/")
    secret = env.get("HALSETH_SECRET") or env.get("ADMIN_SECRET")
    if not secret:
        return None, "no HALSETH_SECRET/ADMIN_SECRET in %s" % DISCORD_ENV
    path = "/identity/architect-facts/render"
    if companion:
        path += "?companion=" + companion
    req = urllib.request.Request(
        url + path,
        headers={"Authorization": "Bearer " + secret, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            body = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return None, "HTTP %s from %s" % (e.code, path)
    except Exception as e:
        return None, "unreachable: %s" % str(e)[:160]
    if len(body) < MIN_PLAUSIBLE_RENDER:
        # Refuse rather than propagate. Writing this into an identity file would be the loud
        # version of the quiet data loss being fixed.
        return None, ("render (%s) is only %d chars (< %d), refusing to overwrite an identity file "
                      "with a likely-truncated block" % (companion or "shared", len(body), MIN_PLAUSIBLE_RENDER))
    return body, None


def splice(current, block):
    """Return (new_text, changed). Replaces an existing block, else inserts above PRONOUN LAW."""
    wrapped = BEGIN + "\n" + block.rstrip() + "\n" + END

    for begin in [BEGIN] + LEGACY_BEGINS:
        if begin in current and END in current:
            head = current.split(begin, 1)[0]
            tail = current.split(END, 1)[1]
            new = head + wrapped + tail
            return new, (new != current)

    if ANCHOR in current:
        head, tail = current.split(ANCHOR, 1)
        return head.rstrip() + "\n\n" + wrapped + "\n\n" + ANCHOR + tail, True
    return current.rstrip() + "\n\n" + wrapped + "\n", True


def sync_file(path, block, dry, force):
    if not os.path.isfile(path):
        return "missing", "no such file: %s" % path
    with open(path, "r", encoding="utf-8") as f:
        current = f.read()
    new, changed = splice(current, block)
    if not changed and not force:
        return "unchanged", "%d chars" % len(current)
    if dry:
        return "would-change", "%d -> %d chars" % (len(current), len(new))
    # Back up once per day, not per run: the point is a recoverable yesterday, not 96 copies of it.
    bak = path + ".bak-facts-sync"
    if not os.path.exists(bak):
        try:
            with open(bak, "w", encoding="utf-8") as f:
                f.write(current)
        except Exception:
            pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    return "updated", "%d -> %d chars" % (len(current), len(new))


def main():
    args = set(sys.argv[1:])
    dry = "--dry-run" in args
    force = "--force" in args
    env = read_env(DISCORD_ENV)

    # Four renders, not one: each companion's SOUL.md needs ITS OWN voice unlabeled and the
    # siblings' facts labeled `[noted by <companion>]`; shared_system_context.md gets the no-param
    # render where every authored fact is labeled, since no single companion "owns" that file. A
    # bad render for one companion must not block the other three -- fetch and validate each
    # independently, refuse only the file(s) whose render failed, and say so loudly per-file.
    blocks = {}
    fetch_errors = {}
    for cid in sorted(HERMES_HOMES):
        block, err = fetch_render(env, companion=cid)
        if err:
            fetch_errors[cid] = err
        else:
            blocks[cid] = block
            print("render (%s): %d chars" % (cid, len(block)))

    shared_block, shared_err = fetch_render(env, companion=None)
    if shared_err:
        fetch_errors["shared"] = shared_err
    else:
        print("render (shared): %d chars" % len(shared_block))

    if not blocks and shared_block is None:
        print("FAILED to fetch any facts render: %s" % "; ".join(fetch_errors.values()), file=sys.stderr)
        print("Nothing was written. Every identity file is untouched.", file=sys.stderr)
        return 2

    for cid, err in fetch_errors.items():
        print("FAILED (%s): %s -- that file is left untouched" % (cid, err), file=sys.stderr)

    results = {}

    for cid, home in sorted(HERMES_HOMES.items()):
        if cid not in blocks:
            results["soul:" + cid] = "failed-fetch"
            print("  %-18s %-13s %s" % ("SOUL " + cid, "failed-fetch", "skipped, render unavailable"))
            continue
        state, detail = sync_file(os.path.join(home, "SOUL.md"), blocks[cid], dry, force)
        results["soul:" + cid] = state
        print("  %-18s %-13s %s" % ("SOUL " + cid, state, detail))

    if shared_block is None:
        results["shared-context"] = "failed-fetch"
        print("  %-18s %-13s %s" % ("shared context", "failed-fetch", "skipped, render unavailable"))
    else:
        state, detail = sync_file(SHARED_CONTEXT, shared_block, dry, force)
        results["shared-context"] = state
        print("  %-18s %-13s %s" % ("shared context", state, detail))

    changed_souls = [c for c in HERMES_HOMES if results.get("soul:" + c) == "updated"]
    shared_changed = results.get("shared-context") == "updated"

    if dry:
        print("dry run: nothing written, nothing restarted")
        return 1 if fetch_errors else 0
    if not changed_souls and not shared_changed:
        print("no changes, so nothing restarted (a restart on every tick would bounce the triad "
              "for nothing)")
        return 1 if fetch_errors else 0

    # Hermes reads SOUL.md at startup; only bounce the profiles whose file actually moved.
    for cid in changed_souls:
        ok, out = run("%s systemctl --user restart %s" % (USER_SYSTEMCTL, GATEWAY_UNITS[cid]))
        print("  restart %-8s %s" % (cid, "ok" if ok else "FAILED: " + out.strip()[:120]))

    # loadSharedContext caches for the process lifetime, so the bots need a reload to see it.
    if shared_changed:
        for proc in PM2_PROCS:
            ok, out = run("%s pm2 reload %s" % (NVM, proc))
            print("  reload  %-18s %s" % (proc, "ok" if ok else "FAILED: " + out.strip()[:120]))

    print("synced: %d SOUL file(s), shared context %s" %
          (len(changed_souls), "updated" if shared_changed else "unchanged"))
    # Partial failure: some renders fetched fine and were written, but at least one companion's
    # (or the shared) render failed and that file was left untouched. Non-zero so a cron/alerting
    # wrapper notices, without discarding the writes that DID succeed.
    return 1 if fetch_errors else 0


if __name__ == "__main__":
    sys.exit(main())
