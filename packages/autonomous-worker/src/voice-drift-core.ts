// Voice drift loop, pure half (task 31648f0a, 2026-11-01). No config imports, no Halseth client:
// the baseline script (scripts/voice-baseline.mjs) and the nightly job both import this from dist.
//
// Data source is Halseth voice_scores rows (score, hit arrays, message_len; NEVER reply text).
// Per-marker values per row:
//   score, anti (count), contamination (count), positive (count), length (message_len)
//   swearing / hedging / bluntness  -- only from rows carrying the `mk:v1` tag (voice-markers.ts);
//   older rows were never measured and are EXCLUDED from those markers, not counted as zero.
//
// z-score = (window mean - baseline mean) / max(baseline sd, SD_FLOOR): an effect size against the
// baseline distribution of single replies, not a standard-error test. A standard-error z over a
// 24h window of ~50 replies calls any 0.02 wobble a 3-sigma event; this one only fires on a real
// shift of the window's average.
//
// Bias correction: until VOICE_SCORE_SAMPLE shipped at 1.0, only 10% of CLEAN rows were posted, so
// raw means over-represent dirty replies. Clean rows older than `fullSince` are weighted
// `cleanWeight` (default 10 = 1 / 0.1) in both baseline and windows. Pass fullSince = the deploy time.

export const MARKER_VERSION_TAG = "mk:v1";
const TAG_RE = /^mk:(swearing|hedging|bluntness)=(\d+)$/;

export const BASE_MARKERS = ["score", "anti", "contamination", "positive", "length"] as const;
export const TAGGED_MARKERS = ["swearing", "hedging", "bluntness"] as const;
export const ALL_MARKERS: readonly string[] = [...BASE_MARKERS, ...TAGGED_MARKERS];

export const SD_FLOOR = 0.1;
export const WARN_Z = 2;
export const MIN_BASELINE_N = 20;
export const MIN_WINDOW_N = 8;

export interface VoiceRow {
  score: number;
  positive_hits?: string[] | string | null;
  anti_hits?: string[] | string | null;
  contamination_hits?: string[] | string | null;
  message_len?: number | null;
  created_at: string;
}

export interface WeightOpts { cleanWeight: number; fullSince: string | null }
export interface MarkerStat { mean: number; sd: number; n: number }
export type Features = Record<string, number | undefined>;

function arr(v: string[] | string | null | undefined): string[] {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string");
  if (typeof v === "string" && v) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(x => typeof x === "string") : []; } catch { return []; }
  }
  return [];
}

/** D1 stores created_at as "YYYY-MM-DD HH:MM:SS" (UTC, no zone). */
export function rowTime(created_at: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(created_at) ? created_at : created_at.replace(" ", "T") + "Z";
  return Date.parse(iso);
}

export function rowFeatures(row: VoiceRow): Features {
  const pos = arr(row.positive_hits), anti = arr(row.anti_hits), con = arr(row.contamination_hits);
  const f: Features = {
    score: row.score, anti: anti.length, contamination: con.length,
    positive: pos.filter(h => !h.startsWith("mk:")).length,
    length: typeof row.message_len === "number" ? row.message_len : undefined,
  };
  if (pos.includes(MARKER_VERSION_TAG)) {
    for (const m of TAGGED_MARKERS) f[m] = 0;
    for (const h of pos) { const t = TAG_RE.exec(h); if (t) f[t[1]!] = parseInt(t[2]!, 10); }
  }
  return f;
}

export function rowWeight(row: VoiceRow, opts: WeightOpts): number {
  const clean = arr(row.anti_hits).length === 0 && arr(row.contamination_hits).length === 0;
  if (!clean) return 1;
  if (opts.fullSince === null) return opts.cleanWeight;
  return rowTime(row.created_at) < Date.parse(opts.fullSince) ? opts.cleanWeight : 1;
}

export function weightedStat(pairs: Array<{ v: number; w: number }>): MarkerStat | null {
  const W = pairs.reduce((a, p) => a + p.w, 0);
  if (pairs.length === 0 || W <= 0) return null;
  const mean = pairs.reduce((a, p) => a + p.v * p.w, 0) / W;
  const variance = pairs.reduce((a, p) => a + p.w * (p.v - mean) ** 2, 0) / W;
  return { mean, sd: Math.sqrt(variance), n: pairs.length };
}

export function markerStats(rows: VoiceRow[], opts: WeightOpts): Record<string, MarkerStat> {
  const out: Record<string, MarkerStat> = {};
  for (const m of ALL_MARKERS) {
    const pairs: Array<{ v: number; w: number }> = [];
    for (const r of rows) {
      const v = rowFeatures(r)[m];
      if (v !== undefined && Number.isFinite(v)) pairs.push({ v, w: rowWeight(r, opts) });
    }
    const s = weightedStat(pairs);
    if (s) out[m] = s;
  }
  return out;
}

export interface CompanionBaseline { rows: number; markers: Record<string, MarkerStat> }
export interface BaselineFile {
  version: 1;
  created_at: string;
  window: { from: string; to: string };
  clean_weight: number;
  full_since: string | null;
  companions: Record<string, CompanionBaseline>;
}

export function buildBaseline(
  byCompanion: Record<string, VoiceRow[]>,
  window: { from: string; to: string },
  opts: WeightOpts,
  now = new Date(),
): BaselineFile {
  const companions: Record<string, CompanionBaseline> = {};
  for (const [c, rows] of Object.entries(byCompanion)) {
    companions[c] = { rows: rows.length, markers: markerStats(rows, opts) };
  }
  return { version: 1, created_at: now.toISOString(), window, clean_weight: opts.cleanWeight, full_since: opts.fullSince, companions };
}

export interface WindowResult { n: number; z: Record<string, number> }

/** z per marker for one window. Markers with no baseline (or baseline n < MIN_BASELINE_N), or no
 *  window data, are omitted. Whole window skipped (z = {}) below MIN_WINDOW_N rows. */
export function windowZ(rows: VoiceRow[], baseline: CompanionBaseline | undefined, opts: WeightOpts): WindowResult {
  if (!baseline || rows.length < MIN_WINDOW_N) return { n: rows.length, z: {} };
  const stats = markerStats(rows, opts);
  const z: Record<string, number> = {};
  for (const m of ALL_MARKERS) {
    const b = baseline.markers[m], w = stats[m];
    if (!b || !w || b.n < MIN_BASELINE_N) continue;
    z[m] = (w.mean - b.mean) / Math.max(b.sd, SD_FLOOR);
  }
  return { n: rows.length, z };
}

export function warnMarkers(z: Record<string, number>): string[] {
  return Object.entries(z).filter(([, v]) => Math.abs(v) >= WARN_Z).map(([k]) => k).sort();
}

/** Markers over threshold tonight AND in the previous night's row (24h window), previous row <= 48h old. */
export function twoNightWarn(tonight: string[], prev: { ts: string; warn_h24?: string[] } | null, now: Date): string[] {
  if (!prev || !Array.isArray(prev.warn_h24)) return [];
  const age = now.getTime() - Date.parse(prev.ts);
  if (!(age >= 0 && age <= 48 * 3600_000)) return [];
  return tonight.filter(m => prev.warn_h24!.includes(m));
}

const fmtZ = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
/** Names and z only. Never any reply content. */
export function logLine(companion: string, h24: WindowResult, d7: WindowResult, warn2: string[]): string {
  const part = (w: WindowResult) => Object.entries(w.z).map(([k, v]) => `${k}=${fmtZ(v)}`).join(" ") || "-";
  const tail = warn2.length ? ` WARN2=${warn2.join(",")}` : "";
  return `[voice-drift] ${companion} h24(n=${h24.n}) ${part(h24)} | d7(n=${d7.n}) ${part(d7)}${tail}`;
}

/**
 * Pull voice_scores rows for one companion. Returns null when the Halseth rows route does not
 * exist (404/405), so callers can degrade instead of failing. Route (proposed, not yet built):
 * GET /mind/voice-scores/:companion_id/rows?from=ISO&to=ISO&limit=N&after=<cursor>
 *   -> { rows: VoiceRow[], next_after?: string }  (ordered created_at ASC)
 */
export async function fetchVoiceRows(
  baseUrl: string, secret: string, companion: string, from: string, to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceRow[] | null> {
  const rows: VoiceRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ from, to, limit: "5000", ...(after ? { after } : {}) });
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/mind/voice-scores/${companion}/rows?${qs}`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw new Error(`voice rows ${companion} -> ${res.status}`);
    const body = await res.json() as { rows?: VoiceRow[]; next_after?: string };
    rows.push(...(body.rows ?? []));
    if (!body.next_after) return rows;
    after = body.next_after;
  }
  return rows;
}
