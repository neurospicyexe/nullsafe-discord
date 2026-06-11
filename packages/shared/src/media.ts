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

export function buildHeardBlock(
  meta: TrackMeta,
  analysis: Record<string, unknown>,
  lyrics: string | null,
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
    lines.push(`Lyrics (excerpt):\n${excerpt}`);
  } else {
    lines.push("Lyrics: none found on LRCLIB.");
  }
  return lines.join("\n");
}

async function fetchLyrics(meta: TrackMeta): Promise<string | null> {
  if (!meta.title) return null;
  const headers = { "User-Agent": UA };
  try {
    const q = new URLSearchParams({ track_name: meta.title });
    if (meta.artist) q.set("artist_name", meta.artist);
    if (meta.duration_sec) q.set("duration", String(Math.round(meta.duration_sec)));
    const exactRes = await fetch(`${LRCLIB_BASE}/get?${q}`, { headers, signal: AbortSignal.timeout(10_000) });
    const exact = exactRes.ok ? await exactRes.json() as { plainLyrics?: string | null } : null;
    if (exact?.plainLyrics?.trim()) return pickLyrics(exact, null);

    const sq = new URLSearchParams({ track_name: meta.title });
    if (meta.artist) sq.set("artist_name", meta.artist);
    const searchRes = await fetch(`${LRCLIB_BASE}/search?${sq}`, { headers, signal: AbortSignal.timeout(10_000) });
    const search = searchRes.ok ? await searchRes.json() as Array<{ plainLyrics?: string | null }> : null;
    return pickLyrics(null, search);
  } catch {
    return null; // lyrics are enrichment, never fatal
  }
}

async function postExperience(payload: Record<string, unknown>): Promise<string | null> {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["ADMIN_SECRET"];
  if (!base || !secret) return null;
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
  const secret = process.env["ADMIN_SECRET"];
  if (!base || !secret) return;
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
    try {
      const { stdout } = await execFileP(YTDLP, [
        "--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
        "--audio-quality", "5", "--print-json", "--no-progress",
        "-o", path.join(jobDir, "track.%(ext)s"), url,
      ], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      info = JSON.parse(stdout.trim().split("\n")[0]!) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`download failed (yt-dlp): ${String(err).slice(0, 300)}`);
    }

    const rawArtist = info["artist"] ?? info["creator"] ?? info["uploader"];
    const meta: TrackMeta = {
      title: String(info["track"] ?? info["title"] ?? "unknown"),
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

    // 3. Lyrics (best-effort).
    const lyrics = await fetchLyrics(meta);

    // 4. Persist to Halseth (best-effort -- a failed write must not eat the listen).
    const experienceId = await postExperience({
      media_type: "song", url, title: meta.title, artist: meta.artist,
      duration_sec: meta.duration_sec, shared_by: opts.sharedBy,
      front_state: opts.frontState, requested_companion: opts.companionId,
      analysis_json: analysis, lyrics,
    });

    return { experienceId, meta, heardBlock: buildHeardBlock(meta, analysis, lyrics) };
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}
