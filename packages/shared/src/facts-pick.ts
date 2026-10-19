// B3 facts picker (2026-10-18). Per human message, choose which Architect facts the reply needs.
//
// Flow: Halseth embedding shortlist -> Jev judges each shortlisted fact (one noul question per
// fact, one call) -> theta -> once-per-transcript seen-mark -> shadow (log only) or live (return an
// injection block for hermesDelta extras.facts).
//
// Privacy: the shadow log carries ids, categories, scores and a message hash. NEVER message text or
// fact text. Nothing here throws to the caller; a picker that can fail the reply path is worse than
// no picker.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { postJev, type JevQuestion } from "./jev-gate.js";

export type FactsPickMode = "off" | "shadow" | "live";
const VALID_MODES: readonly FactsPickMode[] = ["off", "shadow", "live"];
let warnedUnknownMode = false;

/** Per-companion `FACTS_PICK_MODE_<COMPANION>` wins over `FACTS_PICK_MODE`; garbage falls to "off". */
export function readFactsPickMode(env: NodeJS.ProcessEnv = process.env, companion?: string): FactsPickMode {
  const perKey = companion ? `FACTS_PICK_MODE_${companion.toUpperCase()}` : null;
  const perRaw = perKey ? (env[perKey] ?? "").trim() : "";
  const knob = perRaw ? perKey! : "FACTS_PICK_MODE";
  const raw = (perRaw || (env.FACTS_PICK_MODE ?? "")).trim();
  if (!raw) return "off";
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as FactsPickMode;
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    console.warn(`[facts-pick] unknown ${knob}="${raw}"; falling back to "off" (valid: ${VALID_MODES.join(" | ")})`);
  }
  return "off";
}

export function __resetFactsPickWarnings(): void {
  warnedUnknownMode = false;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function posInt(raw: string | undefined, fallback: number): number {
  const n = num(raw, fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readFactsPickTheta(env: NodeJS.ProcessEnv = process.env, companion?: string): number {
  const per = companion ? env[`FACTS_PICK_THETA_${companion.toUpperCase()}`] : undefined;
  return num(per, num(env.FACTS_PICK_THETA, 0.6));
}

export function readFactsPickK(env: NodeJS.ProcessEnv = process.env): number {
  return posInt(env.FACTS_PICK_K, 12);
}

export const FACTS_PICK_CAP = 5;
const MSG_CLIP = 4_000;

export interface FactsPickRedis {
  set(key: string, val: string, ex: "EX", seconds: number, nx: "NX"): Promise<string | null>;
  exists(key: string): Promise<number>;
}

export interface FactsPickDeps {
  fetch?: typeof fetch;
  redis?: FactsPickRedis | null;
  now?: () => number;
  /** Receives one JSON line (no trailing newline). Default appends to FACTS_PICK_SHADOW_LOG. */
  logWriter?: (line: string) => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
}

export interface FactsPickInput {
  companion: string;
  channelId: string;
  transcriptId: string;
  message: string;
  mode: FactsPickMode;
  deps?: FactsPickDeps;
}

export interface FactsPickLog {
  ts?: string;
  companion?: string;
  channel?: string;
  transcript?: string;
  mode?: FactsPickMode;
  msg_len?: number;
  msg_hash?: string;
  shortlist?: Array<{ id: string; category: string; score: number }>;
  picks?: Array<{ id: string; category: string; p: number }>;
  would_inject?: string[];
  theta?: number;
  k?: number;
  ms?: number;
  error?: string;
}

export interface FactsPickResult {
  block: string | null;
  log: FactsPickLog;
}

interface ShortItem { id: string; category: string; status?: string; score: number; fact: string }

export function factsSeenKey(companion: string, channelId: string, transcriptId: string, factId: string): string {
  return `ns:facts:seen:${companion}:${channelId}:${transcriptId}:${factId}`;
}

export function buildFactsQuestions(shortlist: ShortItem[]): Record<string, JevQuestion> {
  const qs: Record<string, JevQuestion> = {};
  shortlist.forEach((f, i) => {
    qs[`f${i}`] = {
      type: "noul",
      instructions: `Would replying well to this message need this fact about Raziel: ${f.fact}`,
      criteria: {
        true: "Yes, the reply is better or safer for knowing it",
        false: "No, it is not relevant to what is being said",
      },
    };
  });
  return qs;
}

async function defaultLogWriter(path: string, line: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line + "\n", "utf8");
  } catch (e) {
    console.warn(`[facts-pick] shadow log write failed: ${String(e).slice(0, 120)}`);
  }
}

class PickTimeout extends Error {}

async function shortlistFetch(
  doFetch: typeof fetch, env: NodeJS.ProcessEnv, message: string, k: number,
): Promise<ShortItem[] | { error: string }> {
  const base = env.HALSETH_URL;
  const secret = env.HALSETH_SECRET ?? env.ADMIN_SECRET;
  if (!base || !secret) return { error: "no_halseth_env" };
  const url = new URL(`${base.replace(/\/+$/, "")}/identity/architect-facts/shortlist`);
  url.searchParams.set("q", message.slice(0, 500));
  url.searchParams.set("k", String(k));
  url.searchParams.set("text", "1");
  const res = await doFetch(url.toString(), {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) return { error: `shortlist_http_${res.status}` };
  const data = await res.json() as { items?: unknown };
  const items = Array.isArray(data?.items) ? data.items : [];
  const out: ShortItem[] = [];
  for (const raw of items) {
    const it = raw as Partial<ShortItem>;
    if (it && typeof it.id === "string" && typeof it.fact === "string" && it.fact.trim()) {
      out.push({
        id: it.id,
        category: typeof it.category === "string" ? it.category : "",
        status: it.status,
        score: typeof it.score === "number" && Number.isFinite(it.score) ? it.score : 0,
        fact: it.fact,
      });
    }
  }
  return out;
}

async function run(input: FactsPickInput, log: FactsPickLog, deadline: number): Promise<string | null> {
  const deps = input.deps ?? {};
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const { companion, channelId, transcriptId, mode } = input;
  const theta = readFactsPickTheta(env, companion);
  const k = readFactsPickK(env);
  log.theta = theta;
  log.k = k;

  const sl = await shortlistFetch(doFetch, env, input.message, k);
  log.shortlist = [];
  log.picks = [];
  log.would_inject = [];
  if (!Array.isArray(sl)) { log.error = sl.error; return null; }
  log.shortlist = sl.map(f => ({ id: f.id, category: f.category, score: f.score }));
  if (sl.length === 0) return null;

  const remaining = Math.max(500, deadline - now());
  const cName = companion.charAt(0).toUpperCase() + companion.slice(1);
  const msg = input.message.length > MSG_CLIP ? `${input.message.slice(0, MSG_CLIP)} …` : input.message;
  const jev = await postJev({
    purpose: `facts pick for ${companion}`,
    state: `Message to ${cName} from Raziel (or their household):\n\n${msg}`,
    questions: buildFactsQuestions(sl),
  }, { env, fetchImpl: deps.fetch, timeoutMs: Math.min(4_000, remaining), tag: "[facts-pick]" });
  if (!jev.ok) { log.error = `jev_${jev.reason}`; return null; }

  // Missing or malformed answers count as 0 (a partial 200 must not read as a verdict).
  const scored = sl.map((f, i) => {
    const a = jev.answers[`f${i}`] as { type?: string; noul?: unknown } | undefined;
    const p = a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : 0;
    return { f, p };
  });
  const picked = scored.filter(s => s.p >= theta).sort((a, b) => b.p - a.p).slice(0, FACTS_PICK_CAP);
  log.picks = picked.map(s => ({ id: s.f.id, category: s.f.category, p: s.p }));
  if (picked.length === 0) return null;

  const redis = deps.redis ?? null;
  const ttl = posInt(env.FACTS_PICK_REPEAT_S, 21600);
  const fresh: ShortItem[] = [];
  for (const { f } of picked) {
    const key = factsSeenKey(companion, channelId, transcriptId, f.id);
    let ok = true; // Redis absent or down fails open (inject)
    if (redis) {
      try {
        ok = mode === "live"
          ? (await redis.set(key, "1", "EX", ttl, "NX")) === "OK"
          : (await redis.exists(key)) === 0; // shadow never claims
      } catch { ok = true; }
    }
    if (ok) fresh.push(f);
  }
  log.would_inject = fresh.map(f => f.id);
  if (mode !== "live" || fresh.length === 0) return null;
  return `[Architect facts relevant here]\n${fresh.map(f => `- ${f.fact.trim()}`).join("\n")}`;
}

/** Never throws. mode "off" returns immediately with no network and no log line. */
export async function pickFacts(input: FactsPickInput): Promise<FactsPickResult> {
  const started = Date.now();
  const log: FactsPickLog = {
    companion: input.companion, channel: input.channelId, transcript: input.transcriptId, mode: input.mode,
  };
  try {
    if (input.mode === "off") return { block: null, log };
    const deps = input.deps ?? {};
    const env = deps.env ?? process.env;
    const now = deps.now ?? Date.now;
    log.ts = new Date(now()).toISOString();
    const msg = input.message ?? "";
    log.msg_len = msg.length;
    log.msg_hash = createHash("sha256").update(msg).digest("hex").slice(0, 12);
    const totalMs = posInt(env.FACTS_PICK_TIMEOUT_MS, 8000);
    const deadline = now() + totalMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let block: string | null = null;
    try {
      block = await Promise.race([
        run(input, log, deadline),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new PickTimeout()), totalMs); }),
      ]);
    } catch (e) {
      log.error = e instanceof PickTimeout ? `timeout_${totalMs}ms` : `error: ${String(e).slice(0, 160)}`;
      block = null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    log.ms = Date.now() - started;
    try {
      const line = JSON.stringify(log);
      if (deps.logWriter) await deps.logWriter(line);
      else await defaultLogWriter(env.FACTS_PICK_SHADOW_LOG?.trim() || "/app/logs/facts-pick-shadow.jsonl", line);
    } catch { /* logging never fails the reply */ }
    console.log(
      `[facts-pick] ${input.companion} mode=${input.mode} shortlist=${log.shortlist?.length ?? 0} ` +
      `picks=${log.picks?.length ?? 0} inject=${log.would_inject?.length ?? 0} ms=${log.ms}` +
      (log.error ? ` error=${log.error.slice(0, 60)}` : ""),
    );
    return { block, log };
  } catch (e) {
    return { block: null, log: { ...log, error: `error: ${String(e).slice(0, 160)}` } };
  }
}
