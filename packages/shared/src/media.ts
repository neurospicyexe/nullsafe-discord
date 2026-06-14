// media.ts -- shared-experience Phase 1 (Ears): listen pipeline.
//
// Owner says `cy: listen <url>` -> this module (running on the VPS alongside the
// bots) downloads audio via yt-dlp, analyzes via hear-music, fetches LRCLIB
// lyrics, writes a media_experiences row to Halseth, and returns a compact
// "heard block" the bot appends to the message content so the normal reply path
// answers having actually heard the track.
//
// Env: MEDIA_LISTEN_ENABLED=true gate; YTDLP_PATH / HEAR_MUSIC_PATH override
// binary locations (pm2 children don't get a login PATH -- use absolute paths);
// MEDIA_CACHE_DIR (default /tmp/ns-media). Audio is deleted after analysis --
// only JSON persists.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const execFileP = promisify(execFile);

const LRCLIB_BASE = "https://lrclib.net/api";
const UA = "nullsafe-triad/1.0 (companion listening pipeline)";

export interface TrackMeta {
  title: string;
  artist: string | null;
  duration_sec: number | null;
  url?: string;
  // The full, un-cleaned source title (e.g. the raw YouTube video title). Display uses
  // the cleaned `title`, but lyrics search/validation needs the disambiguators that
  // cleaning strips ("ft. Lestat de Lioncourt", "The Vampire Lestat") -- without them a
  // generic title like "All Fall Down" cross-matches a different band's song.
  rawTitle?: string;
}

export interface ListenResult {
  experienceId: string | null; // null if the Halseth write failed (non-fatal)
  meta: TrackMeta;
  heardBlock: string;
}

export function isListenEnabled(): boolean {
  return process.env["MEDIA_LISTEN_ENABLED"] === "true";
}

// Strip bulky per-frame arrays before storing/prompting. chroma (12 floats) stays.
export function compactAnalysis(full: Record<string, unknown>): Record<string, unknown> {
  const { onset_times: _o, notes: _n, files: _f, source: _s, ...rest } = full;
  return rest;
}

export function pickLyrics(
  exact: { plainLyrics?: string | null } | null,
  search: Array<{ plainLyrics?: string | null }> | null,
): string | null {
  if (exact?.plainLyrics?.trim()) return exact.plainLyrics;
  const hit = (search ?? []).find(s => s.plainLyrics?.trim());
  return hit?.plainLyrics ?? null;
}

// YouTube/SoundCloud titles are noisy: `"Song" ft. X (Official Lyric Video) | Show | Network`.
// LRCLIB matches on a bare track name, so the raw video title 404s even for tracks it
// HAS -- and a clip's short duration kills the exact lookup. Strip it down (2026-06-14:
// lyrics silently missing, the companion then claimed the song had none).
export function cleanTrackTitle(raw: string): string {
  let t = (raw.split("|")[0] ?? raw)
    // production noise in ()/[]: (Official Lyric Video), [Remastered], (HD), (Live)...
    .replace(/[([][^)\]]*\b(official|lyric|lyrics|video|audio|visuali[sz]er|remaster(?:ed)?|hd|4k|mv|explicit|live|performance|version|edit|mix)\b[^)\]]*[)\]]/gi, " ")
    // "ft./feat./featuring ..." through end of string
    .replace(/\s*\b(?:ft|feat|featuring)\.?\s.*$/i, "")
    .replace(/["'“”‘’]/g, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

// First artist only ("A, B" -> "A"), drop YouTube's auto " - Topic" suffix.
export function cleanArtist(raw: string): string {
  return (raw.split(",")[0] ?? raw)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/["'“”‘’]/g, "")
    .trim();
}

export function buildHeardBlock(
  meta: TrackMeta,
  analysis: Record<string, unknown>,
  lyrics: string | null,
  lyricsSource: "lrclib" | "web" | null = null,
): string {
  // hear-music emits { tonic, mode, confidence }; older drafts used { name }. Accept both.
  const keyRaw = analysis["key"] as { name?: string; tonic?: string; mode?: string; confidence?: number } | null;
  const keyName = keyRaw?.name ?? (keyRaw?.tonic ? `${keyRaw.tonic}${keyRaw.mode ? ` ${keyRaw.mode}` : ""}` : null);
  const tempo = analysis["tempo_bpm"];
  const tempoNote = analysis["tempo_estimated"] === false ? " (default -- estimation failed)" : "";
  const duration = typeof meta.duration_sec === "number"
    ? `${Math.floor(meta.duration_sec / 60)}:${String(Math.round(meta.duration_sec % 60)).padStart(2, "0")}`
    : null;
  const onsets = analysis["onset_count"];
  const dur = analysis["duration"];
  const density = typeof onsets === "number" && typeof dur === "number" && dur > 0
    ? (onsets / dur).toFixed(1) : null;

  const lines: string[] = [];
  lines.push(`Track: ${meta.title}${meta.artist ? ` -- ${meta.artist}` : ""}${duration ? ` (${duration})` : ""}`);
  if (typeof tempo === "number") lines.push(`Tempo: ~${Math.round(tempo)} BPM${tempoNote}`);
  if (keyName) lines.push(`Key: ${keyName}${typeof keyRaw?.confidence === "number" ? ` (confidence ${keyRaw.confidence})` : ""}`);
  if (density) lines.push(`Onset density: ${density}/sec (${onsets} onsets)`);
  const librosa = analysis["librosa"];
  if (librosa && typeof librosa === "object") {
    lines.push(`Enrichment: ${JSON.stringify(librosa).slice(0, 300)}`);
  }
  if (lyrics) {
    const excerpt = lyrics.split("\n").filter(l => l.trim()).slice(0, 24).join("\n").slice(0, 1600);
    if (lyricsSource === "web") {
      // Web-scraped: partial and possibly imperfect. Tell the companion so it doesn't
      // treat a truncated first verse as the whole song.
      lines.push(`Lyrics (web-sourced, partial/approximate -- not a verified transcript):\n${excerpt}`);
    } else {
      lines.push(`Lyrics (excerpt):\n${excerpt}`);
    }
  } else {
    // A fetch miss is NOT proof the track is instrumental -- neither LRCLIB nor a web
    // search turned up a transcript. The companion previously collapsed this into "the
    // song has no lyrics" on an actual lyric video (2026-06-14). Ground it.
    lines.push(
      "Lyrics: not retrieved -- nothing matched on LRCLIB or web search. This is NOT evidence the track is instrumental or wordless; you simply don't have the words in front of you. Do not claim it has no lyrics -- speak to what you heard in the audio, and you can say you couldn't pull the lyrics.",
    );
  }
  return lines.join("\n");
}

async function fetchLyrics(meta: TrackMeta): Promise<string | null> {
  const title = cleanTrackTitle(meta.title ?? "");
  const artist = meta.artist ? cleanArtist(meta.artist) : null;
  if (!title) return null;
  // We only trust matches that agree on the ARTIST. A blind title-only search returns
  // same-named different songs (search "All Fall Down" -> Lindisfarne, Missing Persons),
  // so handing those back would be WRONG lyrics -- worse than none. With no usable
  // artist, return null and let the heard-block ground honestly.
  if (!artist) return null;
  const headers = { "User-Agent": UA };
  try {
    // Exact get on cleaned title+artist. No duration param -- a teaser/clip's runtime
    // never matches the full track and 404s the whole lookup.
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    const exactRes = await fetch(`${LRCLIB_BASE}/get?${q}`, { headers, signal: AbortSignal.timeout(10_000) });
    const exact = exactRes.ok ? await exactRes.json() as { plainLyrics?: string | null } : null;
    if (exact?.plainLyrics?.trim()) return exact.plainLyrics;

    // Fuzzy search, still artist-scoped so we never cross-match a same-named song.
    const sq = new URLSearchParams({ track_name: title, artist_name: artist });
    const searchRes = await fetch(`${LRCLIB_BASE}/search?${sq}`, { headers, signal: AbortSignal.timeout(10_000) });
    const search = searchRes.ok ? await searchRes.json() as Array<{ plainLyrics?: string | null }> : null;
    return pickLyrics(null, search);
  } catch {
    return null; // lyrics are enrichment, never fatal
  }
}

export interface LyricsResult {
  text: string;
  source: "lrclib" | "web";
  sourceUrl?: string;
}

// Lyrics-bearing domains, in preference order. Tavily snippets from these read
// "<Title> Lyrics: <first verse...>", which carries the actual words.
const LYRICS_DOMAINS = ["genius.com", "musixmatch.com", "azlyrics.com", "lyrics.com", "songlyrics.com", "letras.com"];

// Tavily web-search daily cap (shared free-tier budget with the worker). Listens are
// owner-initiated and rare, so a modest ceiling is plenty; tune via env.
const webLyricsDaily = {
  date: "",
  count: 0,
  take(): boolean {
    const cap = parseInt(process.env["MEDIA_LYRICS_WEB_MAX_PER_DAY"] ?? "20", 10);
    const today = new Date().toISOString().slice(0, 10);
    if (this.date !== today) { this.date = today; this.count = 0; }
    if (this.count >= cap) return false;
    this.count++;
    return true;
  },
};

// Words that carry no disambiguating signal (production noise + stopwords). Used to
// strip the title down to its DISTINCTIVE tokens for validating a web match.
const LYRIC_NOISE = new Set([
  "official", "lyric", "lyrics", "video", "audio", "visualizer", "visualiser",
  "remaster", "remastered", "feat", "ft", "featuring", "the", "and", "with", "mix",
  "edit", "version", "live", "explicit", "performance", "music", "song", "full",
  "hd", "4k", "mv", "ost", "soundtrack", "records", "topic",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length >= 3 && !LYRIC_NOISE.has(t));
}

// Tavily query for lyrics: built from the RAW title (disambiguators intact) minus
// bracketed production noise and pipe-separated network tails. Keeps "ft. <performer>"
// and show context so a generic title resolves to the RIGHT song's page.
export function lyricsSearchQuery(meta: TrackMeta): string {
  const raw = meta.rawTitle ?? meta.title ?? "";
  const q = raw
    .replace(/[([][^)\]]*[)\]]/g, " ") // drop ALL ()/[] bits for the query
    .replace(/[|]/g, " ")
    .replace(/["'“”‘’]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return `${q} lyrics`.trim();
}

// Distinctive tokens that a correct lyrics page should reference. `context` = tokens in
// the raw title that survive noise-stripping but are NOT part of the bare song name
// (the "Lestat de Lioncourt" / "Vampire" disambiguators). `artist` = cleaned-artist
// tokens, the fallback validator when there is no extra context.
export function lyricsContextTokens(meta: TrackMeta): { context: string[]; artist: string[] } {
  const songName = new Set(tokenize(cleanTrackTitle(meta.title ?? "")));
  const raw = meta.rawTitle ?? meta.title ?? "";
  const context = [...new Set(tokenize(raw))].filter(t => !songName.has(t));
  const artist = meta.artist ? [...new Set(tokenize(cleanArtist(meta.artist)))] : [];
  return { context, artist };
}

// Choose a Tavily result we're CONFIDENT is the right song. A blind first-lyrics-domain
// pick served a different band's "All Fall Down" (genius.com/Fangclub...) and the
// companion reacted to wrong words (2026-06-14). Require the result (url+snippet) to
// reference a distinctive context token; with no disambiguator, fall back to artist
// tokens; with neither, REFUSE (return null) rather than risk wrong lyrics.
export function pickWebLyricsResult(
  results: Array<{ url?: string; content?: string }>,
  tokens: { context: string[]; artist: string[] },
): { url?: string; content?: string } | null {
  const validators = tokens.context.length > 0 ? tokens.context : tokens.artist;
  if (validators.length === 0) return null;
  const long = (r: { content?: string }) => (r.content?.trim().length ?? 0) > 40;
  const onLyricsDomain = (u?: string) => !!u && LYRICS_DOMAINS.some(d => u.includes(d));
  const matches = (r: { url?: string; content?: string }) => {
    const hay = `${r.url ?? ""} ${r.content ?? ""}`.toLowerCase();
    return validators.some(t => hay.includes(t));
  };
  return results.find(r => onLyricsDomain(r.url) && long(r) && matches(r))
      ?? results.find(r => /\blyrics?\b/i.test(r.content ?? "") && long(r) && matches(r))
      ?? null;
}

// Pull a lyrics block out of a Tavily result snippet. Snippets label the song
// ("All Fall Down Lyrics: ...") then run lines together with " / " (Genius) or
// " ; " (Musixmatch). Strip the label, restore line breaks. Web-sourced lyrics are
// partial/approximate by nature -- the heard-block flags them as such.
export function extractWebLyrics(snippet: string): string {
  let s = snippet.replace(/^.*?\blyrics?\s*[:\-]\s*/i, ""); // drop leading "… Lyrics:" label
  s = s.replace(/\s*\/\s*/g, "\n").replace(/\s*;\s*/g, "\n"); // line separators -> newlines
  s = s.replace(/\n{2,}/g, "\n").trim();
  return s.slice(0, 1200);
}

// Fallback when LRCLIB has no transcript: Tavily web search, scoped to the cleaned
// title + artist, biased to known lyrics sites. Best-effort, never fatal. Gated by
// TAVILY_API_KEY presence (set MEDIA_LYRICS_WEB=false to disable).
async function fetchLyricsWeb(meta: TrackMeta): Promise<LyricsResult | null> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key || process.env["MEDIA_LYRICS_WEB"] === "false") return null;
  if (!cleanTrackTitle(meta.title ?? "")) return null;
  const tokens = lyricsContextTokens(meta);
  // No distinctive context AND no artist -> we can't tell this "All Fall Down" from any
  // other. Don't even spend a search; ground honestly instead of guessing.
  if (tokens.context.length === 0 && tokens.artist.length === 0) return null;
  if (!webLyricsDaily.take()) {
    console.warn("[media] web-lyrics daily cap reached, skipping Tavily lookup");
    return null;
  }
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query: lyricsSearchQuery(meta),
        search_depth: "basic",
        max_results: 6,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { results?: Array<{ url?: string; content?: string }> };
    const hit = pickWebLyricsResult(data.results ?? [], tokens);
    if (!hit?.content) {
      console.warn(`[media] web lyrics: no result confidently matched "${meta.title}" -- grounding honestly`);
      return null;
    }
    const text = extractWebLyrics(hit.content);
    if (!text || text.length < 20) return null;
    return { text, source: "web", sourceUrl: hit.url };
  } catch {
    return null; // web lyrics are enrichment, never fatal
  }
}

/** LRCLIB first (clean/verbatim), then Tavily web (partial/approximate). */
export async function getLyrics(meta: TrackMeta): Promise<LyricsResult | null> {
  const lrc = await fetchLyrics(meta);
  if (lrc) return { text: lrc, source: "lrclib" };
  return fetchLyricsWeb(meta);
}

async function postExperience(payload: Record<string, unknown>): Promise<string | null> {
  const base = process.env["HALSETH_URL"];
  // VPS bot env carries HALSETH_SECRET (ADMIN_SECRET is the worker-side name).
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[media] halseth write SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return null;
  }
  try {
    const res = await fetch(`${base}/mind/media`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[media] halseth write failed: ${res.status}`);
      return null;
    }
    const body = await res.json() as { experience?: { id?: string } };
    return body.experience?.id ?? null;
  } catch (err) {
    console.error("[media] halseth write error:", err);
    return null;
  }
}

export async function reactToExperience(experienceId: string, companionId: string, reaction: string): Promise<void> {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[media] react SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return;
  }
  const res = await fetch(`${base}/mind/media/${experienceId}/react`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ companion_id: companionId, reaction: reaction.slice(0, 2000) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[media] react write failed: ${res.status}`);
}

// Full pipeline. Throws with a human-readable message on download/analysis failure.
export async function runListenPipeline(
  url: string,
  opts: { companionId: string; sharedBy: string; frontState: string | null },
): Promise<ListenResult> {
  const YTDLP = process.env["YTDLP_PATH"] ?? "yt-dlp";
  const HEAR_MUSIC = process.env["HEAR_MUSIC_PATH"] ?? "hear-music";
  const CACHE_DIR = process.env["MEDIA_CACHE_DIR"] ?? "/tmp/ns-media";
  const jobDir = path.join(CACHE_DIR, randomUUID());
  await mkdir(jobDir, { recursive: true });
  try {
    // 1. Download + metadata in one pass. --print-json emits the info dict on stdout.
    let info: Record<string, unknown>;
    // YTDLP_EXTRA_ARGS: space-separated extras, e.g. "--js-runtimes node:/path/to/node"
    // (YouTube EJS extraction wants a JS runtime; the VPS has nvm node, not deno).
    const extraArgs = (process.env["YTDLP_EXTRA_ARGS"] ?? "").split(" ").filter(Boolean);
    try {
      const { stdout } = await execFileP(YTDLP, [
        ...extraArgs,
        "--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
        "--audio-quality", "5", "--print-json", "--no-progress",
        "-o", path.join(jobDir, "track.%(ext)s"), url,
      ], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      info = JSON.parse(stdout.trim().split("\n")[0]!) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`download failed (yt-dlp): ${String(err).slice(0, 300)}`);
    }

    const rawArtist = info["artist"] ?? info["creator"] ?? info["uploader"];
    // Prefer yt-dlp's parsed `track` (already clean when present); else strip the noisy
    // video `title` so both display and the LRCLIB lookup get a bare track name.
    const meta: TrackMeta = {
      title: info["track"]
        ? String(info["track"])
        : (cleanTrackTitle(String(info["title"] ?? "")) || "unknown"),
      rawTitle: String(info["title"] ?? info["track"] ?? ""),
      artist: rawArtist ? String(rawArtist) : null,
      duration_sec: typeof info["duration"] === "number" ? info["duration"] as number : null,
      url,
    };

    // 2. Analyze. -x --audio-format mp3 produces track.mp3 deterministically.
    const audioPath = path.join(jobDir, "track.mp3");
    const outDir = path.join(jobDir, "out");
    try {
      await execFileP(HEAR_MUSIC, ["analyze", audioPath, "--out-dir", outDir],
        { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`analysis failed (hear-music): ${String(err).slice(0, 300)}`);
    }
    const fullAnalysis = JSON.parse(await readFile(path.join(outDir, "analysis.json"), "utf8")) as Record<string, unknown>;
    const analysis = compactAnalysis(fullAnalysis);

    // 3. Lyrics (best-effort): LRCLIB first, then Tavily web search.
    const lyricsResult = await getLyrics(meta);
    const lyrics = lyricsResult?.text ?? null;
    const lyricsSource = lyricsResult?.source ?? null;

    // 4. Persist to Halseth (best-effort -- a failed write must not eat the listen).
    const experienceId = await postExperience({
      media_type: "song", url, title: meta.title, artist: meta.artist,
      duration_sec: meta.duration_sec, shared_by: opts.sharedBy,
      front_state: opts.frontState, requested_companion: opts.companionId,
      analysis_json: analysis, lyrics,
    });

    return { experienceId, meta, heardBlock: buildHeardBlock(meta, analysis, lyrics, lyricsSource) };
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}
