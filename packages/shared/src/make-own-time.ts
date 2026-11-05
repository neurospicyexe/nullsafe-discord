// make-own-time.ts -- the `make` move's own daily slot (2026-11-05).
//
// Measured on the VPS 11-03..11-05: making was one row in the heartbeat palette, so it competed for the
// same single slot as reaching Raziel, and heartbeats only come every 4h per companion on rotation.
// This decouples it: once per Chicago day per companion (Cypher and Drevan; Gaia never) the companion is
// offered a make in its own turn. NONE is still free and costs nothing. The move posts nothing to
// Discord, so quiet hours do not apply, but it never runs while Raziel is active.
//
// MAKE_OWN_TIME: off|shadow|on, code default ON. MAKE_MOVE=off also kills it. Logs carry ids, counts and
// numbers only, never generated text.

import type { AutonomousContext } from "./autonomous-core.js";
import { skipIfActive } from "./autonomous-core.js";
import { getLastActivityMs } from "./floor.js";
import { chicagoParts } from "./blue-note.js";
import { fetchFerment, decidePace, makeMoveOn, mayMake, runMakeMove, type FetchLike } from "./make-move.js";

export type MakeOwnTimeMode = "off" | "shadow" | "on";

export const MAKE_OWN_TIME_RECENT_MS = 20 * 3_600_000;
const RECENT_ACTIVITY_MS = 15 * 60 * 1000;
const CLAIM_TTL_S = 172_800;

/** off/0/false/no = off; shadow = log only; anything else (unset, junk) = on. */
export function makeOwnTimeMode(env: NodeJS.ProcessEnv = process.env): MakeOwnTimeMode {
  const v = String(env["MAKE_OWN_TIME"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "shadow") return "shadow";
  return "on";
}

/** Newest created_at (ms) in a GET /mind/makes/:companion body, or null when none/unreadable. */
export function newestMakeMs(body: unknown): number | null {
  const makes = (body as { makes?: Array<{ created_at?: unknown }> } | null)?.makes;
  if (!Array.isArray(makes)) return null;
  let best: number | null = null;
  for (const m of makes) {
    if (typeof m?.created_at !== "string") continue;
    const iso = /Z|[+-]\d\d:?\d\d$/.test(m.created_at) ? m.created_at : `${m.created_at.replace(" ", "T")}Z`;
    const t = Date.parse(iso);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

async function madeRecently(url: string, secret: string, companionId: string, now: number, fetchFn: FetchLike): Promise<boolean> {
  try {
    const res = await fetchFn(`${url.replace(/\/$/, "")}/mind/makes/${encodeURIComponent(companionId)}?limit=5`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const t = newestMakeMs(await res.json());
    return t !== null && now - t < MAKE_OWN_TIME_RECENT_MS;
  } catch { return false; }
}

export async function runMakeOwnTime(
  ctx: AutonomousContext,
  now: number = Date.now(),
  opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchLike } = {},
): Promise<void> {
  const id = ctx.companionId;
  if (!mayMake(id)) return;
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const log = (outcome: string, extra = ""): void => console.log(`[make-own-time] ${id} outcome=${outcome}${extra ? ` ${extra}` : ""}`);
  try {
    const mode = makeOwnTimeMode(env);
    if (mode === "off" || !makeMoveOn(env)) { log("skip:off"); return; }
    const url = env["HALSETH_URL"] ?? "";
    if (!url) { log("skip:no_halseth_url"); return; }

    if (skipIfActive(ctx, "make-own-time")) { log("skip:active"); return; }
    if (ctx.redis) {
      const last = await getLastActivityMs(ctx.redis).catch(() => null);
      if (last !== null && now - last < RECENT_ACTIVITY_MS) { log("skip:recent_activity", `min_ago=${Math.round((now - last) / 60_000)}`); return; }
    }

    const halseth = { url, secret: ctx.halsethSecret, fetchFn };
    const verdict = decidePace(await fetchFerment(halseth, id));
    if (verdict.pace === "flat") { log("skip:flat", `mood=${verdict.mood?.toFixed(2) ?? "na"}`); return; }

    if (!ctx.redis) { log("skip:no_redis"); return; }
    const key = `ns:makeowntime:${id}:${chicagoParts(now).date}`;
    const claimed = (await ctx.redis.set(key, "1", "EX", CLAIM_TTL_S, "NX").catch(() => null)) === "OK";
    if (!claimed) { log("skip:already_ran_today"); return; }

    if (await madeRecently(url, ctx.halsethSecret, id, now, fetchFn)) { log("skip:made_recently"); return; }

    if (mode === "shadow") { log("would_offer", `pace=${verdict.pace}`); return; }

    const result = await runMakeMove({
      companionId: id,
      halseth,
      generate: (p) => ctx.inference.generate(ctx.bootCtx.systemPrompt, [{ role: "user", content: p }]),
      dryRun: false,
      env,
    });
    log(result.outcome, `pace=${verdict.pace}`);
  } catch (e) {
    log("error", `err=${e instanceof Error ? e.name : "unknown"}`);
  }
}
