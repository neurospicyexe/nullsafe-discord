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

RESTARTS WERE DROPPING REPLIES (B28, 2026-09-28)
Measured: 48 `ECONNREFUSED 127.0.0.1:864x` hits in the bot logs since August, each 0-14s after that
companion's gateway unit stopped. A restarted gateway takes 4-6s to listen, so every restart opened
an ~8-10s hole in which a reply fell back to the canned line. Two things fed it from here:
  * A number that ticks by itself. The open-facts footer renders `, oldest Nd` (halseth
    open-facts-gate.ts heldOpenFactsLine), which changes once a day with no fact changed, so every
    gateway bounced at 15:00 CDT daily. The fragment is stripped from what this script writes, and
    the on-disk block is compared AFTER the same normalization, so a stale file still carrying the
    old fragment is rewritten quietly ("normalized") instead of costing one more restart.
  * Restarting mid-conversation. A needed restart now waits until that companion's gateway has
    been quiet for IDLE_SECONDS (newest row in its Hermes state.db; see last_activity for why that
    signal), deferring tick to tick with the pending restart persisted in PENDING_STATE_PATH, and
    restarts anyway after DEFER_CAP_SECONDS so a busy evening cannot starve a real fact change.
    The same gate covers the pm2 reloads a shared-context change triggers (each bot on its own
    companion; autonomous-worker only when all three are quiet).

USAGE
    python3 ops/sync-architect-facts.py            # sync, restart only if changed AND idle
    python3 ops/sync-architect-facts.py --dry-run  # report what would change / restart / defer, touch nothing
    python3 ops/sync-architect-facts.py --force     # rewrite + restart even if unchanged, no idle wait
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Shared with health-check.py so the write guard and the alarm agree on what "over the cap" means.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soul_cap  # noqa: E402

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

# Which companions' activity gates each restart target. A bot process serves one companion; the
# autonomous worker drives all three, so it waits until the whole triad is quiet.
PM2_COMPANIONS = {
    "cypher-bot": ["cypher"],
    "drevan-bot": ["drevan"],
    "gaia-bot": ["gaia"],
    "autonomous-worker": ["cypher", "drevan", "gaia"],
}

# Idle deferral (B28). 15 minutes of silence is comfortably longer than the longest turn the bot
# will wait for (HERMES_REQUEST_TIMEOUT_MS default 300s), so "quiet" cannot mean "mid-turn". The 6h
# cap bounds how long a changed identity file can sit on disk unloaded.
IDLE_SECONDS = 15 * 60
DEFER_CAP_SECONDS = 6 * 60 * 60
# Same convention as health-check.py's state files (/home/nullsafe/.nullsafe-*-state.json).
PENDING_STATE_PATH = os.environ.get("FACTS_SYNC_PENDING_PATH",
                                    "/home/nullsafe/.nullsafe-facts-sync-pending.json")
# How far back from the newest row to look. Bounded by id on purpose: `messages` has no index on
# timestamp alone, and an unbounded MAX(timestamp) is a full scan of a >1GB file every 20 minutes.
ACTIVITY_WINDOW_ROWS = 200

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
    return strip_ticking(normalize_dashes(body)), None


# `, oldest 12d` in the held-open-questions footer (halseth open-facts-gate.ts heldOpenFactsLine).
# It is the only part of the render that changes with the clock rather than with the facts, and a
# byte change here restarts a gateway, so it cost every companion one dropped-reply window a day.
# The count of held questions stays: that moves only when a fact does. Stripped here, not in
# halseth, because the file-backed surfaces are the only consumers that pay for a changing byte.
_TICKING = re.compile(r", oldest \d+d\b")


def strip_ticking(text):
    """Remove clock-driven fragments so the block's bytes change only when a fact changes."""
    return _TICKING.sub("", text)


# House style bans the em dash (shared_system_context.md:190, "Do not use em dash character").
# The facts render is companion- and Claude-authored prose, so it carries them anyway: measured
# 2026-09-14, this block took shared_system_context.md from 2 em-dashes to 26, with 24 of the 26
# inside the synced text -- i.e. the prompt was showing all three companions 24 examples of a
# character it forbids in the same file. Normalising at the splice boundary fixes every consumer
# at once (all three SOUL.md plus the shared context) and leaves Halseth's stored fact text alone,
# which is right: the rule is about what we SHOW the models, not about editing the record.
#
# Scoped to this block on purpose. It is NOT a licence to rewrite a companion's own words
# elsewhere -- see the form-drift work the same day, where the fix was a prompt clause and
# explicitly never a rewrite layer on output.
def normalize_dashes(text):
    """Em dash / en dash -> the ASCII ' -- ' the house style uses, without doubling spaces."""
    out = text.replace("—", " -- ").replace("–", " -- ")
    while "  -- " in out or " --  " in out:
        out = out.replace("  -- ", " -- ").replace(" --  ", " -- ")
    return out


def existing_block(current):
    """The text between the markers already on disk (current or legacy BEGIN), or None."""
    for begin in [BEGIN] + LEGACY_BEGINS:
        if begin in current:
            rest = current.split(begin, 1)[1]
            if END in rest:
                return rest.split(END, 1)[0].strip("\n")
    return None


def is_material_change(current, block):
    """True when writing `block` changes what the model would read, ignoring ticking fragments.

    False covers the one case that used to cost a restart for nothing: a file written before the
    fragment was stripped, whose block differs from the new render ONLY by `, oldest Nd`."""
    old = existing_block(current)
    if old is None:
        return True
    return strip_ticking(old).rstrip() != block.rstrip()


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


# Sentinel for "this file has no Hermes cap" (shared_system_context.md is the bots' composed prompt,
# bounded by their own budget, not by prompt_builder.py). Distinct from cap=None, which means the
# SOUL's cap is UNPINNED and is refused: see soul_cap.py for why an unpinned cap is a live hazard.
NO_CAP = object()


def sync_file(path, block, dry, force, cap=NO_CAP, margin=soul_cap.DEFAULT_MARGIN):
    if not os.path.isfile(path):
        return "missing", "no such file: %s" % path
    with open(path, "r", encoding="utf-8") as f:
        current = f.read()
    new, changed = splice(current, block)
    if not changed and not force:
        return "unchanged", "%d chars" % len(current)
    # Bytes differ but only by a ticking fragment: rewrite the file clean, never restart for it.
    material = force or is_material_change(current, block)
    # PRE-WRITE GUARD (2026-09-25). Hermes cuts the middle out of SOUL.md the moment it crosses
    # context_file_max_chars, so a write that would land inside the margin is refused here, at the
    # only point that can still say no, rather than discovered by the health check fifteen minutes
    # after the identity file has already been cut. Refusal leaves the file exactly as it was.
    if cap is not NO_CAP:
        if cap is None:
            return "refused", ("cap is not pinned (context_file_max_chars null) so the limit is a "
                               "boot-time probe; refusing to write a file whose ceiling is unknown")
        if len(new) > cap - margin:
            return "refused", ("would be {:,} chars against a {:,} cap ({:,} margin): Hermes would cut "
                               "the middle out of it; file left at {:,} chars"
                               .format(len(new), cap, margin, len(current)))
    if dry:
        return ("would-change" if material else "would-normalize"), "%d -> %d chars" % (len(current), len(new))
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
    if not material:
        return "normalized", "%d -> %d chars (ticking fragment only, no restart)" % (len(current), len(new))
    return "updated", "%d -> %d chars" % (len(current), len(new))


# ── Idle deferral (B28) ─────────────────────────────────────────────────────────────────────────
# Pure decision logic (tested in ops/test_sync_architect_facts.py), then the thin I/O around it.

def last_activity(db_path):
    """(epoch seconds of the newest message row in this profile's Hermes state.db, error).

    WHY THIS SIGNAL (verified read-only 2026-09-28): every call the bots make lands in `messages`
    (sessions.source was `api_server` for every row of the last 24h in all three profiles), with
    `timestamp` stamped per row as the turn happens: the user row at turn START, then tool and
    assistant rows as they complete. Cross-checked against the bot logs the same day: gaia's
    heartbeat at 16:00:02 CDT <-> a gaia user row at 16:00:03; gaia's director pass at 15:33:37 <->
    15:33:36; drevan's 15:35 notes poll <-> 15:35:09. So an in-flight turn shows as activity from
    its first second, and ANY role counts (a long tool-calling turn keeps writing tool rows).

    Read-only URI open; the DB is WAL and the cron runs as the owning user. Any failure returns
    (None, why) and the caller treats unknown as BUSY: a deferred restart is bounded by the cap, a
    mid-turn restart is the harm this exists to remove."""
    if not os.path.isfile(db_path):
        return None, "no state.db at %s" % db_path
    try:
        con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=5)
        try:
            row = con.execute(
                "SELECT MAX(timestamp) FROM messages WHERE id > "
                "(SELECT COALESCE(MAX(id), 0) FROM messages) - ?", (ACTIVITY_WINDOW_ROWS,)
            ).fetchone()
        finally:
            con.close()
    except Exception as e:
        return None, "state.db unreadable: %s" % str(e)[:120]
    if not row or row[0] is None:
        return 0.0, None  # a profile that has never been spoken to is idle
    return float(row[0]), None


def combined_activity(cids, activity):
    """Newest activity across companions; None if ANY of them is unknown (unknown = busy)."""
    ts = []
    for c in cids:
        v = activity.get(c)
        if v is None:
            return None
        ts.append(v)
    return max(ts) if ts else None


def decide_restart(now, last_ts, pending_since, idle_s=IDLE_SECONDS, cap_s=DEFER_CAP_SECONDS):
    """-> (action, reason). action is 'restart', 'restart-cap' or 'defer'.

    The cap counts from the FIRST deferral (pending_since), not the latest change, so a render that
    keeps moving while the room is busy still restarts within cap_s."""
    waited = max(0.0, now - pending_since) if pending_since is not None else 0.0
    if pending_since is not None and waited >= cap_s:
        return "restart-cap", "deferred %s, at the %s cap; restarting anyway" % (_dur(waited), _dur(cap_s))
    if last_ts is None:
        return "defer", "activity unknown, treated as busy (pending %s)" % _dur(waited)
    quiet = now - last_ts
    if quiet >= idle_s:
        return "restart", "idle %s" % _dur(quiet)
    return "defer", "last message %s ago (< %s idle), pending %s" % (
        _dur(max(0.0, quiet)), _dur(idle_s), _dur(waited))


def merge_pending(pending, new_keys, now, reason="render changed"):
    """Add newly needed restarts to the pending map WITHOUT resetting an existing `since`."""
    out = {k: dict(v) for k, v in pending.items()}
    for k in new_keys:
        if k not in out:
            out[k] = {"since": now, "reason": reason}
    return out


def target_companions(key):
    """Which companions gate a restart target key; None for a key this version doesn't know."""
    kind, _, name = key.partition(":")
    if kind == "gateway" and name in GATEWAY_UNITS:
        return [name]
    if kind == "pm2" and name in PM2_COMPANIONS:
        return PM2_COMPANIONS[name]
    return None


def target_command(key):
    kind, _, name = key.partition(":")
    if kind == "gateway":
        return "%s systemctl --user restart %s" % (USER_SYSTEMCTL, GATEWAY_UNITS[name])
    return "%s pm2 reload %s" % (NVM, name)


def _dur(seconds):
    s = int(seconds)
    if s < 3600:
        return "%dm%02ds" % (s // 60, s % 60)
    return "%dh%02dm" % (s // 3600, (s % 3600) // 60)


def load_pending(path=None):
    path = path or PENDING_STATE_PATH
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return {k: v for k, v in data.items()
                if isinstance(v, dict) and isinstance(v.get("since"), (int, float))}
    except FileNotFoundError:
        return {}
    except Exception as e:
        print("pending state unreadable (%s), starting empty" % str(e)[:120], file=sys.stderr)
        return {}


def save_pending(pending, path=None):
    path = path or PENDING_STATE_PATH
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(pending, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)


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
        cap = soul_cap.read_pinned_cap(os.path.join(home, "config.yaml"))
        state, detail = sync_file(os.path.join(home, "SOUL.md"), blocks[cid], dry, force, cap=cap)
        results["soul:" + cid] = state
        print("  %-18s %-13s %s" % ("SOUL " + cid, state, detail),
              file=sys.stderr if state == "refused" else sys.stdout)
        if state == "refused":
            fetch_errors["soul:" + cid] = detail

    if shared_block is None:
        results["shared-context"] = "failed-fetch"
        print("  %-18s %-13s %s" % ("shared context", "failed-fetch", "skipped, render unavailable"))
    else:
        state, detail = sync_file(SHARED_CONTEXT, shared_block, dry, force)
        results["shared-context"] = state
        print("  %-18s %-13s %s" % ("shared context", state, detail))

    # "normalized" is deliberately absent: a ticking-fragment-only rewrite never restarts anything.
    material = ("updated", "would-change")
    changed_souls = [c for c in HERMES_HOMES if results.get("soul:" + c) in material]
    shared_changed = results.get("shared-context") in material

    # Hermes reads SOUL.md at startup, so only the profiles whose file actually moved need a bounce;
    # loadSharedContext caches for the process lifetime, so a shared change needs the pm2 reloads.
    new_keys = ["gateway:" + c for c in changed_souls]
    if shared_changed:
        new_keys += ["pm2:" + p for p in PM2_PROCS]

    now = time.time()
    pending = merge_pending(load_pending(), new_keys, now)

    if not pending:
        print("no changes, so nothing restarted (a restart on every tick would bounce the triad "
              "for nothing)")
        if dry:
            print("dry run: nothing written, nothing restarted")
        return 1 if fetch_errors else 0

    activity = {}
    for cid, home in HERMES_HOMES.items():
        ts, err = last_activity(os.path.join(home, "state.db"))
        activity[cid] = ts
        if err:
            print("  activity %-7s unknown: %s" % (cid, err), file=sys.stderr)

    pending, restarted = run_restarts(pending, activity, now, dry, force, run)

    if dry:
        print("dry run: nothing written, nothing restarted, pending state untouched")
        return 1 if fetch_errors else 0

    try:
        save_pending(pending)
    except Exception as e:
        print("FAILED to save pending state %s: %s" % (PENDING_STATE_PATH, e), file=sys.stderr)
        fetch_errors["pending-state"] = str(e)

    print("synced: %d SOUL file(s), shared context %s; restarted %d, still pending %d%s" % (
        len(changed_souls), "updated" if shared_changed else "unchanged", len(restarted), len(pending),
        (" (" + ", ".join(sorted(pending)) + ")") if pending else ""))
    # Partial failure: some renders fetched fine and were written, but at least one companion's
    # (or the shared) render failed and that file was left untouched. Non-zero so a cron/alerting
    # wrapper notices, without discarding the writes that DID succeed. A deferral is NOT a failure.
    return 1 if fetch_errors else 0


def run_restarts(pending, activity, now, dry, force, runner):
    """Decide and act on every pending restart target. -> (pending_after, restarted_keys).

    A deferred target keeps its original `since`; a failed restart stays pending so the next tick
    retries it; unknown keys (a target renamed between versions) are dropped with a log line.
    `runner(cmd) -> (ok, output)` is injected so the tick-to-tick behaviour is testable."""
    pending = {k: dict(v) for k, v in pending.items()}
    stamp = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(now))
    restarted = []
    for key in sorted(pending):  # "gateway:*" sorts before "pm2:*", so gateways come back first
        cids = target_companions(key)
        if cids is None:
            print("  %s dropping unknown pending target %s" % (stamp, key))
            del pending[key]
            continue
        if force:
            action, reason = "restart", "--force"
        else:
            action, reason = decide_restart(now, combined_activity(cids, activity), pending[key]["since"])
        if dry:
            print("  %s would %s %-24s %s" % (stamp, "DEFER  " if action == "defer" else "RESTART", key, reason))
            continue
        if action == "defer":
            print("  %s DEFER   %-24s %s" % (stamp, key, reason))
            continue
        ok, out = runner(target_command(key))
        label = "RESTART-CAP" if action == "restart-cap" else "RESTART"
        print("  %s %-7s %-24s %s -> %s" % (stamp, label, key, reason,
                                            "ok" if ok else "FAILED: " + out.strip()[:120]))
        if ok:
            restarted.append(key)
            del pending[key]
    return pending, restarted


if __name__ == "__main__":
    sys.exit(main())
