// captions.ts -- pure SRT / WebVTT parser for the Watchalong (spec 2026-10-02).
//
// The triad never sees the picture. They follow the CAPTION TRACK, and HI/SDH captions are the
// richest text a film has: speaker names, sound cues ("[floorboard creaks]"), music cues ("♪").
// This module turns a caption file into one row per line the companions will be shown, typed
// line / sound / music, so the delivery block can read like a screenplay rather than a subtitle dump.
//
// Pure: no I/O, no clock. Every quirk handled here is one we have seen in a real file:
//   * SRT uses `00:01:02,500`; VTT uses `00:01:02.500` and may drop the hours (`01:02.500`).
//   * VTT cue lines carry settings after the timestamp (`align:start position:0%`), and files open with
//     a `WEBVTT` header (sometimes `WEBVTT - title`) plus NOTE / STYLE / REGION blocks.
//   * Formatting: `<i>`, `<b>`, `<font color=..>`, VTT `<c.colour>`, `<v Speaker>` voice tags, and
//     ASS positioning overrides like `{\an8}` that some rippers leave in SRTs.
//   * Dialogue dashes: one cue holding two speakers (`- Hi.\n- Hey.`) becomes two cues at one time.
//   * yt-dlp auto-subs ROLL: each cue repeats the previous line and adds a new one, with inline karaoke
//     timing tags (`<00:00:01.280><c> word</c>`). Without the dedupe the film arrives three times over.

export type CueKind = "line" | "sound" | "music";

export interface Cue {
  start_sec: number;
  end_sec: number;
  kind: CueKind;
  speaker?: string;
  text: string;
}

export interface CaptionSummary {
  total: number;
  lines: number;
  sound: number;
  music: number;
  duration_sec: number;
}

/** Server caps text at 500 chars; we cap first so nothing is silently cut mid-word server-side. */
export const CUE_TEXT_MAX = 500;

const TIME_RE = /((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

/** "01:02:03,450" / "02:03.450" / "1:02:03" -> seconds. NaN on garbage. */
export function parseCaptionTimestamp(s: string): number {
  const m = s.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
  "&lrm;": "", "&rlm;": "",
};

/** Strip markup from ONE caption line. Returns the bare text and a `<v Name>` voice speaker if any. */
export function cleanCaptionLine(raw: string): { text: string; voice: string | null } {
  let s = raw;
  let voice: string | null = null;
  const v = s.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/i);
  if (v) voice = v[1]!.trim() || null;
  s = s
    .replace(/\{\\[^}]*\}/g, "")                 // {\an8} {\i1} ASS overrides
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, "") // <00:00:01.280> karaoke timing
    .replace(/<\/?[a-z][^>]*>/gi, "")            // <i> <b> <font ..> <c.x> <v X> </c>
    .replace(/&[a-z#0-9]+;/gi, e => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/[​-‏‪-‮﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text: s, voice };
}

const MUSIC_WORD_RE = /\b(music|musical|song|songs|singing|sings|humming|hums|hum|melody|tune|lullaby)\b/i;
const MUSIC_NOTE_RE = /[♪♫♩♬]/;

/** Wholly bracketed or parenthesised: "[floorboard creaks]", "(door slams)". Returns the inside. */
function wholeBracket(text: string): string | null {
  const m = text.match(/^\[([^\]]*)\]$/) ?? text.match(/^\(([^)]*)\)$/);
  return m ? m[1]!.trim() : null;
}

/** A speaker label: caps NAME, optionally with a numeral or a parenthetical ("MAN 2", "KEVIN (WHISPERS)"). */
const CAPS_SPEAKER_RE = /^([A-Z][A-Z0-9'’.\- ]{0,30}?[A-Z0-9])(?:\s*\(([^)]*)\))?:\s+(\S[\s\S]*)$/;
const BRACKET_SPEAKER_RE = /^\[([^\]]{1,32})\]\s*(?::\s*)?(\S[\s\S]*)$/;

/** "KEVIN", "MAN 2", "Kevin", "Old Woman" -- yes. "GASPS", "WHISPERING", "door creaks" -- no. */
function looksLikeName(inner: string): boolean {
  const words = inner.trim().split(/\s+/);
  if (words.length === 0 || words.length > 3) return false;
  if (!words.every(w => /^[A-Z0-9][A-Za-z0-9'’.\-]*$/.test(w))) return false;
  const last = words[words.length - 1]!;
  return !(last.length > 3 && /(?:ING|S|ED)$/i.test(last));
}

/** Classify one cleaned line into kind/speaker/text. Null when nothing is left to say. */
export function classifyCaptionText(text: string, voice: string | null = null): { kind: CueKind; speaker?: string; text: string } | null {
  let t = text.trim();
  if (!t) return null;
  let speaker: string | undefined = voice ?? undefined;

  const inner = wholeBracket(t);
  if (inner !== null) {
    if (!inner) return null;
    // Wholly bracketed is always a cue, never a speaker: SDH writes sounds in caps too ("[GASPS]").
    const kind: CueKind = MUSIC_WORD_RE.test(inner) || MUSIC_NOTE_RE.test(inner) ? "music" : "sound";
    return { kind, text: inner };
  }

  // Speaker prefixes. Bracketed first ("[KEVIN] Where's Dad?"), then "KEVIN: Where's Dad?".
  // A bracketed prefix that reads as an action ("[GASPS] Kevin?", "[whispering] Kevin?") is NOT a
  // speaker; it stays in the line's text, where it still tells the companion how it was said.
  const b = t.match(BRACKET_SPEAKER_RE);
  if (b && looksLikeName(b[1]!)) {
    speaker = b[1]!.trim();
    t = b[2]!.trim();
  } else {
    const c = t.match(CAPS_SPEAKER_RE);
    if (c && /[A-Z]{2}/.test(c[1]!)) {
      speaker = c[1]!.trim();
      t = c[3]!.trim();
    }
  }
  if (!t) return null;

  if (MUSIC_NOTE_RE.test(t)) return { kind: "music", ...(speaker ? { speaker } : {}), text: t };
  // A speaker followed only by a bracketed cue: "KEVIN: [whispers]" -- keep it as his line.
  return { kind: "line", ...(speaker ? { speaker } : {}), text: t };
}

interface RawBlock { start: number; end: number; lines: string[] }

/** Split a caption file into timed blocks. Works for both SRT and VTT: a block is whatever follows a
 *  `-->` line until the next blank line. Index lines, cue ids, NOTE/STYLE/REGION blocks fall away. */
function rawBlocks(input: string): RawBlock[] {
  const lines = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out: RawBlock[] = [];
  let cur: RawBlock | null = null;
  for (const line of lines) {
    const tm = line.match(TIME_RE);
    if (tm) {
      if (cur) out.push(cur);
      const start = parseCaptionTimestamp(tm[1]!);
      const end = parseCaptionTimestamp(tm[2]!);
      cur = Number.isFinite(start) && Number.isFinite(end) ? { start, end: Math.max(end, start), lines: [] } : null;
      continue;
    }
    if (line.trim() === "") {
      // A truly empty line ends the cue. A whitespace-only line ends it too (SRTs with trailing spaces on
      // the separator) -- EXCEPT as the first text line, where yt-dlp auto-subs put a lone " " above the
      // words; ending there would orphan every rolling cue's new line.
      if (cur && (line === "" || cur.lines.length > 0)) { out.push(cur); cur = null; }
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out;
}

const DASH_RE = /^\s*[-–—]\s*/;

/**
 * Parse SRT or WebVTT text into ordered cues. Pure.
 *
 * Order of operations matters: markup is stripped first (so `<i>- Hi.</i>` still splits), then rolling
 * repeats are dropped (yt-dlp), then dialogue dashes split the block, and only then is each piece
 * classified -- a dash line can be its own sound cue ("- [gasps]").
 */
export function parseCaptions(input: string): Cue[] {
  const cues: Cue[] = [];
  let prevBlockLast: string | null = null;
  let lastEmitted: string | null = null;

  for (const block of rawBlocks(input)) {
    let cleaned = block.lines.map(cleanCaptionLine).filter(l => l.text.length > 0);
    // Rolling auto-subs: the first line repeats the previous block's last line. Drop it.
    if (prevBlockLast !== null && cleaned.length > 1 && cleaned[0]!.text === prevBlockLast) {
      cleaned = cleaned.slice(1);
    }
    if (cleaned.length === 0) continue;
    prevBlockLast = cleaned[cleaned.length - 1]!.text;

    // Group into utterances: a dash starts a new one; a wholly-bracketed line ("[door creaks]") stands
    // alone; anything else continues the previous line (two-line wrapping of one sentence).
    const hasDash = cleaned.some(l => DASH_RE.test(l.text));
    const pieces: Array<{ text: string; voice: string | null }> = [];
    for (const l of cleaned) {
      const isDash = hasDash && DASH_RE.test(l.text);
      const text = isDash ? l.text.replace(DASH_RE, "") : l.text;
      const prev = pieces[pieces.length - 1];
      if (isDash || !prev || wholeBracket(text) !== null || wholeBracket(prev.text) !== null) {
        pieces.push({ text, voice: l.voice });
      } else {
        prev.text = `${prev.text} ${text}`;
        if (!prev.voice) prev.voice = l.voice;
      }
    }

    for (const p of pieces) {
      const c = classifyCaptionText(p.text, p.voice);
      if (!c) continue;
      const text = c.text.length > CUE_TEXT_MAX ? c.text.slice(0, CUE_TEXT_MAX - 1).trimEnd() + "…" : c.text;
      const key = `${c.speaker ?? ""}|${text}`;
      // Identical consecutive text (auto-sub rolling repeat, or a ripper that split one cue in two).
      if (key === lastEmitted) {
        const last = cues[cues.length - 1];
        if (last) last.end_sec = Math.max(last.end_sec, block.end);
        continue;
      }
      lastEmitted = key;
      cues.push({ start_sec: round3(block.start), end_sec: round3(block.end), kind: c.kind, ...(c.speaker ? { speaker: c.speaker } : {}), text });
    }
  }

  cues.sort((a, b) => a.start_sec - b.start_sec);
  return cues;
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }

export function summarizeCues(cues: Cue[]): CaptionSummary {
  let lines = 0, sound = 0, music = 0, duration = 0;
  for (const c of cues) {
    if (c.kind === "line") lines++; else if (c.kind === "sound") sound++; else music++;
    if (c.end_sec > duration) duration = c.end_sec;
  }
  return { total: cues.length, lines, sound, music, duration_sec: duration };
}
