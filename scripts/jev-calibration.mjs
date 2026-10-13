#!/usr/bin/env node
/**
 * Standing calibration for the Jev writeback gate (BBH docs/PLAN-from-review-2026-09-20.md T5,
 * "Standing calibration, not a one-shot gate"; P5).
 *
 * The gate was measured once (AUROC / ECE on the 09-21 labels) to decide whether to ship. A judge
 * measured once can drift silently afterwards. This reads jev-shadow.jsonl on a cadence and answers,
 * per companion, over the last N days:
 *   - write rate: Jev (worth >= live theta) vs the legacy judge
 *   - agreement matrix at the live theta (both-write / jev-only / judge-only / both-skip)
 *   - salience / promote-to-WM rate
 *   - error + fallback rate (Jev unreachable, fell back to the legacy judge)
 *   - drift of Jev's `worth` distribution vs a stored baseline (KS distance + write-rate shift)
 *   - with --labels: precision / recall / AUROC against Raziel's labels, and the theta that
 *     maximises agreement
 * and emits warnings (machine-readable) that ops/health-check.py surfaces through its existing
 * Telegram path (check_jev_calibration). It never contacts Halseth, Discord, or Jev, and never
 * prints message text (the shadow log carries ids and numbers only).
 *
 * USAGE (VPS):
 *   node scripts/jev-calibration.mjs --json /app/logs/jev-calibration.json
 *   node scripts/jev-calibration.mjs --days 14 --labels labels.json --save-baseline
 *
 * FLAGS
 *   --file PATH          shadow log (default $JEV_SHADOW_LOG or /app/logs/jev-shadow.jsonl)
 *   --days N             window (default 7)
 *   --theta cypher=0.7,drevan=0.7,gaia=0.6   live thetas (default those; or JEV_WRITEBACK_THETA[_<C>] env)
 *   --notable 2.0        promote threshold on salience (default $JEV_NOTABLE_SCORE or 2.0)
 *   --baseline PATH      baseline file (default <json dir>/jev-calibration-baseline.json, or ./)
 *   --save-baseline      overwrite the baseline with the current window
 *   --labels PATH        labels: JSON array/object or JSONL; rows {message_id|id, label} or {id: label};
 *                        KEEP/WRITE/YES/1 are positive; SKIP/DRIFT/NO/0 negative; anything else ignored
 *   --json PATH          write the machine-readable report here
 *   --warn-write-shift 10   percentage points of Jev write-rate shift vs baseline that warns
 *   --warn-fallback 5       fallback/error rate (percent) that warns
 *   --warn-ks 0.25          KS distance on worth vs baseline that warns
 *   --min-rows 30           rows needed before a rate-based warning may fire
 *
 * The first run with no baseline writes one (a `notice`); re-baseline deliberately with
 * --save-baseline after an accepted change (a theta move, a Jev prompt change).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPANIONS = ["cypher", "drevan", "gaia"];
const DEFAULT_THETA = { cypher: 0.7, drevan: 0.7, gaia: 0.6 };
const HIST_BINS = 20;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function parseThetas(spec, env = {}) {
  const base = Number(env.JEV_WRITEBACK_THETA);
  const out = {};
  for (const c of COMPANIONS) {
    const e = Number(env[`JEV_WRITEBACK_THETA_${c.toUpperCase()}`]);
    out[c] = Number.isFinite(e) && env[`JEV_WRITEBACK_THETA_${c.toUpperCase()}`] !== undefined ? e
      : Number.isFinite(base) && env.JEV_WRITEBACK_THETA !== undefined ? base : DEFAULT_THETA[c];
  }
  for (const part of String(spec ?? "").split(",")) {
    const [k, v] = part.split("=");
    if (k && Number.isFinite(Number(v))) out[k.trim().toLowerCase()] = Number(v);
  }
  return out;
}

export function parseRows(text, sinceMs = 0) {
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (sinceMs && !(Date.parse(r.ts) >= sinceMs)) continue;
      rows.push(r);
    } catch { bad++; }
  }
  return { rows, bad };
}

export function auroc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function quantile(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(p * (a.length - 1))];
}

export function histogram(vals, bins = HIST_BINS) {
  const h = new Array(bins).fill(0);
  for (const v of vals) h[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  return h;
}

/** KS distance between two histograms over the same bins (max CDF gap). */
export function ksFromHist(a, b) {
  const sa = a.reduce((x, y) => x + y, 0), sb = b.reduce((x, y) => x + y, 0);
  if (!sa || !sb) return null;
  let ca = 0, cb = 0, d = 0;
  for (let i = 0; i < a.length; i++) { ca += a[i] / sa; cb += b[i] / sb; d = Math.max(d, Math.abs(ca - cb)); }
  return d;
}

export function parseLabels(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    data = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (data && !Array.isArray(data) && typeof data === "object") {
    data = Array.isArray(data.rows) ? data.rows : Object.entries(data).map(([id, label]) => ({ id, label }));
  }
  const POS = new Set(["keep", "write", "yes", "true", "1"]);
  const NEG = new Set(["skip", "drift", "no", "false", "0"]);
  const out = new Map();
  for (const r of data ?? []) {
    const id = String(r.message_id ?? r.id ?? "");
    const lab = String(r.label ?? "").trim().toLowerCase();
    if (!id) continue;
    if (POS.has(lab)) out.set(id, 1);
    else if (NEG.has(lab)) out.set(id, 0);
  }
  return out;
}

/** The theta (over observed worths) that maximises accuracy vs labels; ties go nearest the live theta. */
export function bestTheta(pairs, live) {
  const cands = [...new Set(pairs.map((p) => p.worth))].sort((a, b) => a - b);
  let best = null;
  for (const t of cands) {
    const acc = pairs.filter((p) => (p.worth >= t ? 1 : 0) === p.y).length / pairs.length;
    if (!best || acc > best.acc + 1e-12 || (Math.abs(acc - best.acc) <= 1e-12 && Math.abs(t - live) < Math.abs(best.theta - live))) best = { theta: t, acc };
  }
  return best;
}

export function analyseCompanion(c, rows, theta, notable, baseline, labels, opts, nowMs = Date.now()) {
  const n = rows.length;
  // A 7-day window dilutes a fresh outage and holds a fixed one for a week; the last 24h answers "is it down NOW".
  const recent = rows.filter((r) => Date.parse(r.ts) >= nowMs - 86_400_000);
  const ok = rows.filter((r) => r.jev_ok && Number.isFinite(r.worth));
  const failed = rows.filter((r) => !r.jev_ok);
  const fallback = rows.filter((r) => r.fallback);
  const jevWrite = (r) => r.worth >= theta;
  const out = {
    companion: c, rows: n, jev_ok: ok.length, theta,
    error_rate: n ? failed.length / n : null,
    rows_24h: recent.length,
    error_rate_24h: recent.length ? recent.filter((r) => !r.jev_ok).length / recent.length : null,
    fallback_rate: n ? fallback.length / n : null,
    reasons: {},
    jev_write_rate: ok.length ? ok.filter(jevWrite).length / ok.length : null,
    promote_rate: ok.length ? ok.filter((r) => Number(r.salience) >= notable).length / ok.length : null,
    worth_q: { p10: quantile(ok.map((r) => r.worth), 0.1), p50: quantile(ok.map((r) => r.worth), 0.5), p90: quantile(ok.map((r) => r.worth), 0.9) },
    worth_hist: histogram(ok.map((r) => r.worth)),
  };
  for (const r of failed) out.reasons[String(r.reason ?? "unknown").slice(0, 40)] = (out.reasons[String(r.reason ?? "unknown").slice(0, 40)] ?? 0) + 1;

  // Legacy judge: present on shadow rows (`judge`); live-mode rows carry `decided` only after a fallback.
  const withJudge = ok.filter((r) => typeof r.judge === "string");
  const m = { both_write: 0, jev_only: 0, judge_only: 0, both_skip: 0 };
  for (const r of withJudge) {
    const j = r.judge !== "skip", v = jevWrite(r);
    m[j && v ? "both_write" : v ? "jev_only" : j ? "judge_only" : "both_skip"]++;
  }
  out.legacy = {
    rows_with_judge: withJudge.length,
    judge_write_rate: withJudge.length ? withJudge.filter((r) => r.judge !== "skip").length / withJudge.length : null,
    jev_write_rate_same_rows: withJudge.length ? withJudge.filter(jevWrite).length / withJudge.length : null,
    matrix: m,
    agreement: withJudge.length ? (m.both_write + m.both_skip) / withJudge.length : null,
  };

  const base = baseline?.[c];
  if (base && ok.length) {
    out.drift = {
      baseline_n: base.rows_ok, baseline_write_rate: base.jev_write_rate,
      write_rate_shift_pts: base.jev_write_rate == null ? null : 100 * (out.jev_write_rate - base.jev_write_rate),
      ks_worth: ksFromHist(out.worth_hist, base.worth_hist),
    };
  }

  if (labels && labels.size) {
    const pairs = ok.filter((r) => labels.has(String(r.message_id))).map((r) => ({ worth: r.worth, y: labels.get(String(r.message_id)) }));
    if (pairs.length) {
      const tp = pairs.filter((p) => p.worth >= theta && p.y).length;
      const fp = pairs.filter((p) => p.worth >= theta && !p.y).length;
      const fn = pairs.filter((p) => p.worth < theta && p.y).length;
      out.labels = {
        n: pairs.length, positives: pairs.filter((p) => p.y).length,
        precision: tp + fp ? tp / (tp + fp) : null,
        recall: tp + fn ? tp / (tp + fn) : null,
        auroc: auroc(pairs.filter((p) => p.y).map((p) => p.worth), pairs.filter((p) => !p.y).map((p) => p.worth)),
        accuracy_at_live_theta: pairs.filter((p) => (p.worth >= theta ? 1 : 0) === p.y).length / pairs.length,
        best: bestTheta(pairs, theta),
      };
    }
  }

  out.warnings = [];
  const w = (name, severity, detail) => out.warnings.push({ name, severity, detail });
  if (recent.length >= 10 && out.error_rate_24h > opts.warnFallback / 100) {
    w("error_rate_24h", "warning", `${(100 * out.error_rate_24h).toFixed(0)}% of the last ${recent.length} rows (24h) had Jev unavailable (limit ${opts.warnFallback}%)`);
  }
  // A 7-day rate keeps a FIXED outage loud for a week (the 10-08..10-11 401s on the first run): when the
  // last 24h has enough rows and is under the limit, the 7-day breach is history, logged as a notice.
  const recovered = recent.length >= 5 && out.error_rate_24h != null && out.error_rate_24h <= opts.warnFallback / 100;
  const sev7d = recovered ? "notice" : "warning";
  const tail7d = recovered ? `; recovered: ${(100 * out.error_rate_24h).toFixed(0)}% in the last ${recent.length} rows (24h)` : "";
  if (n >= opts.minRows && out.fallback_rate > opts.warnFallback / 100) {
    w("fallback_rate", sev7d, `${(100 * out.fallback_rate).toFixed(1)}% of ${n} rows fell back or errored (limit ${opts.warnFallback}%); reasons ${JSON.stringify(out.reasons)}${tail7d}`);
  } else if (n >= opts.minRows && out.error_rate > opts.warnFallback / 100) {
    w("error_rate", sev7d, `${(100 * out.error_rate).toFixed(1)}% of ${n} rows had Jev unavailable (limit ${opts.warnFallback}%); reasons ${JSON.stringify(out.reasons)}${tail7d}`);
  }
  if (out.drift && ok.length >= opts.minRows) {
    if (Math.abs(out.drift.write_rate_shift_pts) > opts.warnWriteShift) {
      w("write_rate_shift", "warning", `Jev write rate ${(100 * out.jev_write_rate).toFixed(0)}% vs baseline ${(100 * out.drift.baseline_write_rate).toFixed(0)}% (${out.drift.write_rate_shift_pts >= 0 ? "+" : ""}${out.drift.write_rate_shift_pts.toFixed(1)} pts, limit ${opts.warnWriteShift})`);
    }
    if (out.drift.ks_worth != null && out.drift.ks_worth > opts.warnKs) {
      w("worth_distribution_drift", "warning", `worth distribution KS ${out.drift.ks_worth.toFixed(2)} vs baseline (limit ${opts.warnKs})`);
    }
  }
  if (n === 0 && base) w("no_rows", "notice", "no shadow rows in the window for a companion that has a baseline");
  return out;
}

export function buildReport({ rows, thetas, notable, baseline, labels, days, opts, now = Date.now() }) {
  const companions = {};
  for (const c of COMPANIONS) {
    companions[c] = analyseCompanion(c, rows.filter((r) => r.companion === c), thetas[c], notable, baseline, labels, opts, now);
  }
  const warnings = [];
  for (const c of COMPANIONS) for (const x of companions[c].warnings) warnings.push({ companion: c, ...x });
  return { generated_at: new Date(now).toISOString(), window_days: days, rows: rows.length, thetas, thresholds: opts, companions, warnings };
}

export function baselineFrom(report) {
  const b = { saved_at: report.generated_at, window_days: report.window_days };
  for (const c of COMPANIONS) {
    const x = report.companions[c];
    if (x.jev_ok) b[c] = { rows_ok: x.jev_ok, jev_write_rate: x.jev_write_rate, worth_hist: x.worth_hist, theta: x.theta };
  }
  return b;
}

const pct = (x) => (x == null ? "n/a" : (100 * x).toFixed(0) + "%");
const f2 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));

export function renderReport(r) {
  const o = [`# Jev calibration  (${r.generated_at}, last ${r.window_days}d, ${r.rows} rows)`, ""];
  for (const c of COMPANIONS) {
    const x = r.companions[c];
    o.push(`## ${c}  theta ${x.theta}  rows ${x.rows}  jev_ok ${x.jev_ok}`);
    o.push(`write: jev ${pct(x.jev_write_rate)} | judge ${pct(x.legacy.judge_write_rate)} (jev ${pct(x.legacy.jev_write_rate_same_rows)} on the ${x.legacy.rows_with_judge} judged rows) | promote ${pct(x.promote_rate)}`);
    const m = x.legacy.matrix;
    o.push(`matrix: both-write ${m.both_write}  jev-only ${m.jev_only}  judge-only ${m.judge_only}  both-skip ${m.both_skip}  agreement ${pct(x.legacy.agreement)}`);
    o.push(`errors ${pct(x.error_rate)} (24h ${pct(x.error_rate_24h)})  fallback ${pct(x.fallback_rate)}  worth p10/p50/p90 ${f2(x.worth_q.p10)}/${f2(x.worth_q.p50)}/${f2(x.worth_q.p90)}`);
    if (x.drift) o.push(`drift vs baseline: write ${x.drift.write_rate_shift_pts == null ? "n/a" : x.drift.write_rate_shift_pts.toFixed(1)} pts, KS ${f2(x.drift.ks_worth)}`);
    if (x.labels) o.push(`labels n=${x.labels.n} (${x.labels.positives} keep): precision ${pct(x.labels.precision)} recall ${pct(x.labels.recall)} AUROC ${f2(x.labels.auroc)} acc@live ${pct(x.labels.accuracy_at_live_theta)}; best theta ${x.labels.best ? `${f2(x.labels.best.theta)} (acc ${pct(x.labels.best.acc)})` : "n/a"}`);
    o.push("");
  }
  o.push(r.warnings.length ? "WARNINGS" : "no warnings");
  for (const w of r.warnings) o.push(`- [${w.severity}] ${w.companion}:${w.name}: ${w.detail}`);
  return o.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const FILE = flag("--file", process.env.JEV_SHADOW_LOG ?? "/app/logs/jev-shadow.jsonl");
  const DAYS = Number(flag("--days", "7"));
  const JSON_OUT = flag("--json", "");
  const BASELINE = flag("--baseline", join(JSON_OUT ? dirname(JSON_OUT) : ".", "jev-calibration-baseline.json"));
  const opts = {
    warnWriteShift: Number(flag("--warn-write-shift", "10")),
    warnFallback: Number(flag("--warn-fallback", "5")),
    warnKs: Number(flag("--warn-ks", "0.25")),
    minRows: Number(flag("--min-rows", "30")),
  };
  if (!existsSync(FILE)) { console.error(`[jev-calibration] no such file: ${FILE}`); process.exit(1); }

  const { rows, bad } = parseRows(readFileSync(FILE, "utf8"), Date.now() - DAYS * 86_400_000);
  const thetas = parseThetas(flag("--theta", ""), process.env);
  const notable = Number(flag("--notable", process.env.JEV_NOTABLE_SCORE ?? "2.0"));
  const labelsPath = flag("--labels", "");
  const labels = labelsPath ? parseLabels(readFileSync(labelsPath, "utf8")) : null;
  let baseline = null;
  if (existsSync(BASELINE)) { try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { /* treated as absent */ } }

  const report = buildReport({ rows, thetas, notable, baseline, labels, days: DAYS, opts });
  if (bad) report.unparseable_lines = bad;

  if (argv.includes("--save-baseline") || !baseline) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify(baselineFrom(report), null, 2));
    if (!baseline) report.warnings.push({ companion: "all", name: "baseline_created", severity: "notice", detail: `no baseline existed; this window saved as ${BASELINE}` });
  }
  if (JSON_OUT) { mkdirSync(dirname(JSON_OUT), { recursive: true }); writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); }
  console.log(renderReport(report));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
