import { TAVILY_API_KEY, TAVILY_MAX_PER_DAY, TAVILY_FORAGE_RESERVE } from "./config.js";
import type { TavilyResult } from "./types.js";

/**
 * What the search is for. The daily budget is shared, so exploration (which re-reads ground the
 * companion already chose) must not be able to consume the searches foraging needs to bring in
 * anything new. Anything other than "forage" is subject to the reserve.
 */
export type SearchPurpose = "forage" | "explore";

interface TavilySearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  purpose?: SearchPurpose;
}

/**
 * The reserve can never exceed half the budget. A deployment that pins TAVILY_MAX_PER_DAY low
 * (it defaulted to 5 for a long time, and .env may still set it) would otherwise make
 * `remaining <= reserve` true on the very first call and starve exploration completely --
 * trading one starved lane for the other.
 */
export function effectiveForageReserve(cap = TAVILY_MAX_PER_DAY, reserve = TAVILY_FORAGE_RESERVE): number {
  return Math.max(0, Math.min(reserve, Math.floor(cap / 2)));
}

/** Daily usage counter -- resets when the calendar date changes. */
export const dailyCounter = {
  date: "",
  count: 0,
  /** Reset for tests; the daily rollover in check() handles production. */
  reset(): void { this.date = ""; this.count = 0; },
  check(purpose: SearchPurpose): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this.date !== today) { this.date = today; this.count = 0; }
    const remaining = TAVILY_MAX_PER_DAY - this.count;
    if (remaining <= 0) return false;
    // Hold the tail of the budget for foraging.
    if (purpose !== "forage" && remaining <= effectiveForageReserve()) return false;
    this.count++;
    return true;
  },
};

/**
 * Search the web via Tavily.
 * Free tier: 1000 searches/month. Daily cap enforced via TAVILY_MAX_PER_DAY, with the last
 * TAVILY_FORAGE_RESERVE searches spendable only by `purpose: "forage"`.
 */
export async function search(query: string, opts: TavilySearchOptions = {}): Promise<TavilyResult[]> {
  const purpose = opts.purpose ?? "explore";
  if (!dailyCounter.check(purpose)) {
    console.warn(`[search] daily budget exhausted for purpose=${purpose} (cap ${TAVILY_MAX_PER_DAY}, forage reserve ${TAVILY_FORAGE_RESERVE}), skipping search`);
    return [];
  }
  if (!TAVILY_API_KEY) {
    console.warn("[search] TAVILY_API_KEY not set, returning empty results");
    return [];
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: opts.searchDepth ?? "basic",
      max_results: opts.maxResults ?? 5,
      include_answer: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily search error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
  }));
}
