import { TAVILY_API_KEY } from "./config.js";
import type { TavilyResult } from "./types.js";

interface TavilySearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
}

/**
 * Search the web via Tavily.
 * Free tier: 1000 searches/month (~11/day across 3 companions).
 */
export async function search(query: string, opts: TavilySearchOptions = {}): Promise<TavilyResult[]> {
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
