import { parseCaptions, parseCaptionTimestamp, cleanCaptionLine, classifyCaptionText, summarizeCues } from "../captions.js";

// A realistic SDH .srt: index lines, CRLF, BOM, {\an8}, <i>, dash dialogue, NAME: speakers,
// sound cues in both bracket styles and both cases, ♪ music, bracket music, a multi-line sentence.
const SDH_SRT = "﻿" + [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "[floorboard creaks]",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "{\\an8}<i>KEVIN: Where's Dad?</i>",
  "",
  "3",
  "00:00:07,000 --> 00:00:09,000",
  "- Kaylee?",
  "- I can't see.",
  "",
  "4",
  "00:00:10,000 --> 00:00:12,000",
  "♪ eerie lullaby playing ♪",
  "",
  "5",
  "00:00:13,000 --> 00:00:15,000",
  "[static humming]",
  "",
  "6",
  "00:00:16,000 --> 00:00:18,000",
  "(DOOR SLAMS)",
  "",
  "7",
  "00:00:19,000 --> 00:00:22,000",
  "I don't know where",
  "the doors went.",
  "",
  "8",
  "00:00:23,000 --> 00:00:25,000",
  "[Kevin] Mom?",
  "",
  "9",
  "00:00:26,000 --> 00:00:28,000",
  "[GASPS] Kevin?",
  "",
  "10",
  "00:00:29,000 --> 00:00:31,000",
  "- [gasps]",
  "- KAYLEE: Shh.",
  "",
  "11",
  "00:00:32,000 --> 00:00:33,000",
  "<font color=\"#ffff00\">&lt;faint&gt; whisper &amp; hiss</font>",
  "",
].join("\r\n");

describe("parseCaptionTimestamp", () => {
  test("SRT comma, VTT dot, VTT without hours", () => {
    expect(parseCaptionTimestamp("01:02:03,450")).toBeCloseTo(3723.45);
    expect(parseCaptionTimestamp("01:02:03.450")).toBeCloseTo(3723.45);
    expect(parseCaptionTimestamp("02:03.5")).toBeCloseTo(123.5);
    expect(Number.isNaN(parseCaptionTimestamp("nope"))).toBe(true);
  });
});

describe("cleanCaptionLine", () => {
  test("strips ASS overrides, html tags, entities, VTT karaoke timing", () => {
    expect(cleanCaptionLine("{\\an8}<i>Hello</i>").text).toBe("Hello");
    expect(cleanCaptionLine("<00:00:01.280><c> how</c><00:00:01.500><c> are</c>").text).toBe("how are");
    expect(cleanCaptionLine("a &amp; b").text).toBe("a & b");
  });
  test("reads a <v Name> voice tag as the speaker", () => {
    expect(cleanCaptionLine("<v Kevin>Where's Dad?</v>")).toEqual({ text: "Where's Dad?", voice: "Kevin" });
  });
});

describe("classifyCaptionText", () => {
  test("wholly bracketed = sound, brackets removed", () => {
    expect(classifyCaptionText("[floorboard creaks]")).toEqual({ kind: "sound", text: "floorboard creaks" });
    expect(classifyCaptionText("(DOOR SLAMS)")).toEqual({ kind: "sound", text: "DOOR SLAMS" });
    expect(classifyCaptionText("[GASPS]")).toEqual({ kind: "sound", text: "GASPS" });
  });
  test("music via notes or a bracket naming music/song/humming", () => {
    expect(classifyCaptionText("♪ la la ♪")?.kind).toBe("music");
    expect(classifyCaptionText("[eerie music playing]")?.kind).toBe("music");
    expect(classifyCaptionText("[humming]")?.kind).toBe("music");
    expect(classifyCaptionText("[song continues]")?.kind).toBe("music");
  });
  test("NAME: and [Name] prefixes become the speaker", () => {
    expect(classifyCaptionText("KEVIN: Where's Dad?")).toEqual({ kind: "line", speaker: "KEVIN", text: "Where's Dad?" });
    expect(classifyCaptionText("MAN 2: Over here.")).toEqual({ kind: "line", speaker: "MAN 2", text: "Over here." });
    expect(classifyCaptionText("[Kevin] Mom?")).toEqual({ kind: "line", speaker: "Kevin", text: "Mom?" });
  });
  test("an action in brackets before speech is not a speaker", () => {
    expect(classifyCaptionText("[GASPS] Kevin?")).toEqual({ kind: "line", text: "[GASPS] Kevin?" });
    expect(classifyCaptionText("[whispering] Kevin?")).toEqual({ kind: "line", text: "[whispering] Kevin?" });
  });
  test("a time or a lowercase colon is not a speaker", () => {
    expect(classifyCaptionText("Note: it's late.")).toEqual({ kind: "line", text: "Note: it's late." });
  });
  test("empty -> null", () => {
    expect(classifyCaptionText("   ")).toBeNull();
    expect(classifyCaptionText("[]")).toBeNull();
  });
});

describe("parseCaptions (SRT, SDH)", () => {
  const cues = parseCaptions(SDH_SRT);

  test("every cue is typed, timed and cleaned", () => {
    expect(cues.map(c => [c.start_sec, c.kind, c.speaker ?? null, c.text])).toEqual([
      [1, "sound", null, "floorboard creaks"],
      [4, "line", "KEVIN", "Where's Dad?"],
      [7, "line", null, "Kaylee?"],
      [7, "line", null, "I can't see."],
      [10, "music", null, "♪ eerie lullaby playing ♪"],
      [13, "music", null, "static humming"],
      [16, "sound", null, "DOOR SLAMS"],
      [19, "line", null, "I don't know where the doors went."],
      [23, "line", "Kevin", "Mom?"],
      [26, "line", null, "[GASPS] Kevin?"],
      [29, "sound", null, "gasps"],
      [29, "line", "KAYLEE", "Shh."],
      [32, "line", null, "<faint> whisper & hiss"],
    ]);
  });

  test("summary counts kinds and takes duration from the last end", () => {
    expect(summarizeCues(cues)).toEqual({ total: 13, lines: 8, sound: 3, music: 2, duration_sec: 33 });
  });
});

describe("parseCaptions (WebVTT)", () => {
  test("header, NOTE/STYLE blocks, cue ids, cue settings, mm:ss timestamps, voice tags", () => {
    const vtt = [
      "WEBVTT - Skinamarink",
      "Kind: captions",
      "Language: en",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "NOTE this is a comment",
      "with two lines",
      "",
      "intro-1",
      "00:01.000 --> 00:03.000 align:start position:0% line:85%",
      "<c.yellow>[TV static]</c>",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "<v Kevin>I'm scared.</v>",
      "",
    ].join("\n");
    expect(parseCaptions(vtt)).toEqual([
      { start_sec: 1, end_sec: 3, kind: "sound", text: "TV static" },
      { start_sec: 4, end_sec: 6, kind: "line", speaker: "Kevin", text: "I'm scared." },
    ]);
  });

  test("yt-dlp auto-sub rolling repeats are deduped", () => {
    // The real yt-dlp shape: each cue repeats the previous line, plus a 10ms "settle" cue holding only
    // the previous text, plus inline word timing on the new line.
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.160 --> 00:00:02.270 align:start position:0%",
      " ",
      "hello<00:00:00.480><c> there</c><00:00:00.800><c> kids</c>",
      "",
      "00:00:02.270 --> 00:00:02.280 align:start position:0%",
      "hello there kids",
      " ",
      "",
      "00:00:02.280 --> 00:00:04.590 align:start position:0%",
      "hello there kids",
      "where<00:00:02.600><c> is</c><00:00:02.900><c> everyone</c>",
      "",
      "00:00:04.590 --> 00:00:04.600 align:start position:0%",
      "where is everyone",
      " ",
      "",
    ].join("\n");
    const cues = parseCaptions(vtt);
    expect(cues.map(c => c.text)).toEqual(["hello there kids", "where is everyone"]);
    expect(cues[0]!.start_sec).toBeCloseTo(0.16);
    expect(cues[1]!.start_sec).toBeCloseTo(2.28);
  });

  test("garbage in, nothing out", () => {
    expect(parseCaptions("not a caption file at all")).toEqual([]);
    expect(parseCaptions("")).toEqual([]);
  });

  test("caps very long text", () => {
    const long = "word ".repeat(200);
    const cues = parseCaptions(`1\n00:00:01,000 --> 00:00:02,000\n${long}\n`);
    expect(cues[0]!.text.length).toBeLessThanOrEqual(500);
  });
});
