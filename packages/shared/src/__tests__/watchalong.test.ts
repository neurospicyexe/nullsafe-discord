import {
  parseWatchTime, formatPlayhead, formatCueLine, formatOnScreenBlock, onScreenStmMarker, watchalongStandingLine,
  WatchalongDelivery, handleMovieCommand, handleAtCommand, loadCaptions, NoCaptionsError, readCaptionAttachment,
  watchalongEnabled, normaliseMovieSub, type WatchCueRow,
} from "../watchalong.js";
import { buildCommandTriggers } from "../command-triggers.js";
import { detectWatchProgress, parseWatchPosition } from "../watch-command.js";
import { StmStore } from "../stm.js";

const cypher = buildCommandTriggers(["cy", "cypher"]);
const drevan = buildCommandTriggers(["drevan", "drev", "dre"]);
const gaia = buildCommandTriggers(["gaia"]);

process.env["HALSETH_URL"] = "https://halseth.test";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Call = { url: string; method: string; body: unknown };
function fakeHalseth(handler: (url: URL, method: string, body: unknown) => Response): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.toString(), method, body });
    return handler(url, method, body);
  }) as typeof fetch;
  return { fn, calls };
}

// ── Triggers ────────────────────────────────────────────────────────────────

describe("watchalong triggers", () => {
  test("movie start with a title, any alias, any separator", () => {
    const m = "cy: movie start Skinamarink".match(cypher.movie);
    expect(m?.[1]).toBe("start");
    expect(m?.[2]).toBe("Skinamarink");
    expect("dre: movie start The Blair Witch Project".match(drevan.movie)?.[2]).toBe("The Blair Witch Project");
    expect("Drevan, movie start Skinamarink".match(drevan.movie)?.[2]).toBe("Skinamarink");
    expect("gaia movie start https://youtu.be/abc".match(gaia.movie)?.[2]).toBe("https://youtu.be/abc");
  });

  test("bare movie start matches (attachment-only form); the handler asks for a title if none", () => {
    const m = "cy: movie start".match(cypher.movie);
    expect(m?.[1]).toBe("start");
    expect(m?.[2]).toBeUndefined();
  });

  test("subcommands only as the whole message", () => {
    for (const w of ["pause", "play", "resume", "status", "done", "end", "stop"]) {
      expect(`cy: movie ${w}`.match(cypher.movie)?.[3]?.toLowerCase()).toBe(w);
    }
    expect("dre: movie pause.".match(drevan.movie)?.[3]).toBe("pause");
  });

  test("conversation about movies is NOT a command", () => {
    for (const s of [
      "cy: movie night tonight?",
      "cy: movie was good",
      "cy: movie pause is a good idea honestly",
      "cy: movies are fun",
      "cy: movie starts at 8",
      "dre: the movie start was slow",
    ]) {
      expect(s).not.toMatch(cypher.movie);
      expect(s).not.toMatch(drevan.movie);
    }
  });

  test("at <time> forms", () => {
    expect("cy: at 47:12".match(cypher.movieAt)?.[1]).toBe("47:12");
    expect("dre: at 1:02:03".match(drevan.movieAt)?.[1]).toBe("1:02:03");
    expect("gaia: at 47m".match(gaia.movieAt)?.[1]).toBe("47m");
    expect("cy: at 47 min".match(cypher.movieAt)?.[1]).toBe("47 min");
    expect("cy: at 0:00".match(cypher.movieAt)?.[1]).toBe("0:00");
    expect("cy: at 1h02m".match(cypher.movieAt)?.[1]).toBe("1h02m");
  });

  test("conversation with `at` is NOT a command", () => {
    for (const s of [
      "dre: at least we tried",
      "cy: at 8 tonight?",
      "cy: at 8pm",
      "cy: at 47:12 the dad shows up",
      "dre: at the store",
      "cy: at",
    ]) {
      expect(s).not.toMatch(cypher.movieAt);
      expect(s).not.toMatch(drevan.movieAt);
    }
  });

  test("neither form is in the guard: malformed or conversational forms fall through to talk", () => {
    expect("cy: movie night tonight?").not.toMatch(cypher.guard);
    expect("dre: at least we tried").not.toMatch(drevan.guard);
    expect("cy: movie start Skinamarink").not.toMatch(cypher.guard);
  });

  test("only the addressed bot matches", () => {
    expect("dre: movie start Skinamarink").not.toMatch(cypher.movie);
    expect("dre: at 47:12").not.toMatch(gaia.movieAt);
  });

  test("the passive watch-party detector never reads 47:12 as an episode", () => {
    expect(parseWatchPosition("cy: at 47:12").episode).toBeNull();
    expect(detectWatchProgress("cy: at 47:12", { title: "Fargo", companion: "cypher" })).toBeNull();
    expect(detectWatchProgress("dre: at 1:02:03", { title: "Fargo", companion: "drevan" })).toBeNull();
  });
});

// ── Time + rendering ────────────────────────────────────────────────────────

describe("parseWatchTime / formatPlayhead", () => {
  test("all spec forms", () => {
    expect(parseWatchTime("47:12")).toBe(2832);
    expect(parseWatchTime("1:02:03")).toBe(3723);
    expect(parseWatchTime("47m")).toBe(2820);
    expect(parseWatchTime("47 min")).toBe(2820);
    expect(parseWatchTime("47 minutes")).toBe(2820);
    expect(parseWatchTime("1h02m")).toBe(3720);
    expect(parseWatchTime("1h")).toBe(3600);
    expect(parseWatchTime("0:00")).toBe(0);
    expect(parseWatchTime("120:00")).toBe(7200);
  });
  test("rejects garbage and impossible seconds", () => {
    expect(parseWatchTime("47:72")).toBeNull();
    expect(parseWatchTime("1:62:00")).toBeNull();
    expect(parseWatchTime("soon")).toBeNull();
    expect(parseWatchTime("")).toBeNull();
  });
  test("format", () => {
    expect(formatPlayhead(2832)).toBe("47:12");
    expect(formatPlayhead(3723)).toBe("1:02:03");
    expect(formatPlayhead(5.9)).toBe("0:05");
    expect(formatPlayhead(-3)).toBe("0:00");
    expect(formatPlayhead(NaN)).toBe("0:00");
  });
});

describe("cue rendering", () => {
  const cues: WatchCueRow[] = [
    { start_sec: 2652, kind: "sound", text: "floorboard creaks" },
    { start_sec: 2660, kind: "line", speaker: "KEVIN", text: "Where's Dad?" },
    { start_sec: 2700, kind: "music", text: "♪ lullaby ♪" },
    { start_sec: 2710, kind: "music", text: "eerie music" },
  ];

  test("one line per cue, screenplay-ish", () => {
    expect(cues.map(formatCueLine)).toEqual([
      "[44:12] [floorboard creaks]",
      "[44:20] KEVIN: Where's Dad?",
      "[45:00] ♪ lullaby ♪",
      "[45:10] [eerie music]",
    ]);
  });

  test("block: header, optional skipped line, cues", () => {
    const block = formatOnScreenBlock({ title: "Skinamarink", status: "playing", fromSec: 2650, toSec: 2832, cues, skipped: 3, joining: false });
    expect(block!.split("\n")).toEqual([
      "[ON SCREEN: Skinamarink, 44:10 → 47:12, playing]",
      "(… 3 earlier lines not shown)",
      "[44:12] [floorboard creaks]",
      "[44:20] KEVIN: Where's Dad?",
      "[45:00] ♪ lullaby ♪",
      "[45:10] [eerie music]",
    ]);
  });

  test("empty delta -> nothing", () => {
    expect(formatOnScreenBlock({ title: "X", status: "playing", fromSec: 0, toSec: 10, cues: [], skipped: 0, joining: false })).toBeNull();
  });

  test("STM marker and standing line", () => {
    expect(onScreenStmMarker("Skinamarink", 2832)).toBe("[on screen: Skinamarink to 47:12]");
    const line = watchalongStandingLine({ title: "Skinamarink", status: "playing", playhead_sec: 2832 });
    expect(line).toContain("Skinamarink, 47:12 in, playing");
    expect(line).toContain("don't search the film");
  });
});

// ── Delivery ────────────────────────────────────────────────────────────────

describe("WatchalongDelivery", () => {
  const SESSION = { id: "s1", title: "Skinamarink", status: "playing", playhead_sec: 120, duration_sec: 6000, cue_count: 900, source: "attachment" };

  function server(state: { playhead: number; sessionId?: string; cues: WatchCueRow[]; status?: string }) {
    return fakeHalseth((url) => {
      const since = Number(url.searchParams.get("since_sec"));
      const max = Number(url.searchParams.get("max_cues"));
      const inRange = state.cues.filter(c => c.start_sec > since && c.start_sec <= state.playhead);
      const kept = inRange.slice(-max);
      return jsonRes(200, {
        session: { ...SESSION, id: state.sessionId ?? "s1", status: state.status ?? "playing", playhead_sec: state.playhead },
        cues: kept, skipped: inRange.length - kept.length,
      });
    });
  }

  const cueAt = (t: number, text = `line ${t}`): WatchCueRow => ({ start_sec: t, kind: "line", text });

  test("first delivery from the start, then only the delta after commit", async () => {
    let now = 0;
    const st = { playhead: 120, cues: [cueAt(10), cueAt(60), cueAt(150), cueAt(200)] };
    const { fn, calls } = server(st);
    const d = new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: fn, now: () => now });

    const p1 = await d.prepare("ch");
    expect(p1!.block!.split("\n")).toEqual(["[ON SCREEN: Skinamarink, 0:00 → 2:00, playing]", "[0:10] line 10", "[1:00] line 60"]);
    expect(p1!.stmMarker).toBe("[on screen: Skinamarink to 2:00]");
    expect(calls[0]!.url).toContain("since_sec=-1");
    d.commit(p1!);

    now = 20_000; st.playhead = 210;
    const p2 = await d.prepare("ch");
    expect(calls[1]!.url).toContain("since_sec=120");
    expect(p2!.block!.split("\n")).toEqual(["[ON SCREEN: Skinamarink, 2:00 → 3:30, playing]", "[2:30] line 150", "[3:20] line 200"]);
  });

  test("an uncommitted delivery is re-sent next turn (a failed reply loses nothing)", async () => {
    let now = 0;
    const { fn } = server({ playhead: 120, cues: [cueAt(10)] });
    const d = new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: fn, now: () => now });
    const p1 = await d.prepare("ch");
    now = 20_000;
    const p2 = await d.prepare("ch");
    expect(p2!.block).toBe(p1!.block);
  });

  test("10s cache: a burst costs one read, and a commit inside the window empties the delta", async () => {
    let now = 0;
    const { fn, calls } = server({ playhead: 120, cues: [cueAt(10), cueAt(60)] });
    const d = new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: fn, now: () => now });
    const p1 = await d.prepare("ch");
    d.commit(p1!);
    now = 5_000;
    const p2 = await d.prepare("ch");
    expect(calls).toHaveLength(1);
    expect(p2!.block).toBeNull();
    expect(p2!.standingLine).toContain("Skinamarink");
    now = 11_000;
    await d.prepare("ch");
    expect(calls).toHaveLength(2);
  });

  test("first join deep into a film: only the last ten minutes, with the join line", async () => {
    const cues = [cueAt(100), cueAt(2000), cueAt(2300), cueAt(2800)];
    const { fn } = server({ playhead: 2832, cues });
    const d = new WatchalongDelivery({ secret: "s", companionId: "drevan", fetchFn: fn, now: () => 0 });
    const p = await d.prepare("ch");
    expect(p!.block!.split("\n")).toEqual([
      "[ON SCREEN: Skinamarink, 37:12 → 47:12, playing]",
      "(you're joining 47:12 in; the last ten minutes:)",
      "[38:20] line 2300",
      "[46:40] line 2800",
    ]);
  });

  test("a new session in the channel restarts delivery from scratch", async () => {
    let now = 0;
    const st = { playhead: 120, cues: [cueAt(10)], sessionId: "s1" };
    const { fn } = server(st);
    const d = new WatchalongDelivery({ secret: "s", companionId: "gaia", fetchFn: fn, now: () => now });
    d.commit((await d.prepare("ch"))!);
    now = 20_000; st.sessionId = "s2"; st.playhead = 30;
    const p = await d.prepare("ch");
    expect(p!.session.id).toBe("s2");
    expect(p!.block).toContain("[0:10] line 10");
  });

  test("paused session: empty delta, standing line still present", async () => {
    let now = 0;
    const { fn } = server({ playhead: 120, cues: [cueAt(10)], status: "paused" });
    const d = new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: fn, now: () => now });
    d.commit((await d.prepare("ch"))!);
    now = 20_000;
    const p = await d.prepare("ch");
    expect(p!.block).toBeNull();
    expect(p!.standingLine).toContain("paused");
  });

  test("no session -> null; Halseth failure -> null, never throws", async () => {
    const none = fakeHalseth(() => jsonRes(200, { session: null }));
    expect(await new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: none.fn }).prepare("ch")).toBeNull();

    const down = fakeHalseth(() => jsonRes(500, { error: "boom" }));
    expect(await new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: down.fn }).prepare("ch")).toBeNull();

    const thrown = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: thrown }).prepare("ch")).toBeNull();
  });

  test("a big forward jump: server keeps the last 80, the block names how many were dropped", async () => {
    let now = 0;
    const st = { playhead: 0.5, cues: Array.from({ length: 100 }, (_, i) => cueAt(i + 1)) };
    const { fn, calls } = server(st);
    const d = new WatchalongDelivery({ secret: "s", companionId: "cypher", fetchFn: fn, now: () => now });
    d.commit((await d.prepare("ch"))!);
    expect(d.lastDeliveredFor("ch")).toEqual({ sessionId: "s1", sec: 0.5 });
    now = 20_000; st.playhead = 500;
    const p = await d.prepare("ch");
    expect(calls[1]!.url).toContain("max_cues=80");
    const lines = p!.block!.split("\n");
    expect(lines[1]).toBe("(… 20 earlier lines not shown)");
    expect(lines).toHaveLength(2 + 80);
  });

  test("knob: default on, off/0/false/no turn it off", () => {
    expect(watchalongEnabled({})).toBe(true);
    expect(watchalongEnabled({ WATCHALONG_ENABLED: "on" })).toBe(true);
    for (const v of ["off", "0", "false", "no", " OFF "]) expect(watchalongEnabled({ WATCHALONG_ENABLED: v })).toBe(false);
  });
});

// ── Commands ────────────────────────────────────────────────────────────────

describe("movie / at commands", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:02,000\n[floorboard creaks]\n\n2\n00:00:03,000 --> 00:00:04,000\nKEVIN: Where's Dad?\n\n3\n00:00:05,000 --> 00:00:09,000\n♪ lullaby ♪\n";

  test("start with an attachment: POSTs cues, literal ack", async () => {
    const { fn, calls } = fakeHalseth((_u, method) => method === "POST" ? jsonRes(201, { id: "s1", cue_count: 3, duration_sec: 9 }) : jsonRes(404, {}));
    let changed = 0;
    const reply = await handleMovieCommand("start", "Skinamarink", {
      secret: "s", channelId: "ch", companionId: "drevan", startedBy: "Raziel",
      attachment: { name: "skinamarink.srt", text: SRT }, fetchFn: fn, onChanged: () => changed++,
    });
    expect(reply).toBe("🎬 Skinamarink loaded: 3 lines (1 sound, 1 music cues, attached skinamarink.srt). Paused at 0:00. Say drev: at 0:00 when you press play.");
    expect(changed).toBe(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.url).toBe("https://halseth.test/mind/watchalong");
    expect(body["title"]).toBe("Skinamarink");
    expect(body["channel_id"]).toBe("ch");
    expect(body["source"]).toBe("attachment");
    expect(body["source_ref"]).toBe("skinamarink.srt");
    expect(body["duration_sec"]).toBe(9);
    expect((body["cues"] as unknown[]).length).toBe(3);
  });

  test("start with no title and no attachment asks for one, no network", async () => {
    const { fn, calls } = fakeHalseth(() => jsonRes(500, {}));
    expect(await handleMovieCommand("start", "", { secret: "s", channelId: "ch", companionId: "cypher", fetchFn: fn }))
      .toMatch(/give me a title: `cy: movie start <title>`/);
    expect(calls).toHaveLength(0);
  });

  test("attachment-only start names the movie from the file", async () => {
    const { fn, calls } = fakeHalseth(() => jsonRes(201, { id: "s1", cue_count: 3 }));
    await handleMovieCommand("start", "", { secret: "s", channelId: "ch", companionId: "cypher", attachment: { name: "Skinamarink.2022.srt", text: SRT }, fetchFn: fn });
    expect((calls[0]!.body as Record<string, unknown>)["title"]).toBe("Skinamarink 2022");
  });

  test("no captions anywhere -> the literal spec message", async () => {
    const reply = await handleMovieCommand("start", "Skinamarink", {
      secret: "s", channelId: "ch", companionId: "cypher",
      captionDeps: { hasOpenSubtitlesKey: () => false },
    });
    expect(reply).toBe("no captions found: attach an .srt to `cy: movie start Skinamarink`");
  });

  test("OpenSubtitles failure says why, still points at the attachment path", async () => {
    const reply = await handleMovieCommand("start", "Skinamarink", {
      secret: "s", channelId: "ch", companionId: "cypher",
      captionDeps: { hasOpenSubtitlesKey: () => true, openSubtitles: async () => { throw new Error("no English subtitles on OpenSubtitles for \"Skinamarink\""); } },
    });
    expect(reply).toMatch(/^no captions found \(no English subtitles.*\): attach an \.srt to `cy: movie start Skinamarink`$/);
  });

  test("a Halseth refusal is reported, not narrated as success", async () => {
    const { fn } = fakeHalseth(() => jsonRes(400, { error: "cues: 0 valid" }));
    const reply = await handleMovieCommand("start", "X", { secret: "s", channelId: "ch", companionId: "gaia", attachment: { name: "x.srt", text: SRT }, fetchFn: fn });
    expect(reply).toBe("movie NOT loaded: cues: 0 valid");
  });

  const active = (status = "playing", playhead = 2832) => (url: URL, method: string) => {
    if (method === "GET") return jsonRes(200, { session: { id: "s1", title: "Skinamarink", status, playhead_sec: playhead, duration_sec: 6000, cue_count: 900 }, cues: [], skipped: 0 });
    return jsonRes(200, { id: "s1", title: "Skinamarink", status: "x", playhead_sec: playhead });
  };

  test("at: seek + play, ack ▶ time", async () => {
    const { fn, calls } = fakeHalseth(active("paused", 2832));
    const reply = await handleAtCommand("47:12", { secret: "s", channelId: "ch", companionId: "cypher", fetchFn: fn });
    expect(reply).toBe("▶ 47:12");
    expect(calls[0]!.url).toContain("/mind/watchalong/active?channel_id=ch");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toBe("https://halseth.test/mind/watchalong/s1");
    expect(calls[1]!.body).toEqual({ at_sec: 2832, status: "playing" });
  });

  test("pause / play / status / done", async () => {
    const { fn, calls } = fakeHalseth(active());
    const ctx = { secret: "s", channelId: "ch", companionId: "cypher", fetchFn: fn };
    expect(await handleMovieCommand("pause", "", ctx)).toMatch(/^⏸ Skinamarink paused at 47:12\./);
    expect(calls[1]!.body).toEqual({ status: "paused" });
    expect(await handleMovieCommand("play", "", ctx)).toBe("▶ 47:12");
    expect(await handleMovieCommand("status", "", ctx)).toBe("🎬 Skinamarink: 47:12 / 1:40:00, playing (900 lines).");
    expect(await handleMovieCommand("done", "", ctx)).toBe("🎬 Skinamarink ended at 47:12.");
  });

  test("no active session -> literal pointer to movie start", async () => {
    const { fn } = fakeHalseth(() => jsonRes(200, { session: null }));
    expect(await handleAtCommand("47:12", { secret: "s", channelId: "ch", companionId: "drevan", fetchFn: fn }))
      .toBe("no movie running in this channel. `drev: movie start <title>` first.");
  });

  test("409 on an ended session", async () => {
    const { fn } = fakeHalseth((url, method) => method === "PATCH" ? jsonRes(409, {}) : active()(url, method));
    expect(await handleMovieCommand("done", "", { secret: "s", channelId: "ch", companionId: "cypher", fetchFn: fn })).toBe("Skinamarink had already ended.");
  });

  test("normaliseMovieSub aliases", () => {
    expect(normaliseMovieSub("resume")).toBe("play");
    expect(normaliseMovieSub("STOP")).toBe("done");
    expect(normaliseMovieSub("end")).toBe("done");
    expect(normaliseMovieSub("nope")).toBeNull();
  });
});

describe("loadCaptions source order", () => {
  const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHi.\n";
  const never = async () => { throw new Error("should not be called"); };

  test("attachment wins over everything", async () => {
    const r = await loadCaptions("https://youtu.be/x", { name: "a.srt", text: SRT }, { ytDlpSubs: never, openSubtitles: never, hasOpenSubtitlesKey: () => true });
    expect(r.source).toBe("attachment");
  });
  test("a URL title goes to yt-dlp and takes its title", async () => {
    const r = await loadCaptions("<https://youtu.be/x>", null, {
      ytDlpSubs: async (u) => { expect(u).toBe("https://youtu.be/x"); return { text: "WEBVTT\n\n00:01.000 --> 00:02.000\nHi.\n", title: "A Video" }; },
      openSubtitles: never, hasOpenSubtitlesKey: () => true,
    });
    expect(r.source).toBe("youtube");
    expect(r.discoveredTitle).toBe("A Video");
    expect(r.cues).toHaveLength(1);
  });
  test("a plain title goes to OpenSubtitles when keyed", async () => {
    const r = await loadCaptions("Skinamarink", null, {
      ytDlpSubs: never, hasOpenSubtitlesKey: () => true,
      openSubtitles: async () => ({ text: SRT, fileId: 7, fileName: "x.srt", hearingImpaired: true }),
    });
    expect(r.source).toBe("opensubtitles");
    expect(r.sourceRef).toBe("7");
    expect(r.sourceLabel).toBe("OpenSubtitles, HI");
  });
  test("no key -> NoCaptionsError", async () => {
    await expect(loadCaptions("Skinamarink", null, { ytDlpSubs: never, openSubtitles: never, hasOpenSubtitlesKey: () => false }))
      .rejects.toBeInstanceOf(NoCaptionsError);
  });
});

describe("readCaptionAttachment", () => {
  test("reads the first .srt/.vtt, ignores images", async () => {
    const fn = (async () => new Response("1\n00:00:01,000 --> 00:00:02,000\nHi.\n")) as unknown as typeof fetch;
    const r = await readCaptionAttachment([{ name: "poster.png", url: "https://cdn/p" }, { name: "film.SRT", url: "https://cdn/f", size: 50 }], fn);
    expect(r?.name).toBe("film.SRT");
    expect(r?.text).toContain("Hi.");
  });
  test("too large or none -> null", async () => {
    const fn = (async () => new Response("x")) as unknown as typeof fetch;
    expect(await readCaptionAttachment([{ name: "big.srt", url: "u", size: 10 * 1024 * 1024 }], fn)).toBeNull();
    expect(await readCaptionAttachment([{ name: "a.png", url: "u" }], fn)).toBeNull();
  });
});

describe("StmStore.amendInbound (STM marker)", () => {
  test("appends the marker to the matching inbound turn once, in memory", async () => {
    const stm = new StmStore("cypher", async () => {}, async () => []);
    await stm.ensureLoaded("ch");
    stm.append("ch", { role: "user", content: "this part is so creepy", timestamp: 1000 });
    stm.append("ch", { role: "assistant", content: "it is", timestamp: 1001 });
    expect(stm.amendInbound("ch", 1000, "this part is so creepy", "[on screen: Skinamarink to 47:12]")).toBe(true);
    expect(stm.amendInbound("ch", 1000, "this part is so creepy", "[on screen: Skinamarink to 47:12]")).toBe(true);
    expect(stm.get("ch")[0]!.content).toBe("this part is so creepy\n[on screen: Skinamarink to 47:12]");
    expect(stm.amendInbound("ch", 999, "this part is so creepy", "x")).toBe(false);
  });
});
