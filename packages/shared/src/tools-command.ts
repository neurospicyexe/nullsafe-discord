// tools-command.ts -- owner-gated companion tool commands from Discord (0077, take 14).
//
// `<prefix>: search <query>` and `<prefix>: imagine <prompt>`. The bot performs the
// Halseth call itself (POST /mind/tools/search | /mind/tools/image) and acks
// deterministically -- the model never gets to claim a search/image it didn't run
// (the 2026-06-11 deterministic-ack doctrine). The call runs AS the companion
// (companion_id), so the per-companion tools_enabled gate applies.

import type { Redis } from "ioredis";
import { publishWake } from "./events.js";
import { halsethEnv } from "./halseth-command-env.js";

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

async function toolsFetch(path: string, body: unknown, secret: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const env = halsethEnv(secret);
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

/**
 * Read-in block (2026-07-03): the searching companion must actually READ what it found.
 * Raziel: "I didn't put it there to have an over-glorified search engine" -- a search is
 * "bring this into the conversation", not a link dump. This block (titles + snippets)
 * is fed back to the model for an in-voice weave after the deterministic ack.
 */
export function formatSearchReadIn(query: string, results: SearchResult[]): string {
  const lines = [`You just ran a web search for "${query}" because Raziel asked for it in the live conversation. What you found:`];
  for (const r of results.slice(0, SEARCH_LIST_CAP)) {
    lines.push(`• ${r.title}\n  ${r.snippet.slice(0, 400)}`);
  }
  lines.push(
    `Now bring it INTO the conversation: say what you actually found and what matters in it, ` +
    `connected to the live thread, in your own voice. 2-6 sentences. No link lists, no "here are ` +
    `the results" framing -- the links are already posted. If the results are thin or off-target, say that honestly.`,
  );
  return lines.join("\n");
}

/** Handle `search <query>`. Returns the deterministic ack plus the raw results so the
 *  caller can feed them back to the model (read-in) and into STM. */
export async function handleToolSearch(query: string, companionId: string, halsethSecret: string): Promise<{ reply: string; results: SearchResult[] }> {
  const q = query.trim();
  if (!q) return { reply: "give me something to search for.", results: [] };
  const res = await toolsFetch("/mind/tools/search", { companion_id: companionId, query: q }, halsethSecret);
  if (res.status === 403) return { reply: "web search isn't enabled for you yet (Raziel can flip the tools_enabled gate).", results: [] };
  if (!res.ok) return { reply: `search failed: ${String(res.json["error"] ?? `halseth ${res.status || "no env"}`)}`, results: [] };
  const results = Array.isArray(res.json["results"]) ? (res.json["results"] as SearchResult[]) : [];
  return { reply: formatSearchReply(q, results), results };
}

/**
 * Handle `council <question>`. Convenes a council round; the worker runs the ritual. (take 8)
 *
 * When `redis` is supplied, publishes a wake so the worker runs the ritual immediately
 * instead of waiting for its next council cron tick (up to 30 min). The wake is fire-and-forget:
 * if it fails or redis is absent, the cron fallback still runs the ritual.
 */
export async function handleCouncilConvene(question: string, halsethSecret: string, redis: Redis | null = null): Promise<string> {
  const q = question.trim();
  if (!q) return "give the council a question.";
  const res = await toolsFetch("/mind/council/convene", { question: q, asked_by: "raziel" }, halsethSecret);
  if (!res.ok) return `couldn't convene the council: ${String(res.json["error"] ?? `halseth ${res.status || "no env"}`)}`;
  if (redis) {
    await publishWake(redis, { kind: "council", reason: "convene", requestedBy: "raziel", at: new Date().toISOString() });
  }
  return `council convened on: "${q.slice(0, 160)}" — the triad will answer, rank blind, and Gaia will synthesize. check back with "council status".`;
}

/** Handle `imagine <prompt>`. Returns ack text + an optional image url to attach. */
export async function handleToolImage(prompt: string, companionId: string, halsethSecret: string): Promise<{ text: string; imageUrl?: string }> {
  const p = prompt.trim();
  if (!p) return { text: "tell me what to imagine." };
  const res = await toolsFetch("/mind/tools/image", { companion_id: companionId, prompt: p }, halsethSecret);
  if (res.status === 403) return { text: "image generation isn't enabled for you yet (Raziel can flip the tools_enabled gate)." };
  if (!res.ok) return { text: `image generation failed: ${String(res.json["error"] ?? `halseth ${res.status || "no env"}`)}` };
  return formatImageReply(p, { url: String(res.json["url"] ?? ""), key: String(res.json["key"] ?? "") });
}
