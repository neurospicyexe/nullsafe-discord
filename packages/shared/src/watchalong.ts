// watchalong.ts -- the triad watches with you (spec docs/SPEC-watchalong-2026-10-02.md).
//
// The companions never see the picture. They follow the CAPTION TRACK of whatever Raziel and Blue are
// watching, cut at a PLAYHEAD Halseth keeps (server-side clock: while `playing`, playhead advances on
// its own; every `<p>: at 47:12` is a resync). Nothing past where the room is reaches them.
//
// Three parts live here:
//   1. Owner commands (`movie start|pause|play|status|done`, `at <time>`): deterministic Halseth writes
//      with LITERAL acks. A model asked to report a write it did not see narrates a convincing success
//      that never happened (2026-06-11 doctrine), so nothing here goes through inference.
//   2. Delivery (`WatchalongDelivery`): on every bot turn in a channel with an active session, the cues
//      between this bot's last-delivered position and the playhead are appended to the LIVE user turn
//      (the [HEARD] pattern), never the system prompt (Hermes may reuse the stamped session prompt, B40).
//      The gateway transcript then accumulates the film naturally, with no duplicates, because
//      lastDelivered only advances after the gateway answered.
//   3. A short standing line for the system prompt: title, playhead, and the soft gate ("only what's on
//      screen so far is yours"). Soft, stated honestly: training memory of a known film and the search
//      tool are NOT gated in v1. The cut stops the text leaking; the line asks for the rest.
//
// Failure never blocks a reply: every delivery path catches, logs, and returns null.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { halsethEnv } from "./halseth-command-env.js";
import { parseCaptions, summarizeCues, type Cue, type CueKind } from "./captions.js";
import { fetchOpenSubtitles } from "./opensubtitles.js";
import { COMMAND_PREFIX } from "./command-triggers.js";

const execFileP = promisify(execFile);

// ── Shapes (the Halseth contract, spec "Routes") ────────────────────────────

export type WatchSource = "attachment" | "opensubtitles" | "youtube";
export type WatchStatus = "playing" | "paused" | "ended";

export interface WatchSession {
  id: string;
  title: string;
  status: WatchStatus;
  playhead_sec: number;
  duration_sec: number | null;
  cue_count: number;
  source?: WatchSource;
}

export interface WatchCueRow {
  idx?: number;
  start_sec: number;
  end_sec?: number;
  kind: CueKind;
  speaker?: string | null;
  text: string;
}

export interface ActiveResponse {
  session: WatchSession | null;
  cues: WatchCueRow[];
  skipped: number;
}

export const MAX_CUES_PER_SESSION = 6000;
/** First delivery deeper than this into a film shows only the last ten minutes. */
export const JOIN_WINDOW_SEC = 600;
export const DELIVERY_CACHE_MS = 10_000;
const DEFAULT_MAX_CUES = 80;
const JOIN_MAX_CUES = 300;

// ── Knob ────────────────────────────────────────────────────────────────────

/** Delivery kill switch. Default ON; `off`/`0`/`false`/`no` stops the per-turn fetch + injection.
 *  Commands keep working either way (they are explicit and cheap). */
export function watchalongEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["WATCHALONG_ENABLED"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

// ── Time ────────────────────────────────────────────────────────────────────

/** "47:12" / "1:02:03" / "47m" / "47 min" / "47 minutes" / "1h02m" / "1h" -> seconds. Null otherwise. */
export function parseWatchTime(input: string): number | null {
  const s = input.trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return mi < 60 && se < 60 ? h * 3600 + mi * 60 + se : null;
  }
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) {
    const [mi, se] = [Number(m[1]), Number(m[2])];
    return se < 60 ? mi * 60 + se : null;
  }
  m = s.match(/^(\d{1,3})\s*(?:m|min|mins|minutes?)$/);
  if (m) return Number(m[1]) * 60;
  m = s.match(/^(\d{1,2})\s*h(?:\s*(\d{1,2})\s*(?:m|min|mins|minutes?)?)?$/);
  if (m) {
    const mi = m[2] ? Number(m[2]) : 0;
    return mi < 60 ? Number(m[1]) * 3600 + mi * 60 : null;
  }
  return null;
}

/** 2832 -> "47:12"; 3723 -> "1:02:03". Negative/NaN -> "0:00". */
export function formatPlayhead(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** One cue as a screenplay-ish line: `[44:12] [floorboard creaks]` / `[44:20] KEVIN: Where's Dad?`. */
export function formatCueLine(c: WatchCueRow): string {
  const at = `[${formatPlayhead(c.start_sec)}]`;
  const text = c.text.trim();
  if (c.kind === "sound" || (c.kind === "music" && !/[♪♫♩♬]/.test(text))) {
    const body = /^\[.*\]$/.test(text) ? text : `[${text}]`;
    return `${at} ${c.speaker ? `${c.speaker}: ` : ""}${body}`;
  }
  return `${at} ${c.speaker ? `${c.speaker}: ` : ""}${text}`;
}

/**
 * The block appended to the live user turn. Null when there is nothing new on screen (an empty delta
 * appends nothing: the companion should not be handed a header with no film under it).
 */
export function formatOnScreenBlock(args: {
  title: string; status: WatchStatus; fromSec: number; toSec: number;
  cues: WatchCueRow[]; skipped: number; joining: boolean; skippedUnknown?: boolean;
}): string | null {
  if (args.cues.length === 0) return null;
  const out = [`[ON SCREEN: ${args.title}, ${formatPlayhead(args.fromSec)} → ${formatPlayhead(args.toSec)}, ${args.status}]`];
  if (args.joining) out.push(`(you're joining ${formatPlayhead(args.toSec)} in; the last ten minutes:)`);
  if (args.skipped > 0) out.push(`(… ${args.skipped} earlier lines not shown)`);
  else if (args.skippedUnknown) out.push(`(… earlier lines not shown)`);
  for (const c of args.cues) out.push(formatCueLine(c));
  return out.join("\n");
}

/** STM gets this one-liner instead of the block, like heardStmMarker. */
export function onScreenStmMarker(title: string, toSec: number): string {
  return `[on screen: ${title} to ${formatPlayhead(toSec)}]`;
}

/** Standing system-prompt line. Nice-to-have, not load-bearing: the live-turn block is what carries the film. */
export function watchalongStandingLine(s: Pick<WatchSession, "title" | "status" | "playhead_sec">): string {
  return `\n\n[Watchalong: ${s.title}, ${formatPlayhead(s.playhead_sec)} in, ${s.status}. ` +
    `A first viewing alongside Raziel: you follow it through its captions, which reach you as [ON SCREEN] blocks. ` +
    `Only what's on screen so far is yours; don't reach for what you know comes later, and don't search the film.]`;
}

// ── Halseth client ──────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

async function wfetch(
  secret: string, p: string, method: "GET" | "POST" | "PATCH", body: unknown, fetchFn: FetchFn, timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const env = halsethEnv(secret);
  if (!env) return { ok: false, status: 0, json: { error: "halseth env missing on this box" } };
  const res = await fetchFn(`${env.base}${p}`, {
    method,
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export interface CreateWatchalongBody {
  title: string;
  channel_id: string;
  source: WatchSource;
  source_ref?: string | null;
  duration_sec?: number | null;
  started_by?: string | null;
  cues: Cue[];
}

export function createWatchalong(secret: string, body: CreateWatchalongBody, fetchFn: FetchFn = fetch) {
  return wfetch(secret, "/mind/watchalong", "POST", body, fetchFn, 30_000);
}

export function patchWatchalong(
  secret: string, id: string, body: { status?: WatchStatus; at_sec?: number }, fetchFn: FetchFn = fetch,
) {
  return wfetch(secret, `/mind/watchalong/${encodeURIComponent(id)}`, "PATCH", body, fetchFn, 15_000);
}

export async function getActiveWatchalong(
  secret: string, channelId: string, sinceSec: number, maxCues: number, fetchFn: FetchFn = fetch, timeoutMs = 5_000,
): Promise<ActiveResponse> {
  const q = new URLSearchParams({ channel_id: channelId, since_sec: String(sinceSec), max_cues: String(maxCues) });
  const r = await wfetch(secret, `/mind/watchalong/active?${q.toString()}`, "GET", undefined, fetchFn, timeoutMs);
  if (!r.ok) throw new Error(`watchalong active ${r.status}`);
  const session = (r.json["session"] as WatchSession | null | undefined) ?? null;
  const cues = Array.isArray(r.json["cues"]) ? r.json["cues"] as WatchCueRow[] : [];
  const skipped = typeof r.json["skipped"] === "number" ? r.json["skipped"] as number : 0;
  return { session, cues, skipped };
}

// ── Delivery ────────────────────────────────────────────────────────────────

export interface PreparedDelivery {
  channelId: string;
  session: WatchSession;
  /** The [ON SCREEN] block for the live user turn, or null for an empty delta. */
  block: string | null;
  /** The STM one-liner, set only when there is a block. */
  stmMarker: string | null;
  /** System-prompt standing line (present whenever a session is live, even on an empty delta). */
  standingLine: string;
  /** Position this delivery covers through; becomes lastDelivered on commit. */
  throughSec: number;
}

interface CacheEntry { at: number; since: number; resp: ActiveResponse }

/**
 * Per-process (= per companion bot) delivery state: lastDelivered keyed by channel + session, and a
 * ≤10s response cache per channel so a burst of turns costs one Halseth read.
 */
export class WatchalongDelivery {
  private cache = new Map<string, CacheEntry>();
  /** channelId -> { sessionId, sec }: the spec's lastDelivered[channel:session]. A new session id in the
   *  channel makes the stored entry inapplicable (first delivery again), so one entry per channel holds it. */
  private lastDelivered = new Map<string, { sessionId: string; sec: number }>();
  private warnedAt = 0;

  constructor(private opts: {
    secret: string;
    companionId: string;
    fetchFn?: FetchFn;
    now?: () => number;
    ttlMs?: number;
  }) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** Drop the cached read for a channel (a command just changed the session). */
  invalidate(channelId: string): void { this.cache.delete(channelId); }

  private async read(channelId: string, since: number, maxCues: number): Promise<ActiveResponse> {
    const ttl = this.opts.ttlMs ?? DELIVERY_CACHE_MS;
    const hit = this.cache.get(channelId);
    if (hit && this.now() - hit.at < ttl && since >= hit.since) {
      // Re-filter the cached slice: everything in (hit.since, playhead] is there, so (since, playhead] is too.
      return { session: hit.resp.session, cues: hit.resp.cues.filter(c => c.start_sec > since), skipped: since === hit.since ? hit.resp.skipped : 0 };
    }
    const resp = await getActiveWatchalong(this.opts.secret, channelId, since, maxCues, this.opts.fetchFn ?? fetch);
    this.cache.set(channelId, { at: this.now(), since, resp });
    return resp;
  }

  /** Never throws. Null = no active session, delivery disabled, or Halseth unreachable. */
  async prepare(channelId: string): Promise<PreparedDelivery | null> {
    try {
      const last = this.lastDelivered.get(channelId);
      let since = last ? last.sec : -1;
      let resp = await this.read(channelId, since, last ? DEFAULT_MAX_CUES : JOIN_MAX_CUES);
      if (!resp.session || resp.session.status === "ended") return null;

      // The stored position belonged to an earlier session in this channel: this is a first delivery.
      if (last && last.sessionId !== resp.session.id) {
        this.lastDelivered.delete(channelId);
        this.invalidate(channelId);
        since = -1;
        resp = await this.read(channelId, since, JOIN_MAX_CUES);
        if (!resp.session || resp.session.status === "ended") return null;
      }

      const s = resp.session;
      const playhead = s.playhead_sec;
      const firstDelivery = since < 0;
      const joining = firstDelivery && playhead > JOIN_WINDOW_SEC;
      let cues = resp.cues;
      let skipped = resp.skipped;
      let skippedUnknown = false;
      let fromSec = since < 0 ? 0 : since;
      if (joining) {
        fromSec = playhead - JOIN_WINDOW_SEC;
        const inWindow = cues.filter(c => c.start_sec > fromSec);
        // If the server truncated and even the oldest returned cue is inside the window, some of the
        // window's own lines were dropped too; we cannot know how many from this response.
        skippedUnknown = skipped > 0 && inWindow.length === cues.length;
        cues = inWindow;
        skipped = 0;
      }
      const block = formatOnScreenBlock({ title: s.title, status: s.status, fromSec, toSec: playhead, cues, skipped, joining, skippedUnknown });
      return {
        channelId,
        session: s,
        block,
        stmMarker: block ? onScreenStmMarker(s.title, playhead) : null,
        standingLine: watchalongStandingLine(s),
        throughSec: Math.max(playhead, since),
      };
    } catch (err) {
      // Rate-limit the warning: a Halseth outage would otherwise log on every turn in every channel.
      if (this.now() - this.warnedAt > 60_000) {
        this.warnedAt = this.now();
        console.warn(`[${this.opts.companionId}] watchalong fetch failed (reply continues without it): ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
      }
      return null;
    }
  }

  /** Call only after the gateway answered: the cues are now in its transcript. */
  commit(p: PreparedDelivery): void {
    this.lastDelivered.set(p.channelId, { sessionId: p.session.id, sec: p.throughSec });
  }

  /** Test/diagnostic read of the stored position. */
  lastDeliveredFor(channelId: string): { sessionId: string; sec: number } | undefined {
    return this.lastDelivered.get(channelId);
  }
}

// ── Caption loading (movie start) ───────────────────────────────────────────

export interface CaptionAttachment { name: string; text: string }

export interface LoadedCaptions {
  cues: Cue[];
  source: WatchSource;
  sourceRef: string | null;
  sourceLabel: string;
  /** Title discovered from the source (yt-dlp), when the given title was a URL. */
  discoveredTitle: string | null;
}

export interface CaptionDeps {
  ytDlpSubs?: (url: string) => Promise<{ text: string; title: string | null }>;
  openSubtitles?: (title: string) => Promise<{ text: string; fileId: number; fileName: string | null; hearingImpaired: boolean }>;
  hasOpenSubtitlesKey?: () => boolean;
}

/** yt-dlp: write subs (manual preferred, auto as fallback) as VTT, no media download. */
export async function ytDlpSubs(url: string): Promise<{ text: string; title: string | null }> {
  const YTDLP = process.env["YTDLP_PATH"] ?? "yt-dlp";
  const extra = (process.env["YTDLP_EXTRA_ARGS"] ?? "").split(" ").filter(Boolean);
  const dir = await mkdtemp(path.join(process.env["MEDIA_CACHE_DIR"] ?? tmpdir(), "watchalong-"));
  try {
    let stdout = "";
    try {
      const r = await execFileP(YTDLP, [
        ...extra, "--no-playlist", "--skip-download", "--no-simulate", "--print", "title",
        "--write-subs", "--write-auto-subs", "--sub-langs", "en.*", "--sub-format", "vtt",
        "-o", path.join(dir, "subs.%(ext)s"), url,
      ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      stdout = r.stdout;
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      console.error(`[watchalong] yt-dlp subs failed for ${url}\n${stderr.slice(-1500) || String(err)}`);
      throw new Error("yt-dlp couldn't fetch captions for that link");
    }
    const files = (await readdir(dir)).filter(f => f.endsWith(".vtt"));
    const pick = files.find(f => /\.en\.vtt$/.test(f)) ?? files.find(f => /\.en[-_]/.test(f)) ?? files[0];
    if (!pick) throw new Error("that link has no English captions (manual or auto)");
    const text = await readFile(path.join(dir, pick), "utf8");
    const title = stdout.trim().split("\n")[0]?.trim() || null;
    return { text, title };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const DEFAULT_DEPS: Required<CaptionDeps> = {
  ytDlpSubs,
  openSubtitles: (t) => fetchOpenSubtitles(t),
  hasOpenSubtitlesKey: () => !!(process.env["OPENSUBTITLES_API_KEY"] ?? "").trim(),
};

export class NoCaptionsError extends Error {}

/** Source order (spec): attachment -> title is a URL -> yt-dlp subs -> OpenSubtitles -> NoCaptionsError. */
export async function loadCaptions(
  title: string, attachment: CaptionAttachment | null, deps: CaptionDeps = {},
): Promise<LoadedCaptions> {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (attachment) {
    return { cues: parseCaptions(attachment.text), source: "attachment", sourceRef: attachment.name, sourceLabel: `attached ${attachment.name}`, discoveredTitle: null };
  }
  const t = title.trim().replace(/^<|>$/g, "");
  if (/^https?:\/\//i.test(t)) {
    const r = await d.ytDlpSubs(t);
    return { cues: parseCaptions(r.text), source: "youtube", sourceRef: t, sourceLabel: "yt-dlp captions", discoveredTitle: r.title };
  }
  if (d.hasOpenSubtitlesKey()) {
    try {
      const r = await d.openSubtitles(t);
      return {
        cues: parseCaptions(r.text), source: "opensubtitles", sourceRef: String(r.fileId),
        sourceLabel: r.hearingImpaired ? "OpenSubtitles, HI" : "OpenSubtitles", discoveredTitle: null,
      };
    } catch (err) {
      throw new NoCaptionsError(String(err instanceof Error ? err.message : err));
    }
  }
  throw new NoCaptionsError("");
}

// ── Commands ────────────────────────────────────────────────────────────────

export interface WatchalongCommandCtx {
  secret: string;
  channelId: string;
  companionId: string;
  startedBy?: string | null;
  attachment?: CaptionAttachment | null;
  fetchFn?: FetchFn;
  captionDeps?: CaptionDeps;
  /** Called after any command that changed the session, so this bot's delivery cache drops it. */
  onChanged?: () => void;
}

function prefixOf(companionId: string): string { return COMMAND_PREFIX[companionId] ?? companionId; }

/** Read the live session in this channel without pulling cues (since far past any film). */
async function currentSession(ctx: WatchalongCommandCtx): Promise<WatchSession | null> {
  const r = await getActiveWatchalong(ctx.secret, ctx.channelId, 1e9, 1, ctx.fetchFn ?? fetch, 15_000);
  return r.session && r.session.status !== "ended" ? r.session : null;
}

function noSession(ctx: WatchalongCommandCtx): string {
  return `no movie running in this channel. \`${prefixOf(ctx.companionId)}: movie start <title>\` first.`;
}

export type MovieSub = "start" | "pause" | "play" | "status" | "done";

/** Normalise the subcommand word the trigger captured. */
export function normaliseMovieSub(word: string): MovieSub | null {
  const w = word.toLowerCase();
  if (w === "start") return "start";
  if (w === "pause") return "pause";
  if (w === "play" || w === "resume") return "play";
  if (w === "status") return "status";
  if (w === "done" || w === "end" || w === "stop") return "done";
  return null;
}

/** `<p>: movie start|pause|play|status|done`. Returns the exact message the bot sends. Never throws. */
export async function handleMovieCommand(subWord: string, arg: string, ctx: WatchalongCommandCtx): Promise<string> {
  const sub = normaliseMovieSub(subWord);
  const p = prefixOf(ctx.companionId);
  const f = ctx.fetchFn ?? fetch;
  try {
    if (sub === "start") return await movieStart(arg, ctx);
    if (!sub) return `movie forms: \`${p}: movie start <title>\`, \`${p}: movie pause|play|status|done\`, \`${p}: at 47:12\`.`;

    const s = await currentSession(ctx);
    if (!s) return noSession(ctx);

    if (sub === "status") {
      const dur = s.duration_sec ? ` / ${formatPlayhead(s.duration_sec)}` : "";
      return `🎬 ${s.title}: ${formatPlayhead(s.playhead_sec)}${dur}, ${s.status} (${s.cue_count} lines).`;
    }
    const status: WatchStatus = sub === "pause" ? "paused" : sub === "play" ? "playing" : "ended";
    const r = await patchWatchalong(ctx.secret, s.id, { status }, f);
    if (r.status === 409) return `${s.title} had already ended.`;
    if (!r.ok) return `couldn't ${sub} the movie: halseth ${r.status}, so nothing changed.`;
    ctx.onChanged?.();
    const at = formatPlayhead(typeof r.json["playhead_sec"] === "number" ? r.json["playhead_sec"] as number : s.playhead_sec);
    if (sub === "pause") return `⏸ ${s.title} paused at ${at}. \`${p}: movie play\` or \`${p}: at <time>\` to go again.`;
    if (sub === "play") return `▶ ${at}`;
    return `🎬 ${s.title} ended at ${at}.`;
  } catch (err) {
    return `movie command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
  }
}

async function movieStart(arg: string, ctx: WatchalongCommandCtx): Promise<string> {
  const p = prefixOf(ctx.companionId);
  let title = arg.trim();
  const att = ctx.attachment ?? null;
  if (!title && att) title = att.name.replace(/\.(srt|vtt)$/i, "").replace(/[._]+/g, " ").trim();
  if (!title) return `give me a title: \`${p}: movie start <title>\` (attach an .srt or .vtt to use your own captions).`;

  let loaded: LoadedCaptions;
  try {
    loaded = await loadCaptions(title, att, ctx.captionDeps);
  } catch (err) {
    if (err instanceof NoCaptionsError) {
      const why = err.message ? ` (${err.message})` : "";
      return `no captions found${why}: attach an .srt to \`${p}: movie start ${title}\``;
    }
    return `couldn't load captions: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
  }
  if (loaded.discoveredTitle) title = loaded.discoveredTitle;
  title = title.slice(0, 200);

  const cues = loaded.cues;
  if (cues.length === 0) return `found captions (${loaded.sourceLabel}) but couldn't read a single line from them, so nothing was loaded.`;
  if (cues.length > MAX_CUES_PER_SESSION) {
    return `those captions have ${cues.length} lines; the limit is ${MAX_CUES_PER_SESSION}, so nothing was loaded.`;
  }
  const sum = summarizeCues(cues);
  const r = await createWatchalong(ctx.secret, {
    title, channel_id: ctx.channelId, source: loaded.source, source_ref: loaded.sourceRef,
    duration_sec: sum.duration_sec || null, started_by: ctx.startedBy ?? null, cues,
  }, ctx.fetchFn ?? fetch);
  if (!r.ok) {
    return `movie NOT loaded: ${String(r.json["error"] ?? `halseth ${r.status}`).slice(0, 200)}`;
  }
  ctx.onChanged?.();
  const n = typeof r.json["cue_count"] === "number" ? r.json["cue_count"] as number : sum.total;
  return `🎬 ${title} loaded: ${n} lines (${sum.sound} sound, ${sum.music} music cues, ${loaded.sourceLabel}). ` +
    `Paused at 0:00. Say ${p}: at 0:00 when you press play.`;
}

/** `<p>: at 47:12` -- seek + play (a resync, not just a report). Never throws. */
export async function handleAtCommand(timeStr: string, ctx: WatchalongCommandCtx): Promise<string> {
  const p = prefixOf(ctx.companionId);
  const sec = parseWatchTime(timeStr);
  if (sec === null) return `didn't read "${timeStr}" as a time. try \`${p}: at 47:12\` or \`${p}: at 1:02:03\`.`;
  try {
    const s = await currentSession(ctx);
    if (!s) return noSession(ctx);
    const r = await patchWatchalong(ctx.secret, s.id, { at_sec: sec, status: "playing" }, ctx.fetchFn ?? fetch);
    if (r.status === 409) return `${s.title} had already ended.`;
    if (!r.ok) return `couldn't seek: halseth ${r.status}, so the playhead didn't move.`;
    ctx.onChanged?.();
    const at = typeof r.json["playhead_sec"] === "number" ? r.json["playhead_sec"] as number : sec;
    return `▶ ${formatPlayhead(at)}`;
  } catch (err) {
    return `at command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
  }
}

// ── Attachment reading ──────────────────────────────────────────────────────

export const CAPTION_ATTACHMENT_RE = /\.(srt|vtt)$/i;
const CAPTION_MAX_BYTES = 2 * 1024 * 1024;

/** Fetch the first .srt/.vtt attachment's text. Null when none, too big, or unreadable (never logs the
 *  CDN url: its `hm=` signature is bearer-ish while it lives). */
export async function readCaptionAttachment(
  attachments: Iterable<{ name?: string | null; url: string; size?: number }>, fetchFn: FetchFn = fetch,
): Promise<CaptionAttachment | null> {
  for (const a of attachments) {
    const name = a.name ?? "";
    if (!CAPTION_ATTACHMENT_RE.test(name)) continue;
    if (typeof a.size === "number" && a.size > CAPTION_MAX_BYTES) {
      console.warn(`[watchalong] caption attachment "${name}" too large (${a.size} bytes)`);
      return null;
    }
    try {
      const res = await fetchFn(a.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { console.warn(`[watchalong] caption attachment "${name}" fetch ${res.status}`); return null; }
      const text = await res.text();
      return text.length > CAPTION_MAX_BYTES ? null : { name, text };
    } catch (err) {
      console.warn(`[watchalong] caption attachment "${name}" unreadable: ${String(err).slice(0, 120)}`);
      return null;
    }
  }
  return null;
}
