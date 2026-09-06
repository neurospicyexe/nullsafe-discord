// director/supply.ts -- the polled half of the stream (Halseth cannot push to Redis). A failed poll
// never advances the cursor; the pool evicts by age so a stale item cannot be offered forever.
//
// The pool is PERSISTED beside its cursor (2026-09-06). It was memory-only while the cursor lived in
// Redis, so every worker restart wiped the pool and kept the cursor: the next poll fetched only rows
// newer than the cursor, i.e. nothing, and the room went dark until new ritual rows trickled in
// (three restarts in three days, each one `pool=0` for 8-24h; the silence floor reads the same pool,
// so it could not re-open the room either). Raziel's read of the commons was exactly this: "we get so
// close and then we crash again". Both halves of the stream state now survive a restart together.
import type { Redis, DirectorSupplyItem } from "@nullsafe/shared";

const CURSOR_KEY = "director:supply:cursor";
const POOL_KEY = "director:supply:pool";
const POOL_CAP = 200;
const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface SupplyPool { items(): DirectorSupplyItem[]; poll(): Promise<void>; remove(id: string): void }

export function createSupplyPool(deps: { fetch: (since: string, limit: number) => Promise<{ items: DirectorSupplyItem[]; cursor: string }>; redis: Redis | null; now?: () => number }): SupplyPool {
  const now = deps.now ?? (() => Date.now());
  let pool: DirectorSupplyItem[] = [];
  let cursor: string | null = null;
  let loaded = false;
  const byId = () => new Map(pool.map((p) => [p.id, p] as const));
  const persistPool = () => {
    if (deps.redis) void deps.redis.set(POOL_KEY, JSON.stringify(pool)).catch(() => {});
  };
  return {
    items() {
      // Evicts in place: items() prunes expired entries as a side effect of the read.
      const cutoff = new Date(now() - MAX_AGE_MS).toISOString();
      const before = pool.length;
      pool = pool.filter((p) => p.created_at >= cutoff);
      if (pool.length !== before) persistPool();
      return pool;
    },
    remove(id) {
      pool = pool.filter((p) => p.id !== id);
      persistPool();
    },
    async poll() {
      if (!loaded) {
        loaded = true;
        const storedCursor = deps.redis ? await deps.redis.get(CURSOR_KEY).catch(() => null) : null;
        const storedPool = deps.redis ? await deps.redis.get(POOL_KEY).catch(() => null) : null;
        let poolKnown = false;
        if (storedPool !== null) {
          try {
            const parsed = JSON.parse(storedPool);
            if (Array.isArray(parsed)) { pool = parsed as DirectorSupplyItem[]; poolKnown = true; }
          } catch { /* unreadable pool: rebuild below */ }
        }
        // A stored cursor with NO stored pool is the pre-persistence shape (or a lost key): the items
        // between now-7d and the cursor exist in Halseth but would never be fetched again. Rewind
        // once so the room re-fills; an item offered before the restart may be offered a second time,
        // which is a repeat, not a hole. A persisted EMPTY pool ("[]") is authoritative -- every item
        // was genuinely offered -- so it keeps the cursor and does not rewind.
        if (storedCursor && poolKnown) {
          cursor = storedCursor;
        } else {
          if (storedCursor) console.log("[director/supply] cursor without a persisted pool -- rewinding 7d to rebuild");
          cursor = new Date(now() - MAX_AGE_MS).toISOString();
        }
      }
      let res: { items: DirectorSupplyItem[]; cursor: string };
      try { res = await deps.fetch(cursor!, 40); }
      catch (e) { console.warn("[director/supply] poll failed, cursor held:", e); return; }
      const map = byId();
      for (const it of res.items) map.set(it.id, it);
      pool = [...map.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, POOL_CAP);
      if (res.cursor > cursor!) {
        cursor = res.cursor;
        if (deps.redis) await deps.redis.set(CURSOR_KEY, cursor).catch(() => {});
      }
      persistPool();
      console.log(`[director/supply] pool=${pool.length} cursor=${cursor}`);
    },
  };
}
