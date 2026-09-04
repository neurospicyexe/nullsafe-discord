// director/supply.ts -- the polled half of the stream (Halseth cannot push to Redis). A failed poll
// never advances the cursor; the pool evicts by age so a stale item cannot be offered forever.
import type { Redis, DirectorSupplyItem } from "@nullsafe/shared";

const CURSOR_KEY = "director:supply:cursor";
const POOL_CAP = 200;
const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface SupplyPool { items(): DirectorSupplyItem[]; poll(): Promise<void>; remove(id: string): void }

export function createSupplyPool(deps: { fetch: (since: string, limit: number) => Promise<{ items: DirectorSupplyItem[]; cursor: string }>; redis: Redis | null; now?: () => number }): SupplyPool {
  const now = deps.now ?? (() => Date.now());
  let pool: DirectorSupplyItem[] = [];
  let cursor: string | null = null;
  const byId = () => new Map(pool.map((p) => [p.id, p] as const));
  return {
    items() {
      const cutoff = new Date(now() - MAX_AGE_MS).toISOString();
      pool = pool.filter((p) => p.created_at >= cutoff);
      return pool;
    },
    remove(id) { pool = pool.filter((p) => p.id !== id); },
    async poll() {
      if (cursor === null) {
        cursor = (deps.redis ? await deps.redis.get(CURSOR_KEY).catch(() => null) : null) ?? new Date(now() - MAX_AGE_MS).toISOString();
      }
      let res: { items: DirectorSupplyItem[]; cursor: string };
      try { res = await deps.fetch(cursor, 40); }
      catch (e) { console.warn("[director/supply] poll failed, cursor held:", e); return; }
      const map = byId();
      for (const it of res.items) map.set(it.id, it);
      pool = [...map.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, POOL_CAP);
      if (res.cursor > cursor) {
        cursor = res.cursor;
        if (deps.redis) await deps.redis.set(CURSOR_KEY, cursor).catch(() => {});
      }
      console.log(`[director/supply] pool=${pool.length} cursor=${cursor}`);
    },
  };
}
