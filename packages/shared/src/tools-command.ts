// tools-command.ts -- owner-gated companion tool commands from Discord (0077, take 14).
//
// `<prefix>: search <query>` and `<prefix>: imagine <prompt>`. The bot performs the
// Halseth call itself (POST /mind/tools/search | /mind/tools/image) and acks
// deterministically -- the model never gets to claim a search/image it didn't run
// (the 2026-06-11 deterministic-ack doctrine). The call runs AS the companion
// (companion_id), so the per-companion tools_enabled gate applies.

const SEARCH_LIST_CAP = 5;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

interface ImageResult {
  url: string;
  key: string;
}

function halsethEnv(): { base: string; secret: string } | null {
  const base = process.env["HALSETH_URL"];
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"];
  if (!base || !secret) {
    console.error("[tools] command SKIPPED: HALSETH_URL/HALSETH_SECRET missing from env");
    return null;
  }
  return { base: base.replace(/\/$/, ""), secret };
}

async function toolsFetch(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const env = halsethEnv();
  if (!env) return { ok: false, status: 0, json: { error: "halseth env missing on this box" } };
  const res = await fetch(`${env.base}${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** Pure deterministic ack for a completed web search. */
export function formatSearchReply(query: string, results: SearchResult[]): string {
  const lines = [`searched: "${query}" -- ${results.length} result(s):`];
  for (const r of results.slice(0, SEARCH_LIST_CAP)) {
    lines.push(`• ${r.title} — ${r.url}`);
  }
  return lines.join("\n").slice(0, 1900);
}

/** Pure deterministic ack for a generated image. imageUrl is attached by the caller. */
export function formatImageReply(prompt: string, result: ImageResult): { text: string; imageUrl?: string } {
  const text = `generated an image for: "${prompt}"`;
  return result.url ? { text, imageUrl: result.url } : { text };
}

/** Handle `search <query>`. Returns the exact message the bot sends. */
export async function handleToolSearch(query: string, companionId: string): Promise<string> {
  const q = query.trim();
  if (!q) return "give me something to search for.";
  const res = await toolsFetch("/mind/tools/search", { companion_id: companionId, query: q });
  if (res.status === 403) return "web search isn't enabled for you yet (Raziel can flip the tools_enabled gate).";
  if (!res.ok) return `search failed: ${String(res.json["error"] ?? `halseth ${res.status || "no env"}`)}`;
  const results = Array.isArray(res.json["results"]) ? (res.json["results"] as SearchResult[]) : [];
  return formatSearchReply(q, results);
}

/** Handle `imagine <prompt>`. Returns ack text + an optional image url to attach. */
export async function handleToolImage(prompt: string, companionId: string): Promise<{ text: string; imageUrl?: string }> {
  const p = prompt.trim();
  if (!p) return { text: "tell me what to imagine." };
  const res = await toolsFetch("/mind/tools/image", { companion_id: companionId, prompt: p });
  if (res.status === 403) return { text: "image generation isn't enabled for you yet (Raziel can flip the tools_enabled gate)." };
  if (!res.ok) return { text: `image generation failed: ${String(res.json["error"] ?? `halseth ${res.status || "no env"}`)}` };
  return formatImageReply(p, { url: String(res.json["url"] ?? ""), key: String(res.json["key"] ?? "") });
}
