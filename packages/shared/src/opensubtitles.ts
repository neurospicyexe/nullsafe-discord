// opensubtitles.ts -- fetch a caption file for a title from OpenSubtitles (Watchalong spec 2026-10-02).
//
// One of the Watchalong's caption sources, used when Raziel did not attach an .srt and the title is
// not a URL. Prefers HEARING-IMPAIRED (SDH) tracks: those carry the sound and music cues
// ("[floorboard creaks]", "♪") that make a near-silent film like Skinamarink followable at all.
//
// API (v1): GET /subtitles?query=&languages=en&order_by=download_count -> pick -> POST /download
// {file_id} -> `link` -> fetch the file text. Headers: Api-Key + a User-Agent naming the app (the API
// rejects requests without one). Optional OPENSUBTITLES_USERNAME/PASSWORD -> POST /login for a bearer
// token, which raises the daily download quota from the anonymous tier.
//
// `fetchFn` is injectable so tests never touch the network (jest ESM mocking is the painful path here).

export const OPENSUBTITLES_BASE = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "Nullsafe v1.0";

export interface OpenSubtitlesResult {
  text: string;
  fileId: number;
  fileName: string | null;
  hearingImpaired: boolean;
  release: string | null;
  /** The film the track belongs to, per OpenSubtitles (null when the item carried no feature details). */
  matchedTitle: string | null;
  matchedYear: number | null;
}

// ── Which film was asked for ────────────────────────────────────────────────
// 2026-10-26 movie night: `movie start The Evil Dead 1981` searched ?query=The Evil Dead 1981, took the
// top hearing-impaired track, and loaded a different film's captions (horse neighs, "Stretch", "ten lbs
// of chocolate"). Drevan commented faithfully on the wrong script for an hour. Nothing checked that the
// track's film was the film asked for. Now the request is parsed into title / year / IMDb id, the search
// sends them, and a track whose feature details disagree is REJECTED: a wrong film is worse than "no
// captions, attach an .srt".

export interface TitleQuery {
  title: string;
  year: number | null;
  /** IMDb id as the API takes it: digits, no "tt". */
  imdbId: number | null;
}

/**
 * "The Evil Dead 1981" / "The Evil Dead (1981)" / "The Evil Dead tt0083907" / "tt0083907" /
 * "The Evil Dead imdb:83907". A year is taken only when words remain before it, so "1917" stays a title.
 */
export function parseTitleQuery(raw: string): TitleQuery {
  let s = raw.trim();
  let imdbId: number | null = null;
  const imdb = /(?:^|\s)(?:tt(\d{5,9})|imdb[:\s]+(?:tt)?(\d{5,9}))\s*$/i.exec(s);
  if (imdb) {
    imdbId = Number(imdb[1] ?? imdb[2]);
    s = s.slice(0, imdb.index).trim();
  }
  let year: number | null = null;
  const y = /^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/.exec(s);
  if (y && y[1]!.trim().length > 0) {
    year = Number(y[2]);
    s = y[1]!.trim();
  }
  return { title: s, year, imdbId };
}

/** Lowercase, punctuation to spaces, leading article dropped: "The Evil Dead" == "Evil Dead". */
export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/^(?:the|a|an)\s+/, "");
}

type FilmMatch = "match" | "unknown" | "mismatch";

function filmMatch(fd: FeatureDetails | undefined, want: TitleQuery): FilmMatch {
  if (!fd) return "unknown";
  const episode = (fd.feature_type ?? "").toLowerCase() === "episode";
  const imdb = episode ? (fd.parent_imdb_id ?? fd.imdb_id) : fd.imdb_id;
  if (want.imdbId !== null && typeof imdb === "number") return imdb === want.imdbId ? "match" : "mismatch";
  const title = episode ? (fd.parent_title ?? fd.title) : fd.title;
  if (want.title && typeof title === "string" && normalizeTitle(title) !== normalizeTitle(want.title)) return "mismatch";
  if (want.year !== null && !episode && typeof fd.year === "number" && fd.year !== want.year) return "mismatch";
  return typeof title === "string" || typeof imdb === "number" ? "match" : "unknown";
}

export interface OpenSubtitlesOptions {
  apiKey?: string;
  username?: string;
  password?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface FeatureDetails {
  feature_type?: string;
  title?: string;
  year?: number;
  imdb_id?: number;
  parent_title?: string;
  parent_imdb_id?: number;
}

interface SubtitleItem {
  attributes?: {
    language?: string;
    hearing_impaired?: boolean;
    download_count?: number;
    release?: string;
    files?: Array<{ file_id?: number; file_name?: string }>;
    feature_details?: FeatureDetails;
  };
}

export interface SubtitlePick {
  fileId: number;
  fileName: string | null;
  hearingImpaired: boolean;
  release: string | null;
  matchedTitle: string | null;
  matchedYear: number | null;
}

/**
 * Pick the best track for the film asked for. A track whose feature details disagree (title, year, IMDb
 * id) is rejected outright; a confirmed match beats a track with no details; then hearing-impaired, then
 * most downloaded. Items with no file, or not English, are skipped. `want` omitted = no film check (the
 * pre-10-27 behaviour, kept for callers that only have a bare list).
 */
export function pickSubtitle(items: SubtitleItem[], want?: TitleQuery): SubtitlePick | null {
  const usable = items
    .map(i => {
      const a = i.attributes ?? {};
      const f = (a.files ?? []).find(x => typeof x.file_id === "number");
      if (!f) return null;
      if (a.language && a.language.toLowerCase() !== "en") return null;
      const match = want ? filmMatch(a.feature_details, want) : "unknown";
      if (match === "mismatch") return null;
      const fd = a.feature_details;
      return {
        fileId: f.file_id as number,
        fileName: f.file_name ?? null,
        hearingImpaired: a.hearing_impaired === true,
        release: a.release ?? null,
        matchedTitle: fd?.title ?? null,
        matchedYear: typeof fd?.year === "number" ? fd.year : null,
        confirmed: match === "match",
        downloads: typeof a.download_count === "number" ? a.download_count : 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (usable.length === 0) return null;
  usable.sort((a, b) =>
    (Number(b.confirmed) - Number(a.confirmed)) ||
    (Number(b.hearingImpaired) - Number(a.hearingImpaired)) ||
    (b.downloads - a.downloads));
  const { confirmed: _c, downloads: _d, ...best } = usable[0]!;
  return best;
}

function headers(apiKey: string, bearer?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Api-Key": apiKey,
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (bearer) h["Authorization"] = `Bearer ${bearer}`;
  return h;
}

/**
 * Search + download the best English track for `title`. Throws an Error with a sentence a human can act
 * on (the caller puts it in the Discord ack): no key, no results, quota, network.
 */
export async function fetchOpenSubtitles(title: string, opts: OpenSubtitlesOptions = {}): Promise<OpenSubtitlesResult> {
  const apiKey = (opts.apiKey ?? process.env["OPENSUBTITLES_API_KEY"] ?? "").trim();
  if (!apiKey) throw new Error("OPENSUBTITLES_API_KEY is not set on this box");
  const username = (opts.username ?? process.env["OPENSUBTITLES_USERNAME"] ?? "").trim();
  const password = (opts.password ?? process.env["OPENSUBTITLES_PASSWORD"] ?? "").trim();
  const doFetch = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? 20_000;
  const q = title.trim();
  if (!q) throw new Error("no title to search for");
  const want = parseTitleQuery(q);

  // Login is optional and best-effort: a failed login still leaves the anonymous quota.
  let bearer: string | null = null;
  if (username && password) {
    try {
      const res = await doFetch(`${OPENSUBTITLES_BASE}/login`, {
        method: "POST", headers: headers(apiKey), body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({})) as { token?: string };
        bearer = j.token ?? null;
      } else {
        console.warn(`[opensubtitles] login failed (${res.status}); continuing anonymous`);
      }
    } catch (err) {
      console.warn(`[opensubtitles] login error; continuing anonymous: ${String(err).slice(0, 120)}`);
    }
  }

  // An IMDb id pins the film exactly; otherwise title (+ year when given) narrows the search.
  const params = new URLSearchParams({ languages: "en", order_by: "download_count" });
  if (want.imdbId !== null) params.set("imdb_id", String(want.imdbId));
  else params.set("query", want.title);
  if (want.year !== null && want.imdbId === null) params.set("year", String(want.year));
  const search = await doFetch(`${OPENSUBTITLES_BASE}/subtitles?${params.toString()}`, {
    method: "GET", headers: headers(apiKey, bearer), signal: AbortSignal.timeout(timeout),
  });
  if (!search.ok) throw new Error(`OpenSubtitles search failed (${search.status})`);
  const sj = await search.json().catch(() => ({})) as { data?: SubtitleItem[] };
  const items = sj.data ?? [];
  const pick = pickSubtitle(items, want);
  if (!pick) {
    const asked = `"${want.title || q}"${want.year ? ` (${want.year})` : ""}${want.imdbId ? ` tt${want.imdbId}` : ""}`;
    throw new Error(items.length > 0
      ? `OpenSubtitles had ${items.length} English track(s) but none for ${asked}; add the year or an IMDb id (tt...), or attach an .srt`
      : `no English subtitles on OpenSubtitles for ${asked}`);
  }

  const dl = await doFetch(`${OPENSUBTITLES_BASE}/download`, {
    method: "POST", headers: headers(apiKey, bearer), body: JSON.stringify({ file_id: pick.fileId }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!dl.ok) {
    const j = await dl.json().catch(() => ({})) as { message?: string };
    throw new Error(`OpenSubtitles download refused (${dl.status}${j.message ? `: ${j.message}` : ""})`);
  }
  const dj = await dl.json().catch(() => ({})) as { link?: string };
  if (!dj.link) throw new Error("OpenSubtitles download returned no link");

  const file = await doFetch(dj.link, { method: "GET", signal: AbortSignal.timeout(timeout) });
  if (!file.ok) throw new Error(`OpenSubtitles file fetch failed (${file.status})`);
  const text = await file.text();
  if (!text.trim()) throw new Error("OpenSubtitles file was empty");
  return { text, ...pick };
}
