#!/usr/bin/env python3
"""Script-bleed read-out from a Hermes profile's state.db (VPS). COUNTS ONLY, never model text.

The metric behind the 2026-10-22 GLM 5.3 Flash decision (STATUS.md): per model and per day, how
many of a companion's stored replies carry letters of a script outside Latin (Han, Kana, Hangul,
Tibetan, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari), plus the shape of each run (length,
position in the reply, glued inside a word or not). Baseline to read against: Drevan on GLM at
provider-default sampling, 10-10/10-11: 3 of 67 replies; 10-23 before the fix: 2 of 2.

    python3 ops/script-bleed-report.py                 # drevan, last 14 days
    python3 ops/script-bleed-report.py --profile gaia --days 30

Opens the db read-only (the hot WAL is 2 GB; never copy it to /tmp). Scripts a USER turn in the
same session carries are not exempted here (the live guard exempts them per turn); a quoted
Japanese title will count. Read runs, not just totals.
"""
import argparse
import collections
import datetime as dt
import os
import re
import sqlite3
import unicodedata

NONLATIN = re.compile(
    r"[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿ༀ-࿿"
    r"぀-ヿ㐀-鿿가-힯]"
)
RUN = re.compile(
    r"[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿ༀ-࿿"
    r"぀-ヿ㐀-鿿가-힯]+"
)


def script_of(ch: str) -> str:
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "?"
    for s in ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "TIBETAN", "CYRILLIC", "GREEK", "ARABIC", "HEBREW", "THAI", "DEVANAGARI"):
        if s in name:
            return s
    return "OTHER"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="drevan")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--runs", action="store_true", help="print one line per non-Latin run (shape only)")
    a = ap.parse_args()
    db = os.path.expanduser(f"~/.hermes/profiles/{a.profile}/state.db")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    since = dt.datetime.now(dt.timezone.utc).timestamp() - a.days * 86400
    rows = con.execute(
        """select s.model, m.content, m.timestamp, m.finish_reason
           from messages m join sessions s on s.id = m.session_id
           where m.role = 'assistant' and m.timestamp > ? and m.content is not null and m.tool_calls is null
           order by m.timestamp""",
        (since,),
    ).fetchall()
    by = collections.defaultdict(lambda: [0, 0, 0])  # (model, day) -> [replies, bleeding replies, chars]
    scripts = collections.defaultdict(collections.Counter)
    runs = []
    for model, c, ts, fr in rows:
        day = dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%m-%d")
        short = model.split("/")[-1] if model else "?"
        hits = NONLATIN.findall(c)
        k = (short, day)
        by[k][0] += 1
        if hits:
            by[k][1] += 1
            by[k][2] += len(hits)
            for ch in hits:
                scripts[short][script_of(ch)] += 1
            for m in RUN.finditer(c):
                before = c[m.start() - 1] if m.start() > 0 else " "
                after = c[m.end()] if m.end() < len(c) else " "
                runs.append((short, day, len(m.group(0)), round(m.start() / max(1, len(c)), 2), before.isalpha() or after.isalpha(), fr))
    print(f"profile={a.profile} days={a.days} replies={len(rows)}")
    print("model | day | replies | bleeding | chars")
    for (model, day), (n, b, ch) in sorted(by.items(), key=lambda x: (x[0][1], x[0][0])):
        print(f"{model} | {day} | {n} | {b} | {ch}")
    print()
    tot = collections.defaultdict(lambda: [0, 0])
    for (model, _), (n, b, _) in by.items():
        tot[model][0] += n
        tot[model][1] += b
    for model, (n, b) in tot.items():
        print(f"{model}: {b}/{n} replies bleeding ({100.0 * b / max(1, n):.1f}%) scripts={dict(scripts[model])}")
    if a.runs and runs:
        print("\nruns: model | day | run_len | pos | glued_in_word | finish")
        for r in runs:
            print(" | ".join(str(x) for x in r))


if __name__ == "__main__":
    main()
