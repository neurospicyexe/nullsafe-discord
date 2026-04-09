import { TAVILY_API_KEY, TAVILY_MAX_PER_DAY } from "./config.js";
import type { TavilyResult } from "./types.js";

interface TavilySearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
}

/** Daily usage counter -- resets when the calendar date changes. */
const dailyCounter = {
  date: "",
  count: 0,
  check(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this.date !== today) { this.date = today; this.count = 0; }
    if (this.count >= TAVILY_MAX_PER_DAY) return false;
    this.count++;
    return true;
  },
};

/**
 * Search the web via Tavily.
 * Free tier: 1000 searches/month. Daily cap enforced via TAVILY_MAX_PER_DAY (default 5).
 */
export async function search(query: string, opts: TavilySearchOptions = {}): Promise<TavilyResult[]> {
  if (!dailyCounter.check()) {
    console.warn(`[search] daily cap reached (${TAVILY_MAX_PER_DAY}), skipping search`);
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
