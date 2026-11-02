"""Wellness bridge core (B8, 2026-11-01): pure functions plus the small I/O seams.

Why this exists: Raziel has OCD, and reading his own watch numbers and typing them into Hearth is
the compulsion surface. This bridge pulls the wearable data out of the Wellness Project MCP on a
timer and writes it into Halseth so the care loop can speak when it matters and he never has to
look. Everything here is built so it does NOT invite checking: no streaks, counts, rates or scores
are ever shown back to him (care rule R-5), and no message frames a gap as something he failed to
log.

Layout (all stdlib, matching ops/health-check.py):
  * parsing        parse_wearable / parse_sleep / QuotaExhausted      pure
  * scoring        stress_score / baseline                            pure (THE one place the score exists)
  * time           day_recorded_at / local_today                      pure given a clock
  * WellnessClient the ONLY module-level thing that touches wellnessproject.ai (fake in tests)
  * HalsethClient  GET/PUT /biometrics (source 'wellness')
  * run_once       orchestration, with every collaborator injected

Never print a token or a secret. Not even masked.
"""

import json
import os
import re
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

TZ_NAME = "America/Chicago"  # DST-aware zone, never a fixed offset (Raziel 2026-11-01)

MCP_URL = "https://wellnessproject.ai/api/mcp"
AUTH_META_URL = "https://wellnessproject.ai/.well-known/oauth-authorization-server"
UA = "nullsafe-wellness-bridge/1.0 (+ops/wellness_core.py)"
HTTP_TIMEOUT = 30

# --- the stress score: ONE definition ------------------------------------------------------
# 0-100 body load vs HIS OWN trailing 30-day baseline (median of prior days). Readable on purpose:
# every number below is a line Raziel can read and move; halseth/src/care/rules.ts only thresholds
# the stored result (STRESS_ELEVATED_MIN = 65) and mirrors none of this arithmetic.
#   HRV:   30% under baseline = the full 50 points (linear below that)
#   RHR:   12 bpm over baseline = the full 35 points
#   sleep: 3h under SLEEP_TARGET_H = the full 15 points (optional; absent sleep adds nothing)
# HRV and RHR BOTH have to be present with a baseline, otherwise the score is None: an unreadable
# day is absent, never zero and never high.
W_HRV, HRV_FULL_DROP = 50.0, 0.30
W_RHR, RHR_FULL_RISE = 35.0, 12.0
W_SLEEP, SLEEP_FULL_DEFICIT_H, SLEEP_TARGET_H = 15.0, 3.0, 7.0
BASELINE_DAYS = 30
BASELINE_MIN_SAMPLES = 7

STALE_HOURS = 48           # newest wearable day older than this -> one nudge
STALE_COOLDOWN_H = 24
ALERT_COOLDOWN_H = 24      # auth failure line
QUOTA_COOLDOWN_H = 24 * 7  # the "free plan limit" line is at most weekly
QUOTA_SUPPRESS_STALE_H = 36

STALE_TEXT = ("Watch data from the Wellness app has not come through in a couple of days. "
              "Opening the app once usually restarts it. Nothing else is needed.")
AUTH_TEXT = ("The Wellness bridge lost its sign-in and has stopped pulling. "
             "Re-run ops/wellness-auth.py on the workstation and copy the token file over.")
QUOTA_TEXT = ("The Wellness bridge hit the free plan's daily read limit, so it could not pull. "
              "The bridge needs the Pro plan to run on its own schedule.")


class QuotaExhausted(Exception):
    """The Wellness plan's daily analysis-interaction limit was hit (free plan: 3 reads a day)."""


class AuthFailed(Exception):
    pass


# --- parsing --------------------------------------------------------------------------------

def _num(s):
    return float(s.replace(",", ""))


def unwrap(text):
    """MCP text content is either the bare string or a JSON object {"result": "..."}."""
    if text is None:
        return ""
    t = text.strip()
    if t.startswith("{"):
        try:
            obj = json.loads(t)
            if isinstance(obj, dict) and isinstance(obj.get("result"), str):
                return obj["result"]
        except Exception:
            pass
    return text


def check_quota(text):
    if re.search(r"free analysis interaction|analysis interactions? for today|upgrade to Pro", text or "", re.I):
        raise QuotaExhausted(text[:120])


_DAY_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2}):\s*(.*)$")


def parse_wearable(text):
    """-> {day: {steps, resting_hr, hrv_resting, active_energy}} for every dated line with any metric.

    Resting HR preference: the provider's Primary RHR, else the estimated sleeping RHR, else daytime.
    'Overnight minimum HR' is NOT a resting HR and is never used."""
    text = unwrap(text)
    check_quota(text)
    out = {}
    for line in text.splitlines():
        m = _DAY_LINE.match(line.strip())
        if not m:
            continue
        day, body = m.group(1), m.group(2)
        row = {}
        s = re.search(r"([\d,]+)\s+steps", body)
        if s:
            row["steps"] = int(_num(s.group(1)))
        for pat in (r"Primary RHR\s+(\d+(?:\.\d+)?)\s*bpm",
                    r"Sleeping resting HR(?:\s*\(estimated\))?\s+(\d+(?:\.\d+)?)\s*bpm",
                    r"Daytime resting HR\s+(\d+(?:\.\d+)?)\s*bpm"):
            r = re.search(pat, body)
            if r:
                row["resting_hr"] = int(round(float(r.group(1))))
                break
        h = re.search(r"\bHRV\s+(\d+(?:\.\d+)?)\s*ms", body)
        if h:
            row["hrv_resting"] = float(h.group(1))
        a = re.search(r"\(([\d,]+)\s+active", body)
        if a:
            row["active_energy"] = _num(a.group(1))
        if row:
            out[day] = row
    return out


_SLEEP_HM = re.compile(r"(\d{1,2})\s*h(?:ours?|rs?)?\s*(?:(\d{1,2})\s*m(?:in(?:utes?)?)?)?", re.I)
_SLEEP_DEC = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*(?:hours|hrs|hr)\b", re.I)


def parse_sleep(text):
    """-> {day: hours} for overnight sleep. The list_sleep output shape is not verified against the live
    server (the free-plan limit blocked the format capture on 2026-11-01), so this accepts the common
    shapes (`7h 12m`, `7.2 hours`) on a dated line and skips naps. Anything it cannot read is simply
    absent: the stress score treats missing sleep as no contribution, never as a deficit."""
    text = unwrap(text)
    check_quota(text)
    out = {}
    for line in text.splitlines():
        m = re.search(r"(\d{4}-\d{2}-\d{2})", line)
        if not m or re.search(r"\bnaps?\b", line, re.I):
            continue
        body = line[m.end():]
        hours = None
        d = _SLEEP_DEC.search(body)
        if d:
            hours = float(d.group(1))
        else:
            hm = _SLEEP_HM.search(body)
            if hm:
                hours = int(hm.group(1)) + (int(hm.group(2)) / 60.0 if hm.group(2) else 0.0)
        if hours is not None and 0 < hours <= 24:
            out[m.group(1)] = round(hours, 2)
    return out


# --- scoring ----------------------------------------------------------------------------------

def baseline(values):
    """Median of the trailing samples, or None below BASELINE_MIN_SAMPLES (cold start never guesses)."""
    vals = [v for v in values if v is not None]
    if len(vals) < BASELINE_MIN_SAMPLES:
        return None
    return statistics.median(vals)


def _clamp01(x):
    return max(0.0, min(1.0, x))


def stress_score(hrv, rhr, sleep_hours, base_hrv, base_rhr):
    """0-100 or None. See the block comment above for the arithmetic."""
    if hrv is None or rhr is None or not base_hrv or base_rhr is None:
        return None
    hrv_drop = (base_hrv - hrv) / base_hrv
    pts = W_HRV * _clamp01(hrv_drop / HRV_FULL_DROP)
    pts += W_RHR * _clamp01((rhr - base_rhr) / RHR_FULL_RISE)
    if sleep_hours is not None:
        pts += W_SLEEP * _clamp01((SLEEP_TARGET_H - sleep_hours) / SLEEP_FULL_DEFICIT_H)
    return int(round(pts))


def baselines_for(day, history):
    """history: {day: {hrv_resting, resting_hr}} of PRIOR wellness rows. Trailing BASELINE_DAYS before `day`."""
    d0 = date.fromisoformat(day)
    lo = d0 - timedelta(days=BASELINE_DAYS)
    hrv, rhr = [], []
    for k, r in history.items():
        dk = date.fromisoformat(k)
        if lo <= dk < d0:
            hrv.append(r.get("hrv_resting"))
            rhr.append(r.get("resting_hr"))
    return baseline(hrv), baseline(rhr)


# --- time -----------------------------------------------------------------------------------------

def _tz():
    if ZoneInfo is None:
        raise RuntimeError("zoneinfo unavailable")
    return ZoneInfo(TZ_NAME)


def local_now(now=None):
    now = now or datetime.now(timezone.utc)
    return now.astimezone(_tz())


def local_today(now=None):
    return local_now(now).date()


def day_recorded_at(day, now=None):
    """The data timestamp for a wearable day: the END of that local day, capped at the fetch time. So the
    stress rule's freshness reads the age of the DATA. A stalled watch (old newest day) goes stale even
    though the bridge keeps running."""
    now = now or datetime.now(timezone.utc)
    d = date.fromisoformat(day)
    end_local = datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=_tz())
    return min(end_local.astimezone(timezone.utc), now).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def is_morning_run(now=None):
    return local_now(now).hour < 12


# --- state (cooldowns) ------------------------------------------------------------------------------

def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            s = json.load(fh)
            return s if isinstance(s, dict) else {}
    except Exception:
        return {}  # missing OR corrupt heals to empty (the 08-07 throttle lesson)


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)


def _hours_since(state, key, now_ts):
    v = state.get(key)
    return None if v is None else (now_ts - v) / 3600.0


def due(state, key, cooldown_h, now_ts):
    h = _hours_since(state, key, now_ts)
    return h is None or h >= cooldown_h


# --- I/O seams ------------------------------------------------------------------------------------

def read_env(path):
    out = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


def telegram(text, hermes_env):
    """Same route as ops/health-check.py: bot token + home channel from the Hermes env. Never printed."""
    tok = hermes_env.get("TELEGRAM_BOT_TOKEN")
    chat = hermes_env.get("TELEGRAM_HOME_CHANNEL")
    if not tok or not chat:
        return False
    try:
        body = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        with urllib.request.urlopen("https://api.telegram.org/bot%s/sendMessage" % tok, data=body, timeout=20) as r:
            return bool(json.loads(r.read().decode()).get("ok", False))
    except Exception:
        return False


def _json_req(url, method="GET", body=None, headers=None, form=False):
    h = {"User-Agent": UA}
    h.update(headers or {})
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        raw = r.read().decode()
        return r.status, dict(r.headers), raw


def read_tokens(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_tokens(path, tok):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(tok, fh)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def refresh_tokens(tok, now_ts=None):
    """Public-client refresh grant. Returns the new token dict. Raises AuthFailed on any failure."""
    now_ts = now_ts or time.time()
    try:
        _s, _h, raw = _json_req(tok["token_endpoint"], "POST", {
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
            "client_id": tok["client_id"],
        }, form=True)
        r = json.loads(raw)
        new = dict(tok)
        new["access_token"] = r["access_token"]
        if r.get("refresh_token"):
            new["refresh_token"] = r["refresh_token"]  # rotated
        new["expires_at"] = now_ts + int(r.get("expires_in", 3600))
        return new
    except Exception as e:
        raise AuthFailed(type(e).__name__)


def _sse_or_json(raw, ctype):
    if "text/event-stream" in (ctype or ""):
        last = None
        for line in raw.splitlines():
            if line.startswith("data:"):
                last = line[5:].strip()
        return json.loads(last) if last else {}
    return json.loads(raw)


class WellnessClient:
    """The only code that talks to wellnessproject.ai. One JSON-RPC POST per call (Streamable HTTP)."""

    def __init__(self, access_token):
        self.token = access_token
        self.session = None
        self._id = 0
        self._inited = False

    def _post(self, payload):
        h = {"Authorization": "Bearer " + self.token, "Accept": "application/json, text/event-stream"}
        if self.session:
            h["Mcp-Session-Id"] = self.session
        try:
            _s, hd, raw = _json_req(MCP_URL, "POST", payload, h)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise AuthFailed("http %d" % e.code)
            raise
        for k, v in hd.items():
            if k.lower() == "mcp-session-id":
                self.session = v
        ctype = next((v for k, v in hd.items() if k.lower() == "content-type"), "")
        return _sse_or_json(raw, ctype) if raw.strip() else {}

    def _init(self):
        if self._inited:
            return
        self._id += 1
        self._post({"jsonrpc": "2.0", "id": self._id, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "nullsafe-wellness-bridge", "version": "1.0"}}})
        try:
            self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            pass
        self._inited = True

    def call(self, tool, arguments):
        self._init()
        self._id += 1
        r = self._post({"jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                        "params": {"name": tool, "arguments": arguments}})
        if "error" in r:
            raise RuntimeError("mcp error %s" % str(r["error"].get("code")))
        content = (r.get("result") or {}).get("content") or []
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict))

    def list_wearable_data(self, start, end):
        return self.call("list_wearable_data", {"start_date": start, "end_date": end})

    def list_sleep(self, start, end):
        return self.call("list_sleep", {"start_date": start, "end_date": end})


class HalsethClient:
    def __init__(self, url, secret):
        self.url = url.rstrip("/")
        self.h = {"Authorization": "Bearer " + secret}

    def wellness_rows(self, limit=30):
        _s, _h, raw = _json_req("%s/biometrics?source=wellness&limit=%d" % (self.url, limit), "GET", None, self.h)
        return json.loads(raw)

    def put_day(self, day, body):
        _json_req("%s/biometrics/wellness/%s" % (self.url, day), "PUT", body, self.h)


# --- orchestration ---------------------------------------------------------------------------------

def _history_from_rows(rows):
    h = {}
    for r in rows:
        rid = r.get("id") or ""
        if rid.startswith("wellness_"):
            h[rid[len("wellness_"):]] = {"hrv_resting": r.get("hrv_resting"), "resting_hr": r.get("resting_hr")}
    return h


def build_day_payloads(wear, sleep, history, now):
    """Chronological so a backfill's later days see the earlier ones in their baseline. -> [(day, body)]."""
    hist = dict(history)
    out = []
    for day in sorted(wear):
        w = wear[day]
        b_hrv, b_rhr = baselines_for(day, hist)
        sc = stress_score(w.get("hrv_resting"), w.get("resting_hr"), sleep.get(day), b_hrv, b_rhr)
        body = dict(w)
        if day in sleep:
            body["sleep_hours"] = sleep[day]
        if sc is not None:
            body["stress_score"] = sc
        body["recorded_at"] = day_recorded_at(day, now)
        out.append((day, body))
        hist[day] = {"hrv_resting": w.get("hrv_resting"), "resting_hr": w.get("resting_hr")}
    return out


def run_once(wellness, halseth, state, now, notify, with_sleep=None, start=None, log=print):
    """One bridge run. Never raises for an expected condition; returns a status string.

    wellness: object with list_wearable_data/list_sleep.  halseth: wellness_rows/put_day.
    notify(text) -> bool sends the Telegram line.  state is mutated (cooldown stamps)."""
    now_ts = now.timestamp()
    today = local_today(now)
    start = start or (today - timedelta(days=2)).isoformat()
    end = today.isoformat()
    if with_sleep is None:
        with_sleep = is_morning_run(now)  # the free plan allows 3 reads a day: sleep rides the morning run only

    try:
        wear = parse_wearable(wellness.list_wearable_data(start, end))
        sleep = parse_sleep(wellness.list_sleep(start, end)) if with_sleep else {}
    except QuotaExhausted:
        state["last_quota_at"] = now_ts
        log("wellness-bridge: plan read limit reached; nothing pulled")
        if due(state, "quota_alert_at", QUOTA_COOLDOWN_H, now_ts) and notify(QUOTA_TEXT):
            state["quota_alert_at"] = now_ts
        return "quota"

    try:
        rows = halseth.wellness_rows(30)
    except Exception:
        rows = []
    history = _history_from_rows(rows)

    payloads = build_day_payloads(wear, sleep, history, now)
    for day, body in payloads:
        halseth.put_day(day, body)
    log("wellness-bridge: wrote %d day row(s)" % len(payloads))

    # Staleness: the newest wearable day we know of, from this fetch or (fetch empty) what Halseth holds.
    newest = max(wear) if wear else (max(history) if history else None)
    if newest is None:
        return "ok"
    age_h = (now - datetime.fromisoformat(day_recorded_at(newest, now).replace("Z", "+00:00"))).total_seconds() / 3600.0
    if age_h > STALE_HOURS:
        recent_quota = _hours_since(state, "last_quota_at", now_ts)
        if recent_quota is not None and recent_quota < QUOTA_SUPPRESS_STALE_H:
            return "ok"  # the gap is the plan limit, not the phone: do not send him to the app
        if due(state, "stale_nudge_at", STALE_COOLDOWN_H, now_ts) and notify(STALE_TEXT):
            state["stale_nudge_at"] = now_ts
            return "stale"
    return "ok"
