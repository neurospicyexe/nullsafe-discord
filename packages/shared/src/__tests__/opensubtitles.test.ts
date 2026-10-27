import { fetchOpenSubtitles, pickSubtitle, parseTitleQuery, normalizeTitle, OPENSUBTITLES_BASE } from "../opensubtitles.js";

type Call = { url: string; init: RequestInit | undefined };

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A scripted fetch: routes by URL, records every call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) throw new Error(`unrouted ${url}`);
    return routes[key]!(init);
  }) as typeof fetch;
  return { fn, calls };
}

const SEARCH_DATA = {
  data: [
    { attributes: { language: "en", hearing_impaired: false, download_count: 9000, release: "Skinamarink.2022.WEB", files: [{ file_id: 111, file_name: "plain.srt" }] } },
    { attributes: { language: "en", hearing_impaired: true, download_count: 1200, release: "Skinamarink.2022.SDH", files: [{ file_id: 222, file_name: "sdh.srt" }] } },
    { attributes: { language: "en", hearing_impaired: true, download_count: 300, release: "other", files: [{ file_id: 333, file_name: "sdh2.srt" }] } },
  ],
};

describe("pickSubtitle", () => {
  test("hearing-impaired beats downloads; downloads break ties", () => {
    expect(pickSubtitle(SEARCH_DATA.data)?.fileId).toBe(222);
  });
  test("falls back to most downloaded when no HI track", () => {
    expect(pickSubtitle([SEARCH_DATA.data[0]!, { attributes: { language: "en", download_count: 5, files: [{ file_id: 9 }] } }])?.fileId).toBe(111);
  });
  test("skips items without a file and non-English items", () => {
    expect(pickSubtitle([{ attributes: { files: [] } }, { attributes: { language: "fr", files: [{ file_id: 1 }] } }])).toBeNull();
  });
});

// The 10-26 movie night: the top HI track for "The Evil Dead 1981" belonged to another film.
const EVIL_DEAD_SEARCH = {
  data: [
    { attributes: { language: "en", hearing_impaired: true, download_count: 50000, release: "Horse.Movie.SDH",
      files: [{ file_id: 900, file_name: "wrong.srt" }],
      feature_details: { feature_type: "Movie", title: "Some Horse Film", year: 1981, imdb_id: 11111 } } },
    { attributes: { language: "en", hearing_impaired: true, download_count: 40000, release: "Evil.Dead.2013.SDH",
      files: [{ file_id: 901, file_name: "remake.srt" }],
      feature_details: { feature_type: "Movie", title: "Evil Dead", year: 2013, imdb_id: 1288558 } } },
    { attributes: { language: "en", hearing_impaired: false, download_count: 3000, release: "The.Evil.Dead.1981.BRrip.YIFY",
      files: [{ file_id: 902, file_name: "yify.srt" }],
      feature_details: { feature_type: "Movie", title: "The Evil Dead", year: 1981, imdb_id: 83907 } } },
  ],
};

describe("parseTitleQuery", () => {
  test("trailing year, bracketed year, tt id, imdb: id", () => {
    expect(parseTitleQuery("The Evil Dead 1981")).toEqual({ title: "The Evil Dead", year: 1981, imdbId: null });
    expect(parseTitleQuery("The Evil Dead (1981)")).toEqual({ title: "The Evil Dead", year: 1981, imdbId: null });
    expect(parseTitleQuery("The Evil Dead tt0083907")).toEqual({ title: "The Evil Dead", year: null, imdbId: 83907 });
    expect(parseTitleQuery("tt0083907")).toEqual({ title: "", year: null, imdbId: 83907 });
    expect(parseTitleQuery("The Evil Dead 1981 imdb:83907")).toEqual({ title: "The Evil Dead", year: 1981, imdbId: 83907 });
  });
  test("a title that IS a year stays a title", () => {
    expect(parseTitleQuery("1917")).toEqual({ title: "1917", year: null, imdbId: null });
    expect(parseTitleQuery("1917 2019")).toEqual({ title: "1917", year: 2019, imdbId: null });
  });
  test("normalizeTitle drops the article and punctuation", () => {
    expect(normalizeTitle("The Evil Dead")).toBe(normalizeTitle("evil dead"));
    expect(normalizeTitle("Evil Dead II")).not.toBe(normalizeTitle("Evil Dead"));
  });
});

describe("pickSubtitle with a film check", () => {
  test("rejects the wrong film even when it is HI and most downloaded (10-26)", () => {
    const p = pickSubtitle(EVIL_DEAD_SEARCH.data, parseTitleQuery("The Evil Dead 1981"));
    expect(p?.fileId).toBe(902);
    expect(p).toMatchObject({ matchedTitle: "The Evil Dead", matchedYear: 1981, hearingImpaired: false });
  });
  test("an IMDb id pins the film", () => {
    expect(pickSubtitle(EVIL_DEAD_SEARCH.data, parseTitleQuery("tt1288558"))?.fileId).toBe(901);
  });
  test("a confirmed match beats a detail-less track; nothing matching -> null", () => {
    const bare = { attributes: { language: "en", hearing_impaired: true, download_count: 99999, files: [{ file_id: 7 }] } };
    expect(pickSubtitle([bare, EVIL_DEAD_SEARCH.data[2]!], parseTitleQuery("The Evil Dead"))?.fileId).toBe(902);
    expect(pickSubtitle([EVIL_DEAD_SEARCH.data[0]!], parseTitleQuery("The Evil Dead 1981"))).toBeNull();
  });
});

describe("fetchOpenSubtitles", () => {
  test("sends year / imdb_id, returns the matched film, refuses a wrong-film-only result", async () => {
    const ok = fakeFetch({
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, EVIL_DEAD_SEARCH),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(200, { link: "https://dl.example/y" }),
      "https://dl.example/": () => new Response("1\n00:00:01,000 --> 00:00:02,000\nJoin us\n", { status: 200 }),
    });
    const r = await fetchOpenSubtitles("The Evil Dead 1981", { apiKey: "k", username: "", password: "", fetchFn: ok.fn });
    expect(ok.calls[0]!.url).toContain("query=The+Evil+Dead");
    expect(ok.calls[0]!.url).toContain("year=1981");
    expect(r).toMatchObject({ fileId: 902, matchedTitle: "The Evil Dead", matchedYear: 1981 });

    const byId = fakeFetch({
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, EVIL_DEAD_SEARCH),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(200, { link: "https://dl.example/y" }),
      "https://dl.example/": () => new Response("x", { status: 200 }),
    });
    await fetchOpenSubtitles("tt0083907", { apiKey: "k", username: "", password: "", fetchFn: byId.fn });
    expect(byId.calls[0]!.url).toContain("imdb_id=83907");
    expect(byId.calls[0]!.url).not.toContain("query=");

    const wrong = fakeFetch({ [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, { data: [EVIL_DEAD_SEARCH.data[0]] }) });
    await expect(fetchOpenSubtitles("The Evil Dead 1981", { apiKey: "k", username: "", password: "", fetchFn: wrong.fn }))
      .rejects.toThrow(/none for "The Evil Dead" \(1981\); add the year or an IMDb id/);
    expect(wrong.calls).toHaveLength(1);
  });

  test("no key -> clear error, no network", async () => {
    const { fn, calls } = fakeFetch({});
    await expect(fetchOpenSubtitles("Skinamarink", { apiKey: "", fetchFn: fn })).rejects.toThrow(/OPENSUBTITLES_API_KEY is not set/);
    expect(calls).toHaveLength(0);
  });

  test("search -> HI pick -> download -> file text, with Api-Key + User-Agent", async () => {
    const { fn, calls } = fakeFetch({
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, SEARCH_DATA),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(200, { link: "https://dl.example/sdh.srt" }),
      "https://dl.example/": () => new Response("1\n00:00:01,000 --> 00:00:02,000\n[static]\n", { status: 200 }),
    });
    const r = await fetchOpenSubtitles("Skinamarink", { apiKey: "k", username: "", password: "", fetchFn: fn });
    expect(r.fileId).toBe(222);
    expect(r.hearingImpaired).toBe(true);
    expect(r.text).toContain("[static]");

    const search = calls[0]!;
    expect(search.url).toContain("query=Skinamarink");
    expect(search.url).toContain("languages=en");
    expect(search.url).toContain("order_by=download_count");
    const h = search.init?.headers as Record<string, string>;
    expect(h["Api-Key"]).toBe("k");
    expect(h["User-Agent"]).toBe("Nullsafe v1.0");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ file_id: 222 });
  });

  test("username/password -> login bearer on search + download", async () => {
    const { fn, calls } = fakeFetch({
      [`${OPENSUBTITLES_BASE}/login`]: () => jsonRes(200, { token: "tok" }),
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, SEARCH_DATA),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(200, { link: "https://dl.example/x" }),
      "https://dl.example/": () => new Response("x", { status: 200 }),
    });
    await fetchOpenSubtitles("Skinamarink", { apiKey: "k", username: "u", password: "p", fetchFn: fn });
    expect(calls[0]!.url).toBe(`${OPENSUBTITLES_BASE}/login`);
    expect((calls[1]!.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect((calls[2]!.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  test("failed login degrades to anonymous instead of failing", async () => {
    const { fn, calls } = fakeFetch({
      [`${OPENSUBTITLES_BASE}/login`]: () => jsonRes(401, { message: "bad" }),
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, SEARCH_DATA),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(200, { link: "https://dl.example/x" }),
      "https://dl.example/": () => new Response("x", { status: 200 }),
    });
    const r = await fetchOpenSubtitles("Skinamarink", { apiKey: "k", username: "u", password: "p", fetchFn: fn });
    expect(r.fileId).toBe(222);
    expect((calls[1]!.init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  test("no results -> clear error naming the title", async () => {
    const { fn } = fakeFetch({ [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, { data: [] }) });
    await expect(fetchOpenSubtitles("Nonexistent Film", { apiKey: "k", username: "", password: "", fetchFn: fn }))
      .rejects.toThrow(/no English subtitles on OpenSubtitles for "Nonexistent Film"/);
  });

  test("download quota refusal surfaces the API message", async () => {
    const { fn } = fakeFetch({
      [`${OPENSUBTITLES_BASE}/subtitles`]: () => jsonRes(200, SEARCH_DATA),
      [`${OPENSUBTITLES_BASE}/download`]: () => jsonRes(406, { message: "You have downloaded your allowed 5 subtitles" }),
    });
    await expect(fetchOpenSubtitles("Skinamarink", { apiKey: "k", username: "", password: "", fetchFn: fn }))
      .rejects.toThrow(/download refused \(406: You have downloaded/);
  });
});
