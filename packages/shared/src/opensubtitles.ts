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
}

export interface OpenSubtitlesOptions {
  apiKey?: string;
  username?: string;
  password?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface SubtitleItem {
  attributes?: {
    language?: string;
    hearing_impaired?: boolean;
    download_count?: number;
    release?: string;
    files?: Array<{ file_id?: number; file_name?: string }>;
  };
}

/** Pick the best track: hearing-impaired first, then most downloaded. Items with no file are skipped. */
export function pickSubtitle(items: SubtitleItem[]): { fileId: number; fileName: string | null; hearingImpaired: boolean; release: string | null } | null {
  const usable = items
    .map(i => {
      const a = i.attributes ?? {};
      const f = (a.files ?? []).find(x => typeof x.file_id === "number");
      if (!f) return null;
      if (a.language && a.language.toLowerCase() !== "en") return null;
      return {
        fileId: f.file_id as number,
        fileName: f.file_name ?? null,
        hearingImpaired: a.hearing_impaired === true,
        release: a.release ?? null,
        downloads: typeof a.download_count === "number" ? a.download_count : 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (usable.length === 0) return null;
  usable.sort((a, b) => (Number(b.hearingImpaired) - Number(a.hearingImpaired)) || (b.downloads - a.downloads));
  const best = usable[0]!;
  return { fileId: best.fileId, fileName: best.fileName, hearingImpaired: best.hearingImpaired, release: best.release };
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

  const params = new URLSearchParams({ query: q, languages: "en", order_by: "download_count" });
  const search = await doFetch(`${OPENSUBTITLES_BASE}/subtitles?${params.toString()}`, {
    method: "GET", headers: headers(apiKey, bearer), signal: AbortSignal.timeout(timeout),
  });
  if (!search.ok) throw new Error(`OpenSubtitles search failed (${search.status})`);
  const sj = await search.json().catch(() => ({})) as { data?: SubtitleItem[] };
  const pick = pickSubtitle(sj.data ?? []);
  if (!pick) throw new Error(`no English subtitles on OpenSubtitles for "${q}"`);

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
  return { text, fileId: pick.fileId, fileName: pick.fileName, hearingImpaired: pick.hearingImpaired, release: pick.release };
}
