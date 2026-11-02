"""Tests for ops/wellness_core.py (B8). Run: python3 ops/test_wellness_bridge.py

Everything external is a fake: no network, no token, no Telegram."""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wellness_core as wc  # noqa: E402

# Verbatim shape captured from the live connector on 2026-11-01.
WEARABLE = json.dumps({"result": (
    "Wearable Data (2026-10-31 -> 2026-11-01):\n"
    "2026-10-31: 7093 steps, Primary RHR 63 bpm (source apple_health, unclassified), Daytime resting HR 65 bpm "
    "(source apple_health), Sleeping resting HR (estimated) 59 bpm (source apple_health), Overnight minimum HR 53 bpm "
    "(source apple_health), HRV 48.32 ms, Zone Minutes 6 (6 moderate, 0 vigorous), burned 2,228 kcal "
    "(404 active + 1,824 resting), SpO2 95%, breathing 15.5 br/min\n"
    "2026-11-01: 2724 steps, Sleeping resting HR (estimated) 58 bpm (source apple_health), Overnight minimum HR 52 bpm "
    "(source apple_health), HRV 41.23 ms, burned 1,230 kcal (173 active + 1,057 resting)\n\n"
    "Maintenance (TDEE): ~2,344 kcal/day (range 1,875-2,813 kcal), a formula estimate."
)})
QUOTA = json.dumps({"result": "You've used your 3 free analysis interactions for today. Logging, updating, and "
                              "deleting your data always works, with no limit. Wait until tomorrow for 3 more, or "
                              "upgrade to Pro in the app for unlimited analysis."})


class Parse(unittest.TestCase):
    def test_wearable_live_shape(self):
        w = wc.parse_wearable(WEARABLE)
        self.assertEqual(w["2026-10-31"], {"steps": 7093, "resting_hr": 63, "hrv_resting": 48.32, "active_energy": 404.0})
        # no Primary RHR that day: falls to the estimated sleeping RHR, never the overnight minimum
        self.assertEqual(w["2026-11-01"]["resting_hr"], 58)
        self.assertEqual(len(w), 2)  # the TDEE line is not a day

    def test_quota_raises_on_both_tools(self):
        with self.assertRaises(wc.QuotaExhausted):
            wc.parse_wearable(QUOTA)
        with self.assertRaises(wc.QuotaExhausted):
            wc.parse_sleep(QUOTA)

    def test_sleep_shapes_and_naps(self):
        s = wc.parse_sleep("2026-10-31: 7h 12m, score 81\n2026-11-01 nap 0h 40m\n2026-10-30: 6.5 hours")
        self.assertEqual(s, {"2026-10-31": 7.2, "2026-10-30": 6.5})
        self.assertEqual(wc.parse_sleep("nothing parseable here"), {})


class Score(unittest.TestCase):
    def test_plan_example_flags_hard_and_a_calm_day_does_not(self):
        hot = wc.stress_score(22.1, 84, None, 30.0, 70)   # the 09-02 fever day
        calm = wc.stress_score(41.0, 58, 7.5, 45.0, 60)
        self.assertGreaterEqual(hot, 65)
        self.assertLess(calm, 25)

    def test_absent_is_never_zero_or_high(self):
        self.assertIsNone(wc.stress_score(None, 70, 7, 30, 70))
        self.assertIsNone(wc.stress_score(30, None, 7, 30, 70))
        self.assertIsNone(wc.stress_score(30, 70, 7, None, 70))

    def test_sleep_is_optional_and_only_adds(self):
        a = wc.stress_score(25, 78, None, 30, 70)
        b = wc.stress_score(25, 78, 4.0, 30, 70)
        self.assertGreater(b, a)
        self.assertLessEqual(b, 100)

    def test_baseline_needs_enough_prior_days(self):
        self.assertIsNone(wc.baseline([30] * (wc.BASELINE_MIN_SAMPLES - 1)))
        self.assertEqual(wc.baseline([30] * 7 + [None]), 30)
        hist = {"2026-10-%02d" % d: {"hrv_resting": 30, "resting_hr": 70} for d in range(1, 10)}
        self.assertEqual(wc.baselines_for("2026-10-10", hist), (30, 70))
        self.assertEqual(wc.baselines_for("2026-10-05", hist), (None, None))  # only 4 prior days


class Time(unittest.TestCase):
    def test_recorded_at_is_end_of_local_day_capped_at_now_and_dst_aware(self):
        now = datetime(2026, 11, 1, 20, 0, tzinfo=timezone.utc)
        # Oct 20 is CDT (UTC-5): end of day = 04:59:59Z next day
        self.assertEqual(wc.day_recorded_at("2026-10-20", now), "2026-10-21T04:59:59.000Z")
        # Nov 20 would be CST (UTC-6) if it were in the past
        later = datetime(2026, 12, 1, tzinfo=timezone.utc)
        self.assertEqual(wc.day_recorded_at("2026-11-20", later), "2026-11-21T05:59:59.000Z")
        # today's row is capped at the fetch time, not a future end-of-day
        self.assertEqual(wc.day_recorded_at("2026-11-01", now), "2026-11-01T20:00:00.000Z")

    def test_morning_vs_afternoon(self):
        self.assertTrue(wc.is_morning_run(datetime(2026, 11, 2, 13, 30, tzinfo=timezone.utc)))   # 07:30 CST
        self.assertFalse(wc.is_morning_run(datetime(2026, 11, 2, 22, 0, tzinfo=timezone.utc)))   # 16:00 CST


class FakeWellness:
    def __init__(self, wear=WEARABLE, sleep="", quota=False):
        self.wear, self.sleep, self.quota, self.calls = wear, sleep, quota, []

    def list_wearable_data(self, s, e):
        self.calls.append("wearable")
        return QUOTA if self.quota else self.wear

    def list_sleep(self, s, e):
        self.calls.append("sleep")
        return QUOTA if self.quota else self.sleep


class FakeHalseth:
    def __init__(self, rows=None):
        self.rows, self.puts = rows or [], {}

    def wellness_rows(self, limit=30):
        return self.rows

    def put_day(self, day, body):
        self.puts[day] = body


NOW = datetime(2026, 11, 1, 22, 0, tzinfo=timezone.utc)  # 16:00 CST Sunday


class Run(unittest.TestCase):
    def setUp(self):
        self.sent, self.state = [], {}
        self.notify = lambda t: self.sent.append(t) or True

    def run_once(self, w, h, now=NOW, **kw):
        return wc.run_once(w, h, self.state, now, self.notify, log=lambda *_: None, **kw)

    def test_afternoon_run_is_one_read_and_morning_is_two(self):
        w = FakeWellness()
        self.run_once(w, FakeHalseth())
        self.assertEqual(w.calls, ["wearable"])
        w2 = FakeWellness()
        self.run_once(w2, FakeHalseth(), now=datetime(2026, 11, 2, 13, 30, tzinfo=timezone.utc))
        self.assertEqual(w2.calls, ["wearable", "sleep"])

    def test_writes_rows_without_a_score_on_cold_start(self):
        h = FakeHalseth()
        self.assertEqual(self.run_once(FakeWellness(), h), "ok")
        self.assertEqual(sorted(h.puts), ["2026-10-31", "2026-11-01"])
        self.assertNotIn("stress_score", h.puts["2026-11-01"])  # no baseline yet: absent, not zero
        self.assertEqual(h.puts["2026-10-31"]["recorded_at"], "2026-11-01T04:59:59.000Z")
        self.assertEqual(self.sent, [])

    def test_score_rides_the_baseline_from_halseth(self):
        rows = [{"id": "wellness_2026-10-%02d" % d, "hrv_resting": 60.0, "resting_hr": 50} for d in range(10, 25)]
        h = FakeHalseth(rows)
        self.run_once(FakeWellness(), h)
        self.assertGreaterEqual(h.puts["2026-11-01"]["stress_score"], 65)  # 41 vs baseline 60, 58 vs 50

    def test_quota_is_quiet_about_the_phone_and_alerts_at_most_weekly(self):
        h = FakeHalseth()
        self.assertEqual(self.run_once(FakeWellness(quota=True), h), "quota")
        self.assertEqual(h.puts, {})
        self.assertEqual(self.sent, [wc.QUOTA_TEXT])
        self.run_once(FakeWellness(quota=True), h)
        self.assertEqual(len(self.sent), 1)

    def test_stale_nudge_once_per_cooldown_with_no_counts_or_blame(self):
        old = json.dumps({"result": "2026-10-25: 5000 steps, HRV 40.0 ms, Primary RHR 60 bpm"})
        self.assertEqual(self.run_once(FakeWellness(wear=old), FakeHalseth()), "stale")
        self.assertEqual(self.sent, [wc.STALE_TEXT])
        self.assertEqual(self.run_once(FakeWellness(wear=old), FakeHalseth()), "ok")
        self.assertEqual(len(self.sent), 1)
        for bad in ("log", "forgot", "streak", "missed", "days in a row", "should"):
            self.assertNotIn(bad, wc.STALE_TEXT.lower())
        self.assertFalse(any(ch.isdigit() for ch in wc.STALE_TEXT))
        self.assertNotIn("—", wc.STALE_TEXT + wc.AUTH_TEXT + wc.QUOTA_TEXT)

    def test_a_plan_limit_gap_never_sends_him_to_the_app(self):
        self.state["last_quota_at"] = NOW.timestamp() - 3600
        old = json.dumps({"result": "2026-10-25: 5000 steps, HRV 40.0 ms, Primary RHR 60 bpm"})
        self.assertEqual(self.run_once(FakeWellness(wear=old), FakeHalseth()), "ok")
        self.assertEqual(self.sent, [])

    def test_fresh_data_sends_nothing(self):
        self.run_once(FakeWellness(), FakeHalseth())
        self.assertEqual(self.sent, [])


class State(unittest.TestCase):
    def test_corrupt_state_heals_and_tokens_are_private(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.json")
        open(p, "w").write("")
        self.assertEqual(wc.load_state(p), {})
        wc.save_state(p, {"a": 1})
        self.assertEqual(wc.load_state(p), {"a": 1})
        t = os.path.join(d, "t.json")
        wc.write_tokens(t, {"access_token": "x"})
        if os.name != "nt":
            self.assertEqual(os.stat(t).st_mode & 0o777, 0o600)

    def test_cooldown_helper(self):
        self.assertTrue(wc.due({}, "k", 24, 1000.0))
        self.assertFalse(wc.due({"k": 1000.0}, "k", 24, 1000.0 + 3600))
        self.assertTrue(wc.due({"k": 1000.0}, "k", 24, 1000.0 + 25 * 3600))


if __name__ == "__main__":
    unittest.main()
