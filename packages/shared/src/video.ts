// video.ts -- shared-experience: the WATCH pipeline (one-shot, 2026-10-23).
//
// Blue's question (10-23): could Dre watch the nighttime YouTubes with them, "that's how he listens to
// music". Right about the shape, wrong about the pipe. `listen` (media.ts) downloads the AUDIO, runs
// hear-music (tempo, key, onsets) and hunts LYRICS; a talk video pushed through it came out as
// "Track: ... Tempo: ... Lyrics: not retrieved" and the companion argued with itself about whether it
// was a song. A video is WORDS: what was said, by whom, about what. So:
//
//   `<p>: watch <url>` / `<p>: video <url>`
//     -> yt-dlp fetches the CAPTION TRACK (manual preferred, auto as fallback) and the info dict (title,
//        channel, description, chapters, category) with NO media download;
//     -> the cues become a timestamped transcript, chaptered when the uploader chaptered it;
//     -> the bot gets a [WATCHED] block on the LIVE turn (the [HEARD] pattern: this turn only, STM keeps a
//        one-line past-tense marker) and answers having read the whole thing;
//     -> a media_experiences row (media_type 'video') lands in Halseth, so orient says "watched", and the
//        reply is saved as the reaction through the same PATCH `listen` uses.
//
// No captions at all (rare on YouTube: auto-captions exist for nearly every English upload) -> when the
// Voxtral STT key is on the box and the video is short enough, the audio is downloaded and transcribed;
// otherwise a plain "no captions, nothing to read" error. Never a narrated watch (2026-06-11 doctrine).
//
// This is NOT the watchalong (`movie start <url>`, watchalong.ts): that keeps a playhead and feeds cues as
// the room reaches them, for a film watched live. `watch` is the whole thing at once -- the shape of
// "here, we watched this, talk to us about it", or "I think you'd find this one interesting".
//
// Env: MEDIA_WATCH_ENABLED (default ON; off/0/false/no), WATCH_TRANSCRIPT_CHARS (default 12000: what
// the block may carry; longer transcripts are SAMPLED evenly across the runtime with the gaps marked),
// WATCH_STT_MAX_SEC (default 1500: longest video the no-captions STT fallback will transcribe).
// YTDLP_PATH / YTDLP_EXTRA_ARGS / MEDIA_CACHE_DIR are shared with `listen`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCaptions, type Cue } from "./captions.js";
import { diagnoseYtDlp, postExperience } from "./media.js";

const execFileP = promisify(execFile);

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface VideoChapter { start_sec: number; title: string }

export interface VideoMeta {
  video_id: string | null;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  /** yt-dlp's YYYYMMDD, kept as ISO date (YYYY-MM-DD) or null. */
  upload_date: string | null;
  categories: string[];
  description: string | null;
  chapters: VideoChapter[];
  language: string | null;
  url: string;
}

export type TranscriptSource = "captions" | "auto-captions" | "stt";

export interface SampledTranscript {
  text: string;
  sampled: boolean;
  /** Share of the transcript's words that made it into `text` (1 when not sampled). */
  kept_ratio: number;
}

export interface WatchResult {
  experienceId: string | null; // null if the Halseth write failed (non-fatal)
  meta: VideoMeta;
  watchedBlock: string;
  source: TranscriptSource;
  transcript_chars: number;
  sampled: boolean;
}

export interface WatchDeps {
  /** Voxtral STT (voice.ts `VoiceClient.transcribe`), used ONLY when the video has no captions. */
  transcribe?: ((audio: Buffer, filename: string, timeoutMs?: number) => Promise<string>) | null;
}

// ── Knobs ───────────────────────────────────────────────────────────────────

/** Default ON (unlike listen, nothing beyond yt-dlp is needed); `off`/`0`/`false`/`no` turns it off. */
export function isWatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["MEDIA_WATCH_ENABLED"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

export const DEFAULT_TRANSCRIPT_CHARS = 12_000;
export function watchTranscriptChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env["WATCH_TRANSCRIPT_CHARS"] ?? "").trim());
  return Number.isFinite(n) && n >= 2_000 ? Math.floor(n) : DEFAULT_TRANSCRIPT_CHARS;
}

export const DEFAULT_STT_MAX_SEC = 1_500;
export function watchSttMaxSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env["WATCH_STT_MAX_SEC"] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STT_MAX_SEC;
}

// ── URL shape ───────────────────────────────────────────────────────────────

/** A YouTube video link (watch / shorts / live / embed / youtu.be). Used by the grounding backstop:
 *  a YouTube link nobody opened must not be described. */
export const YOUTUBE_URL_RE = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)\S+/i;
export function isYouTubeUrl(s: string): boolean {
  return YOUTUBE_URL_RE.test(s);
}

// ── Captions: which tracks, which file ──────────────────────────────────────

/**
 * Explicit English codes, NOT `en.*`. The glob matched every auto-TRANSLATED track YouTube offers
 * (`en-ar`, `en-zh`, ... 4,842 of them on one video, probed 2026-10-23) and yt-dlp started downloading
 * all of them until YouTube answered 429. `en-orig` is the auto-caption code for the spoken language.
 *
 * `en-orig` is asked for FIRST. Without a manual track, the auto `en` can be a machine TRANSLATION
 * (`lang=es&tlang=en` on the 2026-10-27 Mann Gulch video, which YouTube's ASR had tagged Spanish), and
 * YouTube 429s translated tracks on sight. yt-dlp aborts at the first failed track, so with `en` first the
 * real English (`en-orig`, 1,515 cues) was never reached and the whole watch failed. Order here is the
 * DOWNLOAD order only; which landed file gets read is `pickCaptionFile`'s call.
 */
export const CAPTION_LANGS = ["en-orig", "en", "en-US", "en-GB"] as const;

const MANUAL_PREFERENCE = ["en", "en-US", "en-GB"] as const;

/**
 * Which landed track to read: a MANUAL English track first (the uploader's own words), then the untranslated
 * auto `en-orig`, then an auto `en`/regional (possibly a translation, but it landed), then whatever landed.
 * `manual` is the language list from `%(subtitles)j`; without it every `en*` file is treated as auto.
 */
export function pickCaptionFile(files: readonly string[], manual: readonly string[] = []): string | null {
  const vtt = files.filter(f => f.toLowerCase().endsWith(".vtt"));
  if (vtt.length === 0) return null;
  const fileFor = (lang: string) => vtt.find(f => f.toLowerCase().endsWith(`.${lang.toLowerCase()}.vtt`));
  const manualLower = new Set(manual.map(l => l.toLowerCase()));
  for (const lang of MANUAL_PREFERENCE) {
    const hit = manualLower.has(lang.toLowerCase()) ? fileFor(lang) : undefined;
    if (hit) return hit;
  }
  for (const lang of ["en-orig", ...MANUAL_PREFERENCE]) {
    const hit = fileFor(lang);
    if (hit) return hit;
  }
  return vtt.find(f => /\.en[-_][a-z]+\.vtt$/i.test(f)) ?? vtt[0] ?? null;
}

// ── Info dict ───────────────────────────────────────────────────────────────

/** The one `--print` template: a JSON subset of the info dict. NOT `subtitles`/`automatic_captions` here --
 *  the latter alone was 15 MB on the probe video. Manual-vs-auto is read from a second, small print. */
export const INFO_PRINT = "%(.{id,title,description,duration,uploader,channel,upload_date,categories,chapters,webpage_url,language})j";
export const SUBS_PRINT = "%(subtitles)j";

export function parseVideoInfo(json: string, url: string): VideoMeta {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(json) as Record<string, unknown>; } catch { /* keep empty: title falls back below */ }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rawDate = str(d["upload_date"]);
  const upload_date = rawDate && /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : null;
  const chapters: VideoChapter[] = Array.isArray(d["chapters"])
    ? (d["chapters"] as Array<Record<string, unknown>>)
        .map(c => ({ start_sec: num(c["start_time"]) ?? NaN, title: str(c["title"]) ?? "" }))
        .filter(c => Number.isFinite(c.start_sec) && c.title)
        .sort((a, b) => a.start_sec - b.start_sec)
    : [];
  const categories = Array.isArray(d["categories"]) ? (d["categories"] as unknown[]).map(c => String(c)).filter(Boolean) : [];
  return {
    video_id: str(d["id"]),
    title: str(d["title"]) ?? "untitled video",
    channel: str(d["channel"]) ?? str(d["uploader"]),
    duration_sec: num(d["duration"]),
    upload_date,
    categories,
    description: str(d["description"]),
    chapters,
    language: str(d["language"]),
    url: str(d["webpage_url"]) ?? url,
  };
}

/** Languages with MANUAL subtitles, from `%(subtitles)j`. Empty on junk. */
export function manualCaptionLangs(json: string): string[] {
  try {
    const d = JSON.parse(json) as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d as object) : [];
  } catch {
    return [];
  }
}

// ── Transcript text ─────────────────────────────────────────────────────────

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

const CHAPTER_PREFIX = "## ";
const PARAGRAPH_SEC = 40;
const SENTENCE_END_RE = /[.!?]["')\]]?$/;

/**
 * Cues -> readable transcript. One paragraph per ~40 s of speech (cut at a sentence end once past that,
 * hard-cut at twice it), `[m:ss]` on each paragraph, a `## [m:ss] title` header where the uploader put a
 * chapter. Sound/music cues keep their brackets so "[applause]" reads as what it is. Pure.
 */
export function transcriptFromCues(cues: readonly Cue[], chapters: readonly VideoChapter[] = []): string {
  const out: string[] = [];
  let para: { start: number; parts: string[] } | null = null;
  let nextChapter = 0;
  const flush = () => {
    if (para && para.parts.length > 0) out.push(`[${formatTimestamp(para.start)}] ${para.parts.join(" ")}`);
    para = null;
  };
  for (const cue of cues) {
    while (nextChapter < chapters.length && cue.start_sec >= chapters[nextChapter]!.start_sec - 0.5) {
      flush();
      const ch = chapters[nextChapter]!;
      out.push(`${CHAPTER_PREFIX}[${formatTimestamp(ch.start_sec)}] ${ch.title}`);
      nextChapter++;
    }
    const text = cue.text.trim();
    if (!text) continue;
    const piece = cue.kind === "line" ? (cue.speaker ? `${cue.speaker}: ${text}` : text) : `[${text}]`;
    if (!para) {
      para = { start: cue.start_sec, parts: [piece] };
      continue;
    }
    const elapsed = cue.start_sec - para.start;
    const last = para.parts[para.parts.length - 1] ?? "";
    if (elapsed >= PARAGRAPH_SEC * 2 || (elapsed >= PARAGRAPH_SEC && SENTENCE_END_RE.test(last))) {
      flush();
      para = { start: cue.start_sec, parts: [piece] };
    } else {
      para.parts.push(piece);
    }
  }
  flush();
  // Chapters past the last cue (an outro with no speech) still name themselves.
  for (; nextChapter < chapters.length; nextChapter++) {
    const ch = chapters[nextChapter]!;
    out.push(`${CHAPTER_PREFIX}[${formatTimestamp(ch.start_sec)}] ${ch.title}`);
  }
  return out.join("\n");
}

/** Plain STT text (no timestamps) -> paragraphs of a few sentences, so a long transcript still reads. */
export function paragraphsFromPlainText(text: string, sentencesPerParagraph = 5): string {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    out.push(sentences.slice(i, i + sentencesPerParagraph).map(s => s.trim()).join(" "));
  }
  return out.join("\n");
}

const STAMP_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/;

/**
 * Fit a transcript into `maxChars` WITHOUT losing the arc: chapter headers always stay; body paragraphs are
 * kept every k-th so the kept ones spread evenly across the runtime; every gap is marked with the time
 * range it skipped. A head-only cut would hand the companion the first twelve minutes of an hour and call
 * it the video. Pure.
 */
export function sampleTranscript(transcript: string, maxChars: number): SampledTranscript {
  if (transcript.length <= maxChars) return { text: transcript, sampled: false, kept_ratio: 1 };
  const lines = transcript.split("\n");
  const isHeader = (l: string) => l.startsWith(CHAPTER_PREFIX);
  const headerChars = lines.filter(isHeader).reduce((n, l) => n + l.length + 1, 0);
  const body = lines.filter(l => !isHeader(l));
  const bodyChars = body.reduce((n, l) => n + l.length + 1, 0);
  // ~30 chars per gap marker; reserve for one marker per kept paragraph (worst case).
  const budget = Math.max(maxChars - headerChars - 400, Math.floor(maxChars * 0.5));
  // A fractional keep RATE, not an integer stride: an 18-minute video at 1.6x the budget keeps ~60%, where
  // "every 2nd paragraph" threw away half (VPS probe 2026-10-24: kept_ratio 0.52 with room for 0.60).
  // An accumulator (Bresenham) starting at 1 keeps the opening paragraph and then one every 1/rate, which
  // spreads the kept ones evenly across the runtime. Capped at 0.97 so the gap markers fit; the trim below
  // guarantees the cap.
  const rate = Math.min(0.97, budget / Math.max(bodyChars, 1));
  let acc = 1;

  const out: string[] = [];
  let bodyIdx = 0;
  let keptChars = 0;
  let gapStart: string | null = null;
  let gapEnd: string | null = null;
  const stampOf = (l: string) => l.match(STAMP_RE)?.[1] ?? null;
  const closeGap = () => {
    if (gapStart !== null) {
      out.push(gapEnd && gapEnd !== gapStart ? `[… skipped ${gapStart}–${gapEnd} …]` : `[… skipped ${gapStart} …]`);
      gapStart = null;
      gapEnd = null;
    }
  };
  for (const line of lines) {
    if (isHeader(line)) { closeGap(); out.push(line); continue; }
    const keep = acc >= 1;
    if (keep) acc -= 1;
    acc += rate;
    bodyIdx++;
    if (keep) {
      closeGap();
      out.push(line);
      keptChars += line.length + 1;
    } else {
      const st = stampOf(line) ?? "?";
      if (gapStart === null) gapStart = st;
      gapEnd = st;
    }
  }
  closeGap();

  // Long paragraphs can still overshoot: trim from the end and say where the text stops.
  let text = out.join("\n");
  if (text.length > maxChars) {
    const kept: string[] = [];
    let n = 0;
    for (const l of out) {
      if (n + l.length + 1 > maxChars - 60) break;
      kept.push(l);
      n += l.length + 1;
    }
    if (kept.length === 0) {
      // Even the first paragraph is bigger than the budget: hand over its head rather than nothing.
      const first = out.find(l => !isHeader(l)) ?? out[0] ?? "";
      kept.push(first.slice(0, Math.max(0, maxChars - 60)).trimEnd() + "…");
    }
    const lastStamp = [...kept].reverse().map(stampOf).find(Boolean) ?? null;
    kept.push(lastStamp ? `[… transcript cut after ${lastStamp} …]` : "[… transcript cut …]");
    text = kept.join("\n");
  }
  return { text, sampled: true, kept_ratio: bodyChars > 0 ? Math.min(1, keptChars / bodyChars) : 1 };
}

// ── The block the bot reads ─────────────────────────────────────────────────

const DESCRIPTION_CHARS = 700;
const CHAPTERS_LISTED = 30;

/** The uploader's description with links and sponsor boilerplate thinned: what the video is ABOUT, in
 *  their words, not their merch table. */
export function cleanVideoDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lines = raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length > 0)
    // Pure social/link lines left behind once the URL is gone ("Twitter:", "Patreon:", "Instagram -").
    .filter(l => !/^(?:twitter|x|instagram|patreon|discord|tiktok|facebook|twitch|merch|website|subscribe|follow|support)\b[^a-z]*$/i.test(l));
  const joined = lines.join(" ").trim();
  if (!joined) return null;
  return joined.length > DESCRIPTION_CHARS ? joined.slice(0, DESCRIPTION_CHARS - 1).trimEnd() + "…" : joined;
}

function sourceLabel(source: TranscriptSource): string {
  switch (source) {
    case "captions": return "the uploader's own captions";
    case "auto-captions": return "YouTube's automatic captions -- names and technical terms may be misheard";
    case "stt": return "speech-to-text from the audio (no captions existed) -- names and terms may be misheard, no timestamps";
  }
}

export function buildWatchedBlock(meta: VideoMeta, transcript: SampledTranscript, source: TranscriptSource): string {
  const lines: string[] = [];
  const duration = typeof meta.duration_sec === "number" ? ` (${formatTimestamp(meta.duration_sec)})` : "";
  lines.push(`Video: ${meta.title}${meta.channel ? ` -- ${meta.channel}` : ""}${duration}`);
  const facts: string[] = [];
  if (meta.upload_date) facts.push(`published ${meta.upload_date}`);
  if (meta.categories.length > 0) facts.push(`YouTube files it under ${meta.categories.join(", ")}`);
  if (facts.length > 0) lines.push(facts.join("; "));
  const desc = cleanVideoDescription(meta.description);
  if (desc) lines.push(`About (the uploader's description, trimmed): ${desc}`);
  if (meta.chapters.length > 0) {
    const shown = meta.chapters.slice(0, CHAPTERS_LISTED);
    lines.push(`Chapters (${meta.chapters.length}):\n` + shown.map(c => `  [${formatTimestamp(c.start_sec)}] ${c.title}`).join("\n")
      + (meta.chapters.length > shown.length ? `\n  … and ${meta.chapters.length - shown.length} more` : ""));
  }
  const coverage = transcript.sampled
    ? `SAMPLED -- about ${Math.max(1, Math.round(transcript.kept_ratio * 100))}% of the words, spread evenly across the runtime; every gap is marked [… skipped …]`
    : "complete";
  lines.push(`Transcript (${sourceLabel(source)}; ${coverage}):\n${transcript.text}`);
  lines.push(
    "What is above is what was said in the video, in order; you have read it, you have not seen the picture. " +
    "Speak to its content and the people in it. Do not invent lines that are not here. Where the sampling skipped a " +
    "stretch, say you missed that part rather than fill it in.",
  );
  return lines.join("\n");
}

// STM-scoped markers: the [WATCHED] block is a THIS-TURN injection (the transcript must never re-feed every
// later turn, the 2026-08-29 lesson from [HEARD]). These are the one-line past-tense records STM keeps.
export function watchedStmMarker(meta: VideoMeta): string {
  return `[shared a video you watched at the time: ${meta.title}${meta.channel ? ` (${meta.channel})` : ""}]`;
}

export function notWatchedStmMarker(): string {
  return "[shared a video link; the watch pipeline did not run]";
}

/** Grounding backstop text for a YouTube link nobody opened (the inverse of [WATCHED]). */
export function notWatchedBlock(prefix: string): string {
  return `[NOT WATCHED -- this video link was shared but nobody opened it: no transcript, no description, nothing. ` +
    `Do not describe or summarize what it is about, and do not claim to have seen it; any memory of it you feel you have is invention. ` +
    `Say plainly you haven't watched it yet; "${prefix}: watch <url>" gets you the transcript.]`;
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────

export interface FetchedCaptions {
  meta: VideoMeta;
  vtt: string | null;
  captionKind: "manual" | "auto" | null;
  /** Set when captions were offered but none could be downloaded (a 429, say): the video info still came
   *  back, so the pipeline can try speech-to-text and, failing that, say WHY instead of "no captions". */
  captionError?: string;
}

function ytDlpBin(): { bin: string; extra: string[] } {
  return {
    bin: process.env["YTDLP_PATH"] ?? "yt-dlp",
    extra: (process.env["YTDLP_EXTRA_ARGS"] ?? "").split(" ").filter(Boolean),
  };
}

/**
 * One yt-dlp run: captions written to `dir`, two JSON lines on stdout (info subset, then manual-subtitle
 * map). A non-zero exit with a caption file on disk is a SUCCESS (one 429 on a second track must not throw
 * away the one that landed). A non-zero exit with no caption but the info line on stdout returns
 * `vtt: null` + `captionError`, so the pipeline can still transcribe the audio; with nothing at all it is
 * diagnosed like `listen` does.
 */
export async function fetchVideoCaptions(url: string): Promise<FetchedCaptions> {
  const { bin, extra } = ytDlpBin();
  const dir = await mkdtemp(path.join(process.env["MEDIA_CACHE_DIR"] ?? tmpdir(), "watch-"));
  try {
    let stdout = "";
    let stderr = "";
    let captionError: string | undefined;
    try {
      const r = await execFileP(bin, [
        ...extra, "--no-playlist", "--skip-download", "--no-simulate", "--no-progress",
        "--write-subs", "--write-auto-subs", "--sub-langs", CAPTION_LANGS.join(","), "--sub-format", "vtt",
        "--print", INFO_PRINT, "--print", SUBS_PRINT,
        "-o", path.join(dir, "subs.%(ext)s"), url,
      ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = r.stdout;
      stderr = r.stderr ?? "";
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = String(e.stdout ?? "");
      stderr = String(e.stderr ?? "");
      const landed = (await readdir(dir).catch(() => [] as string[])).some(f => f.endsWith(".vtt"));
      if (!stdout.trim()) {
        console.error(`[watch] yt-dlp failed for ${url}\n${stderr.slice(-2000) || String(err)}`);
        throw new Error(diagnoseYtDlp(stderr || String(err)));
      }
      const lastLine = stderr.trim().split(/\r?\n/).filter(l => /ERROR/.test(l)).pop() ?? stderr.trim().split(/\r?\n/).pop() ?? "";
      if (landed) {
        console.warn(`[watch] yt-dlp exited non-zero but captions landed for ${url}; last line: ${lastLine.slice(0, 200)}`);
      } else {
        captionError = diagnoseYtDlp(stderr || String(err));
        console.warn(`[watch] no caption track landed for ${url} (info did); falling through. last line: ${lastLine.slice(0, 200)}`);
      }
    }
    const [infoLine, subsLine] = stdout.trim().split("\n");
    const meta = parseVideoInfo(infoLine ?? "{}", url);
    const manual = manualCaptionLangs(subsLine ?? "{}");
    const files = await readdir(dir);
    const pick = pickCaptionFile(files, manual);
    if (!pick) return { meta, vtt: null, captionKind: null, ...(captionError ? { captionError } : {}) };
    const vtt = await readFile(path.join(dir, pick), "utf8");
    const lang = pick.replace(/^subs\./, "").replace(/\.vtt$/i, "");
    // yt-dlp writes the manual track when one exists for the code and the auto track only otherwise.
    const captionKind = manual.some(l => l.toLowerCase() === lang.toLowerCase()) ? "manual" : "auto";
    return { meta, vtt, captionKind };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const STT_MAX_BYTES = 24 * 1024 * 1024;

/** No captions: pull a low-bitrate mp3 and hand it to Voxtral. Bounded by duration and file size. */
async function transcribeAudio(url: string, meta: VideoMeta, transcribe: NonNullable<WatchDeps["transcribe"]>, lead: string): Promise<string> {
  const maxSec = watchSttMaxSec();
  if (typeof meta.duration_sec === "number" && meta.duration_sec > maxSec) {
    throw new Error(`${lead}, and at ${formatTimestamp(meta.duration_sec)} it's past the ${Math.round(maxSec / 60)}-minute limit for transcribing the audio myself`);
  }
  const { bin, extra } = ytDlpBin();
  const dir = await mkdtemp(path.join(process.env["MEDIA_CACHE_DIR"] ?? tmpdir(), "watch-stt-"));
  try {
    try {
      await execFileP(bin, [
        ...extra, "--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "9",
        "--no-progress", "-o", path.join(dir, "audio.%(ext)s"), url,
      ], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      console.error(`[watch] yt-dlp audio failed for ${url}\n${stderr.slice(-2000) || String(err)}`);
      throw new Error(`${lead}, and the audio download failed -- ${diagnoseYtDlp(stderr || String(err))}`);
    }
    const audioPath = path.join(dir, "audio.mp3");
    const size = (await stat(audioPath)).size;
    if (size > STT_MAX_BYTES) throw new Error(`${lead}, and the audio is too large to transcribe here`);
    const buf = await readFile(audioPath);
    return await transcribe(buf, "audio.mp3", 240_000);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── The pipeline ────────────────────────────────────────────────────────────

/** Full one-shot watch. Throws with a human-readable sentence when there is nothing to read. */
export async function runWatchPipeline(
  url: string,
  opts: { companionId: string; sharedBy: string; frontState: string | null; halsethSecret: string } & WatchDeps,
): Promise<WatchResult> {
  const fetched = await fetchVideoCaptions(url);
  const { meta } = fetched;
  const lead = fetched.captionError ? `the caption download failed (${fetched.captionError})` : "no captions on that one";

  let transcriptText: string;
  let source: TranscriptSource;
  if (fetched.vtt) {
    const cues = parseCaptions(fetched.vtt);
    if (cues.length === 0) throw new Error("that link's caption track came back empty -- nothing to read");
    transcriptText = transcriptFromCues(cues, meta.chapters);
    source = fetched.captionKind === "manual" ? "captions" : "auto-captions";
  } else if (opts.transcribe) {
    const raw = await transcribeAudio(url, meta, opts.transcribe, lead);
    if (!raw.trim()) throw new Error(`${lead}, and the audio came back with no speech I could transcribe`);
    transcriptText = paragraphsFromPlainText(raw);
    source = "stt";
  } else if (fetched.captionError) {
    throw new Error(`the caption download failed (${fetched.captionError}), and there's no speech-to-text key on this box to transcribe the audio instead`);
  } else {
    throw new Error("that link has no English captions (manual or automatic), and there's no speech-to-text key on this box to transcribe the audio");
  }

  const sampled = sampleTranscript(transcriptText, watchTranscriptChars());
  const watchedBlock = buildWatchedBlock(meta, sampled, source);

  // Persist (best-effort -- a failed write must not eat the watch). The transcript head goes where lyrics
  // go (the handler caps at 12k); the rest of what we know about the video rides analysis_json.
  const experienceId = await postExperience({
    media_type: "video", url: meta.url, title: meta.title, artist: meta.channel,
    duration_sec: meta.duration_sec, shared_by: opts.sharedBy,
    front_state: opts.frontState, requested_companion: opts.companionId,
    analysis_json: {
      kind: "video", video_id: meta.video_id, channel: meta.channel, upload_date: meta.upload_date,
      categories: meta.categories, language: meta.language, chapters: meta.chapters.slice(0, 60),
      description: cleanVideoDescription(meta.description), transcript_source: source,
      transcript_chars: transcriptText.length, sampled: sampled.sampled, kept_ratio: sampled.kept_ratio,
    },
    lyrics: transcriptText,
  }, opts.halsethSecret);

  return { experienceId, meta, watchedBlock, source, transcript_chars: transcriptText.length, sampled: sampled.sampled };
}
