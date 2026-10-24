// The watch pipeline (video.ts, 2026-10-23): a YouTube video is WORDS, read from its caption track, not a
// song pushed through the music pipe. These cover the pure parts: info-dict parsing, caption-file choice,
// cues -> transcript, sampling a long transcript without losing its arc, the block the bot reads, and the
// markers STM keeps instead of the transcript.

import { describe, it, expect } from "@jest/globals";
import {
  parseVideoInfo, manualCaptionLangs, pickCaptionFile, CAPTION_LANGS,
  transcriptFromCues, paragraphsFromPlainText, sampleTranscript, formatTimestamp,
  buildWatchedBlock, cleanVideoDescription, watchedStmMarker, notWatchedStmMarker, notWatchedBlock,
  isYouTubeUrl, isWatchEnabled, watchTranscriptChars, watchSttMaxSec,
  type VideoMeta,
} from "../video.js";
import { parseCaptions } from "../captions.js";

/** Real shape from the 2026-10-23 VPS probe (3Blue1Brown, aircAruvnKk), trimmed. */
const INFO_JSON = JSON.stringify({
  id: "aircAruvnKk",
  title: "But what is a neural network? | Deep learning chapter 1",
  description: "What are the neurons, why are there layers, and what is the math underlying it?\nHelp fund future projects: https://www.patreon.com/3blue1brown\nTwitter: https://twitter.com/3blue1brown\n\nAdditional funding for this project was provided by Amplify Partners",
  duration: 1120,
  uploader: "3Blue1Brown",
  channel: "3Blue1Brown",
  upload_date: "20171005",
  categories: ["Education"],
  chapters: [
    { start_time: 0, end_time: 67, title: "Introduction example" },
    { start_time: 67, end_time: 162, title: "Series preview" },
    { start_time: 162, end_time: 215, title: "What are neurons?" },
  ],
  webpage_url: "https://www.youtube.com/watch?v=aircAruvnKk",
  language: "en-US",
});

const meta = (over: Partial<VideoMeta> = {}): VideoMeta => ({
  ...parseVideoInfo(INFO_JSON, "https://youtu.be/aircAruvnKk"), ...over,
});

describe("parseVideoInfo -- the info dict yt-dlp prints", () => {
  it("reads the fields the block needs and normalises the date", () => {
    const m = meta();
    expect(m.video_id).toBe("aircAruvnKk");
    expect(m.title).toMatch(/neural network/);
    expect(m.channel).toBe("3Blue1Brown");
    expect(m.duration_sec).toBe(1120);
    expect(m.upload_date).toBe("2017-10-05");
    expect(m.categories).toEqual(["Education"]);
    expect(m.chapters).toHaveLength(3);
    expect(m.chapters[2]).toEqual({ start_sec: 162, title: "What are neurons?" });
    expect(m.url).toBe("https://www.youtube.com/watch?v=aircAruvnKk");
  });

  it("never throws on junk: title falls back, url is the one given", () => {
    const m = parseVideoInfo("not json", "https://youtu.be/x");
    expect(m.title).toBe("untitled video");
    expect(m.url).toBe("https://youtu.be/x");
    expect(m.chapters).toEqual([]);
    expect(m.categories).toEqual([]);
  });

  it("manualCaptionLangs reads the keys of %(subtitles)j and tolerates junk", () => {
    expect(manualCaptionLangs(JSON.stringify({ en: [{ ext: "vtt" }], fr: [] }))).toEqual(["en", "fr"]);
    expect(manualCaptionLangs("{}")).toEqual([]);
    expect(manualCaptionLangs("nope")).toEqual([]);
    expect(manualCaptionLangs("[1,2]")).toEqual([]);
  });
});

describe("caption track selection", () => {
  it("asks for explicit English codes, never the en.* glob (4,842 auto-translated tracks + a 429)", () => {
    expect(CAPTION_LANGS).toContain("en");
    expect(CAPTION_LANGS).toContain("en-orig");
    expect(CAPTION_LANGS.join(",")).not.toContain("*");
  });

  it("prefers plain en, then regional, then en-orig, then anything that landed", () => {
    expect(pickCaptionFile(["subs.en-orig.vtt", "subs.en.vtt", "subs.en-US.vtt"])).toBe("subs.en.vtt");
    expect(pickCaptionFile(["subs.en-orig.vtt", "subs.en-US.vtt"])).toBe("subs.en-US.vtt");
    expect(pickCaptionFile(["subs.en-orig.vtt"])).toBe("subs.en-orig.vtt");
    expect(pickCaptionFile(["subs.en-GB.vtt", "subs.de.vtt"])).toBe("subs.en-GB.vtt");
    expect(pickCaptionFile(["subs.de.vtt"])).toBe("subs.de.vtt");
    expect(pickCaptionFile(["info.json"])).toBeNull();
    expect(pickCaptionFile([])).toBeNull();
  });
});

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:04.220 --> 00:00:05.400
This is a 3.

00:00:06.060 --> 00:00:10.713
It's sloppily written and rendered at a low resolution,

00:00:10.713 --> 00:00:13.720
but your brain has no trouble recognizing it as a 3.

00:01:08.000 --> 00:01:10.000
Here is where the series goes.

00:01:12.000 --> 00:01:14.000
[applause]

00:02:45.000 --> 00:02:50.000
So what is a neuron? A thing that holds a number.
`;

describe("transcriptFromCues", () => {
  it("timestamps paragraphs, names chapters where the uploader put them, keeps sound cues bracketed", () => {
    const t = transcriptFromCues(parseCaptions(VTT), meta().chapters);
    const lines = t.split("\n");
    expect(lines[0]).toBe("## [0:00] Introduction example");
    expect(lines[1]).toMatch(/^\[0:04\] This is a 3\. It's sloppily written/);
    // Chapter 2 starts at 67s: the 68s cue lands under it.
    const idx = lines.indexOf("## [1:07] Series preview");
    expect(idx).toBeGreaterThan(0);
    expect(lines[idx + 1]).toMatch(/^\[1:08\] Here is where the series goes\. \[applause\]/);
    expect(lines).toContain("## [2:42] What are neurons?");
    expect(lines[lines.length - 1]).toMatch(/^\[2:45\] So what is a neuron\?/);
  });

  it("without chapters it is just timestamped paragraphs, one per ~40s of speech", () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({
      start_sec: i * 10, end_sec: i * 10 + 9, kind: "line" as const, text: `Sentence ${i}.`,
    }));
    const t = transcriptFromCues(cues, []);
    const stamps = t.split("\n").map(l => l.match(/^\[(\d+:\d{2})\]/)?.[1]);
    expect(stamps).toEqual(["0:00", "0:40", "1:20"]);
    expect(t).not.toContain("## ");
  });

  it("keeps a speaker where the captions name one", () => {
    const t = transcriptFromCues([{ start_sec: 1, end_sec: 2, kind: "line", speaker: "KEVIN", text: "Where's Dad?" }], []);
    expect(t).toBe("[0:01] KEVIN: Where's Dad?");
  });

  it("formatTimestamp rolls to hours", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(65.9)).toBe("1:05");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });

  it("paragraphsFromPlainText groups STT prose into readable paragraphs", () => {
    const p = paragraphsFromPlainText("One. Two! Three? Four. Five. Six. Seven.", 3);
    expect(p.split("\n")).toEqual(["One. Two! Three?", "Four. Five. Six.", "Seven."]);
  });
});

describe("sampleTranscript -- fit the budget without losing the arc", () => {
  const long = (): string => {
    const out: string[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 30 === 0) out.push(`## [${formatTimestamp(i * 40)}] Chapter ${i / 30 + 1}`);
      out.push(`[${formatTimestamp(i * 40)}] ${"word ".repeat(40).trim()} para ${i}.`);
    }
    return out.join("\n");
  };

  it("returns the text untouched when it fits", () => {
    const r = sampleTranscript("[0:00] short.", 1000);
    expect(r).toEqual({ text: "[0:00] short.", sampled: false, kept_ratio: 1 });
  });

  it("keeps every chapter header, spreads kept paragraphs across the whole runtime, marks each gap", () => {
    const src = long();
    const r = sampleTranscript(src, 6000);
    expect(r.sampled).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(6000);
    for (let c = 1; c <= 4; c++) expect(r.text).toContain(`Chapter ${c}`);
    // Coverage is the point: the LAST stretch of the video is represented, not only the head.
    const stamps = [...r.text.matchAll(/^\[(\d+:\d{2}(?::\d{2})?)\] word/gm)].map(m => m[1]);
    expect(stamps.length).toBeGreaterThan(5);
    expect(stamps[0]).toBe("0:00");
    expect(stamps[stamps.length - 1]).toMatch(/^1:\d{2}:\d{2}$/); // past the one-hour mark (120 * 40s = 80 min)
    expect(r.text).toMatch(/\[… skipped \d+:\d{2}(?::\d{2})?–\d+:\d{2}(?::\d{2})? …\]/);
    expect(r.kept_ratio).toBeGreaterThan(0.1);
    expect(r.kept_ratio).toBeLessThan(1);
  });

  it("is honest about a hard cut when a single paragraph is bigger than the budget", () => {
    const src = `[0:00] ${"a".repeat(5000)}\n[0:40] ${"b".repeat(5000)}`;
    const r = sampleTranscript(src, 3000);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.text).toContain("[… transcript cut");
  });
});

describe("buildWatchedBlock -- what the bot reads", () => {
  it("leads with the video, the channel, the runtime; then facts, description, chapters, transcript, the rule", () => {
    const b = buildWatchedBlock(meta(), { text: "[0:04] This is a 3.", sampled: false, kept_ratio: 1 }, "captions");
    const lines = b.split("\n");
    expect(lines[0]).toBe("Video: But what is a neural network? | Deep learning chapter 1 -- 3Blue1Brown (18:40)");
    expect(lines[1]).toBe("published 2017-10-05; YouTube files it under Education");
    expect(b).toContain("About (the uploader's description, trimmed): What are the neurons, why are there layers");
    // Links and bare social lines are gone from the description.
    expect(b).not.toContain("patreon.com");
    expect(b).not.toMatch(/Twitter:/);
    expect(b).toContain("Chapters (3):\n  [0:00] Introduction example\n  [1:07] Series preview\n  [2:42] What are neurons?");
    expect(b).toContain("Transcript (the uploader's own captions; complete):\n[0:04] This is a 3.");
    expect(b).toMatch(/you have read it, you have not seen the picture/);
    expect(b).toMatch(/Do not invent lines that are not here/);
  });

  it("says when the captions are automatic or STT, and when the transcript is sampled", () => {
    const auto = buildWatchedBlock(meta(), { text: "x", sampled: true, kept_ratio: 0.42 }, "auto-captions");
    expect(auto).toContain("YouTube's automatic captions");
    expect(auto).toContain("SAMPLED -- about 42% of the words");
    const stt = buildWatchedBlock(meta({ chapters: [], description: null, categories: [], upload_date: null }), { text: "x", sampled: false, kept_ratio: 1 }, "stt");
    expect(stt).toContain("speech-to-text from the audio");
    expect(stt).not.toContain("Chapters");
    expect(stt).not.toContain("About (");
    expect(stt.split("\n")[1]).toMatch(/^Transcript \(/); // no facts line when there are no facts
  });

  it("cleanVideoDescription strips links, drops bare social lines, caps length", () => {
    expect(cleanVideoDescription(null)).toBeNull();
    expect(cleanVideoDescription("https://only.a/link")).toBeNull();
    expect(cleanVideoDescription("Real sentence.\nInstagram: https://ig.example/x\nMerch -\nAnother.")).toBe("Real sentence. Another.");
    const long = cleanVideoDescription("w ".repeat(1000));
    expect(long!.length).toBeLessThanOrEqual(700);
    expect(long!.endsWith("…")).toBe(true);
  });
});

describe("markers and the grounding backstop", () => {
  it("STM keeps a one-line past-tense marker, never the transcript", () => {
    expect(watchedStmMarker(meta())).toBe("[shared a video you watched at the time: But what is a neural network? | Deep learning chapter 1 (3Blue1Brown)]");
    expect(watchedStmMarker(meta({ channel: null }))).toBe("[shared a video you watched at the time: But what is a neural network? | Deep learning chapter 1]");
    expect(notWatchedStmMarker()).toBe("[shared a video link; the watch pipeline did not run]");
  });

  it("[NOT WATCHED] names the command that would fix it", () => {
    const b = notWatchedBlock("dre");
    expect(b).toMatch(/^\[NOT WATCHED/);
    expect(b).toContain('"dre: watch <url>"');
    expect(b).toMatch(/do not claim to have seen it/);
  });

  it("isYouTubeUrl: watch / shorts / live / youtu.be yes; a channel page or another site no", () => {
    expect(isYouTubeUrl("look https://www.youtube.com/watch?v=aircAruvnKk ok")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/aircAruvnKk?si=abc")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/shorts/abc123")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/live/abc123")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/@3blue1brown")).toBe(false);
    expect(isYouTubeUrl("https://soundcloud.com/x/y")).toBe(false);
    expect(isYouTubeUrl("no link here")).toBe(false);
  });
});

describe("knobs", () => {
  it("MEDIA_WATCH_ENABLED defaults ON and only the usual words turn it off", () => {
    expect(isWatchEnabled({})).toBe(true);
    expect(isWatchEnabled({ MEDIA_WATCH_ENABLED: "true" })).toBe(true);
    expect(isWatchEnabled({ MEDIA_WATCH_ENABLED: "banana" })).toBe(true);
    for (const v of ["off", "0", "false", "no", " OFF "]) expect(isWatchEnabled({ MEDIA_WATCH_ENABLED: v })).toBe(false);
  });

  it("WATCH_TRANSCRIPT_CHARS / WATCH_STT_MAX_SEC: defaults, floors, junk", () => {
    expect(watchTranscriptChars({})).toBe(12_000);
    expect(watchTranscriptChars({ WATCH_TRANSCRIPT_CHARS: "20000" })).toBe(20_000);
    expect(watchTranscriptChars({ WATCH_TRANSCRIPT_CHARS: "500" })).toBe(12_000); // below the floor
    expect(watchTranscriptChars({ WATCH_TRANSCRIPT_CHARS: "lots" })).toBe(12_000);
    expect(watchSttMaxSec({})).toBe(1_500);
    expect(watchSttMaxSec({ WATCH_STT_MAX_SEC: "600" })).toBe(600);
    expect(watchSttMaxSec({ WATCH_STT_MAX_SEC: "-1" })).toBe(1_500);
  });
});
