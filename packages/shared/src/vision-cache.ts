// vision-cache.ts -- one VL call per image, shared by the three bots, off the turn's critical path.
//
// 2026-10-18 incident (Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md, P1 + P2): every bot described
// every image independently INSIDE its turn. Three concurrent VL calls hit one endpoint (29s, 48s, 60s,
// 75s timeout, 76s timeout), a superseded turn paid the describe and threw the reply away, and the next
// message carrying the same image described it again. Vision was ~85% of the delay; Hermes took 4-11s.
//
// Shape:
//   L0  per-process Map<key, promise>. A second request in this process awaits the SAME promise. The
//       promise is never tied to a turn or to `isSuperseded`, so a superseded retry cannot orphan or
//       restart it. This is the "describe runs detached" guarantee.
//   L1  Redis, shared by all three bots. Keyed by attachment id (no download needed on a retry) and by
//       sha256(bytes)+model id (survives a PluralKit re-upload: new attachment id, same bytes).
//   Lock  SET NX per sha so exactly one bot calls the model; the others poll the result key. The lock
//       owner writes the result BEFORE releasing, and a lock winner re-checks the result once it holds
//       the lock, so a loser that wakes just after the release does not describe a second time.
//   Fail-open  any Redis error degrades that run to a direct call; VISION_CACHE=off is today's behavior.
//
// P2 lives at the bottom: `VisionPrefetch` (start the describe at message arrival, in bot-core, like PK
// pairing) and `resolveSeenImages` (what the turn calls: bounded wait, never waits when superseded).
//
// Logs carry counts and ids only (attachment id or sha8). Never the CDN url (its `hm=` signature is
// bearer-ish) and never description text.

import { createHash } from "node:crypto";
import {
  VISION_MODEL, VISION_TIMEOUT_MS, prepareImage, describeDataUrl, safeName,
  type ImageLike, type SeenImage,
} from "./vision.js";

// -- Knobs ------------------------------------------------------------------------------------

function envInt(name: string, dflt: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

const OFF = new Set(["off", "0", "false", "no"]);
function envOn(name: string): boolean {
  return !OFF.has((process.env[name] ?? "").trim().toLowerCase());
}

/** VISION_CACHE, default ON. `off` = every describe is a direct call, as before this module. */
export function visionCacheEnabled(): boolean { return envOn("VISION_CACHE"); }
/** VISION_CACHE_TTL_S, default 6h. */
export function visionCacheTtlS(): number { return envInt("VISION_CACHE_TTL_S", 21_600); }
/** VISION_NEG_TTL_S, default 120s: a retry inside two minutes does not re-hit a struggling endpoint. */
export function visionNegTtlS(): number { return envInt("VISION_NEG_TTL_S", 120); }
/** VISION_PREFETCH, default ON. `off` = describe inside the turn, as before P2. */
export function visionPrefetchEnabled(): boolean { return envOn("VISION_PREFETCH"); }
/** VISION_TURN_BUDGET_MS, default 20s. 0 = wait for the full describe (the old behavior). */
export function visionTurnBudgetMs(): number { return envInt("VISION_TURN_BUDGET_MS", 20_000); }

export const LOCK_SLACK_MS = 15_000;
const L0_CAP = 200;

// -- Redis surface ----------------------------------------------------------------------------

/** The subset of ioredis this module needs; keeps it testable with a fake. */
export interface VisionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface VisionCacheOpts {
  companionId: string;
  redis: VisionRedis | null;
  /** Defaults to DEEPINFRA_API_KEY, read at call time. */
  apiKey?: () => string;
  /** Defaults to VISION_MODEL env then the module default, read at call time. */
  model?: () => string | undefined;
  fetchFn?: typeof fetch;
  describeTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface L0Entry {
  promise: Promise<string | null>;
  settled: boolean;
  value: string | null;
  expiresAt: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class VisionCache {
  private l0 = new Map<string, L0Entry>();
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: VisionCacheOpts) {
    this.pollMs = o.pollMs ?? 500;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
  }

  get companionId(): string { return this.o.companionId; }

  private model(): string { return (this.o.model?.() ?? (process.env["VISION_MODEL"] ?? "").trim()) || VISION_MODEL; }
  private apiKey(): string { return (this.o.apiKey?.() ?? process.env["DEEPINFRA_API_KEY"] ?? "").trim(); }
  private timeoutMs(): number { return this.o.describeTimeoutMs ?? VISION_TIMEOUT_MS; }

  private l0Key(img: ImageLike): string {
    if (img.id) return `att:${img.id}`;
    return `url:${createHash("sha256").update(img.url).digest("hex").slice(0, 16)}`;
  }

  private log(kind: string, startedAt: number, key: string): void {
    console.log(`[vision-cache] ${this.o.companionId} ${kind} ms=${this.now() - startedAt} key=${key}`);
  }

  /**
   * One image -> a description or null (null means "not seen"; the caller words it). Never throws.
   * Concurrent callers in this process share one promise; the work is detached from any turn.
   */
  describe(img: ImageLike): Promise<string | null> {
    const startedAt = this.now();
    if (!visionCacheEnabled()) return this.direct(img, startedAt);
    const key = this.l0Key(img);
    const existing = this.l0.get(key);
    if (existing && existing.expiresAt > this.now()) {
      const wasSettled = existing.settled;
      return existing.promise.then((v) => {
        this.log(wasSettled ? (v ? "hit" : "neg") : "wait", startedAt, key.replace(/^att:/, ""));
        return v;
      });
    }
    const entry: L0Entry = { promise: Promise.resolve(null), settled: false, value: null, expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = this.run(img, startedAt).catch(() => null).then((v) => {
      entry.settled = true;
      entry.value = v;
      entry.expiresAt = this.now() + (v ? visionCacheTtlS() : visionNegTtlS()) * 1000;
      return v;
    });
    this.l0.set(key, entry);
    while (this.l0.size > L0_CAP) {
      const oldest = this.l0.keys().next().value;
      if (oldest === undefined) break;
      this.l0.delete(oldest);
    }
    return entry.promise;
  }

  /** What is already known, without starting or waiting on anything. L0 then the attachment key. */
  async peek(img: ImageLike): Promise<string | null> {
    const e = this.l0.get(this.l0Key(img));
    if (e?.settled && e.value && e.expiresAt > this.now()) return e.value;
    const redis = this.o.redis;
    if (!redis || !img.id || !visionCacheEnabled()) return null;
    try { return (await redis.get(this.attKey(img.id))) || null; } catch { return null; }
  }

  private attKey(id: string): string { return `ns:vision:att:${this.model()}:${id}`; }
  private contentKey(sha: string): string { return `ns:vision:v1:${this.model()}:${sha}`; }

  /** VISION_CACHE=off path and the no-Redis path with no L0 benefit: download, describe, done. */
  private async direct(img: ImageLike, startedAt: number): Promise<string | null> {
    const apiKey = this.apiKey();
    if (!apiKey) return null;
    const doFetch = this.o.fetchFn ?? globalThis.fetch;
    try {
      const prepared = await prepareImage(img.url, doFetch, img.contentType ?? null);
      if (!prepared) return null;
      return await this.callModel(prepared.dataUrl);
    } finally {
      this.log("miss", startedAt, img.id ?? "noid");
    }
  }

  private callModel(dataUrl: string): Promise<string | null> {
    return describeDataUrl(dataUrl, {
      apiKey: this.apiKey(),
      model: this.model(),
      timeoutMs: this.timeoutMs(),
      fetchFn: this.o.fetchFn,
    });
  }

  private async run(img: ImageLike, startedAt: number): Promise<string | null> {
    const apiKey = this.apiKey();
    if (!apiKey) return null;
    const doFetch = this.o.fetchFn ?? globalThis.fetch;
    const redis = this.o.redis;
    const ttl = visionCacheTtlS();
    const negTtl = visionNegTtlS();
    const me = this.o.companionId;
    let redisOk = redis !== null;
    const r = async <T>(fn: (rd: VisionRedis) => Promise<T>): Promise<T | undefined> => {
      if (!redisOk || !redis) return undefined;
      try { return await fn(redis); } catch (e) {
        redisOk = false;
        console.warn(`[vision-cache] ${me} redis error, direct call: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    };
    const idKey = img.id ? this.attKey(img.id) : null;
    const idNeg = img.id ? `ns:vision:neg:att:${img.id}` : null;

    if (idKey) {
      const hit = await r((rd) => rd.get(idKey));
      if (hit) { this.log("hit", startedAt, img.id!); return hit; }
    }
    if (idNeg) {
      const neg = await r((rd) => rd.get(idNeg));
      if (neg) { this.log("neg", startedAt, img.id!); return null; }
    }

    const prepared = await prepareImage(img.url, doFetch, img.contentType ?? null);
    if (!prepared) {
      if (idNeg) await r((rd) => rd.set(idNeg, "1", "EX", negTtl));
      this.log("neg", startedAt, img.id ?? "noid");
      return null;
    }
    const sha8 = prepared.sha256.slice(0, 8);
    const cKey = this.contentKey(prepared.sha256);
    const nKey = `ns:vision:neg:${prepared.sha256}`;
    const lockKey = `ns:vision:lock:${prepared.sha256}`;
    const lockMs = this.timeoutMs() + LOCK_SLACK_MS;

    const finishHit = async (text: string, kind: string): Promise<string> => {
      if (idKey) await r((rd) => rd.set(idKey, text, "EX", ttl));
      this.log(kind, startedAt, sha8);
      return text;
    };
    const checkResult = async (): Promise<{ text?: string; neg?: boolean }> => {
      const c = await r((rd) => rd.get(cKey));
      if (c) return { text: c };
      const n = await r((rd) => rd.get(nKey));
      return n ? { neg: true } : {};
    };

    const first = await checkResult();
    if (first.text) return finishHit(first.text, "hit");
    if (first.neg) { this.log("neg", startedAt, sha8); return null; }

    const deadline = this.now() + lockMs * 2;
    let waited = false;
    for (;;) {
      if (!redisOk) break; // Redis down (or never configured): fall through to the direct call.
      const got = await r((rd) => rd.set(lockKey, me, "PX", lockMs, "NX"));
      if (!redisOk) break;
      if (got === "OK") {
        // Re-check under the lock: the previous owner writes its result before releasing.
        const again = await checkResult();
        if (again.text) { await r((rd) => rd.del(lockKey)); return finishHit(again.text, waited ? "lock-wait" : "hit"); }
        if (again.neg) { await r((rd) => rd.del(lockKey)); this.log("neg", startedAt, sha8); return null; }
        return this.describeAndStore(prepared.dataUrl, { idKey, idNeg, cKey, nKey, lockKey, ttl, negTtl }, r, startedAt, sha8);
      }
      // Another bot holds the lock. Poll its result; if the lock vanishes without one, the next
      // iteration's SET NX lets exactly one waiter take over.
      waited = true;
      await this.sleep(this.pollMs);
      const res = await checkResult();
      if (res.text) return finishHit(res.text, "lock-wait");
      if (res.neg) { this.log("neg", startedAt, sha8); return null; }
      if (this.now() > deadline) { this.log("neg", startedAt, sha8); return null; }
    }
    // Direct call (Redis unavailable): still one L0 promise per process.
    const text = await this.callModel(prepared.dataUrl);
    this.log("miss", startedAt, sha8);
    return text;
  }

  private async describeAndStore(
    dataUrl: string,
    k: { idKey: string | null; idNeg: string | null; cKey: string; nKey: string; lockKey: string; ttl: number; negTtl: number },
    r: <T>(fn: (rd: VisionRedis) => Promise<T>) => Promise<T | undefined>,
    startedAt: number,
    sha8: string,
  ): Promise<string | null> {
    let text: string | null = null;
    try {
      text = await this.callModel(dataUrl);
    } finally {
      // Result BEFORE release, always, so a waiter never sees "free lock, no result" for a finished call.
      if (text) {
        await r((rd) => rd.set(k.cKey, text!, "EX", k.ttl));
        if (k.idKey) await r((rd) => rd.set(k.idKey!, text!, "EX", k.ttl));
      } else {
        await r((rd) => rd.set(k.nKey, "1", "EX", k.negTtl));
        if (k.idNeg) await r((rd) => rd.set(k.idNeg!, "1", "EX", k.negTtl));
      }
      await r((rd) => rd.del(k.lockKey));
      this.log("miss", startedAt, sha8);
    }
    return text;
  }
}

/** Describe every picked image, serially (cap is 2), through the cache. */
export async function describeImagesCached(images: ImageLike[], cache: VisionCache): Promise<SeenImage[]> {
  const out: SeenImage[] = [];
  for (const img of images) out.push({ name: safeName(img.name), description: await cache.describe(img) });
  return out;
}

// -- Process singleton ------------------------------------------------------------------------

let shared: VisionCache | null = null;
/** One VisionCache per process (bot-core prefetch and the turn must share the L0 map). */
export function sharedVisionCache(companionId: string, redis: VisionRedis | null): VisionCache {
  if (!shared) shared = new VisionCache({ companionId, redis });
  return shared;
}
/** Test hook. */
export function resetSharedVisionCache(): void { shared = null; resetSharedPrefetch(); }

// -- P2: prefetch at arrival, bounded wait in the turn ----------------------------------------

/** messageId -> the in-flight describe started at event time. Capped, per process. */
export class VisionPrefetch {
  private byId = new Map<string, Promise<SeenImage[]>>();
  constructor(private cap = L0_CAP) {}

  /** Start (or return) the describe for a message. Never throws; the promise never rejects. */
  start(messageId: string, images: ImageLike[], cache: VisionCache): Promise<SeenImage[]> {
    const have = this.byId.get(messageId);
    if (have) return have;
    const p = describeImagesCached(images, cache).catch(() => images.map((i) => ({ name: safeName(i.name), description: null })));
    this.byId.set(messageId, p);
    while (this.byId.size > this.cap) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    return p;
  }

  get(messageId: string): Promise<SeenImage[]> | undefined { return this.byId.get(messageId); }
  get size(): number { return this.byId.size; }
}

let sharedPrefetch = new VisionPrefetch();
export function visionPrefetch(): VisionPrefetch { return sharedPrefetch; }
function resetSharedPrefetch(): void { sharedPrefetch = new VisionPrefetch(); }

export interface ResolveSeenOpts {
  messageId: string;
  picked: ImageLike[];
  cache: VisionCache;
  prefetch?: VisionPrefetch;
  /** Max wait for the describe. 0 = wait for all of it. */
  budgetMs: number;
  isSuperseded?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often a waiting turn re-checks `isSuperseded`. */
  superseedCheckMs?: number;
  /** Called once, only if the turn is actually going to wait (typing indicator). */
  onWait?: () => void;
}

async function fromCacheOnly(picked: ImageLike[], cache: VisionCache): Promise<SeenImage[]> {
  const out: SeenImage[] = [];
  for (const img of picked) out.push({ name: safeName(img.name), description: await cache.peek(img) });
  return out;
}

/**
 * What a turn calls instead of awaiting the describe itself.
 *  - superseded already: take whatever the cache holds, else "not seen". No wait, no new VL call.
 *  - otherwise: wait for the prefetched (or freshly started) describe up to the budget, polling
 *    `isSuperseded` so a turn that gets superseded mid-wait stops waiting. On expiry: cache-only
 *    read, else "not seen". The detached describe keeps running and lands in the cache, so the
 *    next turn finds it.
 */
export async function resolveSeenImages(o: ResolveSeenOpts): Promise<SeenImage[]> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const t0 = now();
  const tag = `[vision-cache] ${o.cache.companionId}`;
  if (o.isSuperseded?.()) {
    const out = await fromCacheOnly(o.picked, o.cache);
    console.log(`${tag} superseded-skip ms=${now() - t0} seen=${out.filter((s) => s.description).length}/${out.length}`);
    return out;
  }
  const prefetch = o.prefetch ?? visionPrefetch();
  const p = prefetch.get(o.messageId) ?? prefetch.start(o.messageId, o.picked, o.cache);
  o.onWait?.();
  const budget = o.budgetMs;
  const tick = o.superseedCheckMs ?? 250;
  const TIMED_OUT = Symbol("timeout");
  for (;;) {
    const remaining = budget > 0 ? budget - (now() - t0) : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      const out = await fromCacheOnly(o.picked, o.cache);
      console.log(`${tag} budget ms=${now() - t0} seen=${out.filter((s) => s.description).length}/${out.length}`);
      return out;
    }
    const slice = Math.min(tick, remaining);
    const winner = await Promise.race([p, sleep(slice).then(() => TIMED_OUT)]);
    if (winner !== TIMED_OUT) return winner as SeenImage[];
    if (o.isSuperseded?.()) {
      const out = await fromCacheOnly(o.picked, o.cache);
      console.log(`${tag} superseded-skip ms=${now() - t0} seen=${out.filter((s) => s.description).length}/${out.length}`);
      return out;
    }
  }
}
