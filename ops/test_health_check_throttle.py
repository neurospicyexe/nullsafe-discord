"""Throttle regression test for ops/health-check.py (2026-08-07).

The live failure this pins: on 2026-08-06 the VPS disk filled and truncated the throttle's state
file to 0 bytes. `should_notify` caught the resulting JSON error and RETURNED on the spot, before
the code that rewrites the file -- so the state stayed corrupt, and every subsequent run took the
same branch. Raziel received 25 identical Telegram alerts, one every 15 minutes, and the loop could
only be broken by repairing the file by hand.

A missing file was always handled correctly. It was specifically the CORRUPT case -- the failure
path -- that could not recover, which is the worst place for a mechanism to be unable to heal.

Run: python3 ops/test_health_check_throttle.py
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("healthcheck", os.path.join(HERE, "health-check.py"))
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)


class FakeReport(object):
    """Minimal stand-in for the real Report: should_notify only reads .failures and .severity."""
    def __init__(self, failures, severity):
        self.failures = failures
        self.severity = severity


WARNING = FakeReport(
    [{"name": "halseth:guardian_flags", "severity": "warning"}],
    "warning",
)
DIFFERENT_WARNING = FakeReport(
    [{"name": "hermes:gateway", "severity": "red"}],
    "red",
)
HEALTHY = FakeReport([], "ok")

failures = []


def check(label, condition):
    print(("  PASS  " if condition else "  FAIL  ") + label)
    if not condition:
        failures.append(label)


def run_case(label, initial_bytes, report, expect_send, expect_state_written=True):
    """initial_bytes None = file absent."""
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    if initial_bytes is None:
        os.unlink(path)
    else:
        with open(path, "wb") as fh:
            fh.write(initial_bytes)

    prev_path = hc.STATE_PATH
    hc.STATE_PATH = path
    try:
        send, why = hc.should_notify(report)
        print("\n%s\n  -> send=%s reason=%r" % (label, send, why))
        check("notifies" if expect_send else "stays quiet", send is expect_send)
        if expect_state_written:
            ok = os.path.exists(path) and os.path.getsize(path) > 0
            check("state file rewritten (so the NEXT run can throttle)", ok)
            if ok:
                with open(path, encoding="utf-8") as fh:
                    check("state file is valid JSON with a fingerprint",
                          "fingerprint" in json.load(fh))
        return path
    finally:
        hc.STATE_PATH = prev_path
        if os.path.exists(path):
            os.unlink(path)


# The regression. Before the fix this notified but left the file at 0 bytes, so the next run
# hit the identical branch -- forever.
run_case("CORRUPT state (0 bytes, the disk-full case)", b"", WARNING, expect_send=True)
run_case("CORRUPT state (truncated JSON)", b'{"fingerprint": "halse', WARNING, expect_send=True)

# Cases that already worked, pinned so the fix does not regress them.
run_case("MISSING state file", None, WARNING, expect_send=True)

# Unchanged: must stay quiet, and must still record the observation.
fd, path = tempfile.mkstemp(suffix=".json")
os.close(fd)
with open(path, "w", encoding="utf-8") as fh:
    json.dump({
        "fingerprint": hc._fingerprint(WARNING),
        "severity": "warning",
        "last_notified": 9_999_999_999.0,  # far future, so the 12h re-notify cannot fire
    }, fh)
prev_path = hc.STATE_PATH
hc.STATE_PATH = path
try:
    send, why = hc.should_notify(WARNING)
    print("\nUNCHANGED state (same warning, already announced)\n  -> send=%s reason=%r" % (send, why))
    check("stays quiet -- this is the whole point of the throttle", send is False)

    send, why = hc.should_notify(DIFFERENT_WARNING)
    print("\nCHANGED state (a different thing broke)\n  -> send=%s reason=%r" % (send, why))
    check("speaks up on a real change", send is True)
finally:
    hc.STATE_PATH = prev_path
    os.unlink(path)

print("\n" + ("ALL PASS" if not failures else "FAILED: %r" % failures))
sys.exit(1 if failures else 0)
