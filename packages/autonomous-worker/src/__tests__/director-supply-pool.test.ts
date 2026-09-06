import { describe, it, expect } from "vitest";
import { createSupplyPool } from "../director/supply.js";
import type { DirectorSupplyItem } from "@nullsafe/shared";
import type { Redis } from "@nullsafe/shared";

const createFakeRedis = (): Redis & { setCalls: Array<{ key: string; value: string }> } => {
  const store = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string }> = [];
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); setCalls.push({ key, value }); },
    setCalls,
  } as any;
};

const item = (owner: string, id: string, createdAt: string): DirectorSupplyItem => ({
  kind: "project",
  id,
  table: "companion_projects",
  owner,
  title: id,
  body: "",
  created_at: createdAt,
  heat: null,
  consumed_by: [],
});

describe("supply pool", () => {
  it("first poll with no stored cursor uses since of now-7d and stores response cursor", async () => {
    const T = 1000;
    const fetched: Array<{ since: string; limit: number }> = [];
    const fetch = async (since: string, limit: number) => {
      fetched.push({ since, limit });
      return {
        items: [item("cypher", "p1", "2026-08-30")],
        cursor: "2026-09-01T00:00:00.000Z",
      };
    };
    const redis = createFakeRedis();
    const pool = createSupplyPool({ fetch, redis, now: () => T });

    await pool.poll();

    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.since).toBe(new Date(T - 7 * 24 * 3600_000).toISOString());
    expect(await redis.get("director:supply:cursor")).toBe("2026-09-01T00:00:00.000Z");
    expect(pool.items()).toEqual([item("cypher", "p1", "2026-08-30")]);
  });

  it("a failed fetch (throws) leaves cursor unchanged and pool intact", async () => {
    const T = 1000;
    const redis = createFakeRedis();
    await redis.set("director:supply:cursor", "2026-08-30T00:00:00.000Z");

    let pollCount = 0;
    const fetch = async () => {
      pollCount++;
      if (pollCount === 1) {
        return { items: [item("cypher", "p1", "2026-08-30")], cursor: "2026-09-01T00:00:00.000Z" };
      }
      throw new Error("Network error");
    };

    const pool = createSupplyPool({ fetch, redis, now: () => T });
    await pool.poll();
    expect(pool.items()).toHaveLength(1);

    await pool.poll();
    expect(pool.items()).toHaveLength(1);
    expect(await redis.get("director:supply:cursor")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("items() evicts entries older than 7 days", async () => {
    const T = 1000;
    const fetch = async () => ({
      items: [
        item("cypher", "p1", new Date(T - 8 * 24 * 3600_000).toISOString()), // older than 7d
        item("cypher", "p2", new Date(T - 6 * 24 * 3600_000).toISOString()), // within 7d
      ],
      cursor: "2026-09-01T00:00:00.000Z",
    });

    const pool = createSupplyPool({ fetch, redis: null, now: () => T });
    await pool.poll();

    const items = pool.items();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("p2");
  });

  it("remove(id) drops one item", async () => {
    const T = 1000;
    const fetch = async () => ({
      items: [
        item("cypher", "p1", "2026-08-30"),
        item("cypher", "p2", "2026-08-30"),
      ],
      cursor: "2026-09-01T00:00:00.000Z",
    });

    const pool = createSupplyPool({ fetch, redis: null, now: () => T });
    await pool.poll();
    expect(pool.items()).toHaveLength(2);

    pool.remove("p1");
    expect(pool.items()).toHaveLength(1);
    expect(pool.items()[0]!.id).toBe("p2");
  });

  it("duplicate ids across polls are merged (one entry)", async () => {
    const T = 1000;
    let pollCount = 0;
    const fetch = async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          items: [item("cypher", "p1", "2026-08-30")],
          cursor: "2026-08-31T00:00:00.000Z",
        };
      }
      return {
        items: [
          item("cypher", "p1", "2026-08-30"), // same id, should merge
          item("cypher", "p2", "2026-08-30"),
        ],
        cursor: "2026-09-01T00:00:00.000Z",
      };
    };

    const pool = createSupplyPool({ fetch, redis: null, now: () => T });
    await pool.poll();
    expect(pool.items()).toHaveLength(1);

    await pool.poll();
    const items = pool.items();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(["p1", "p2"]));
  });

  it("cursor equal to current -> no-op, third poll advances it", async () => {
    const T = 1000;
    let pollCount = 0;
    const fetch = async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          items: [item("cypher", "p1", "2026-08-30")],
          cursor: "2026-09-01T00:00:00.000Z",
        };
      }
      if (pollCount === 2) {
        return { items: [], cursor: "2026-09-01T00:00:00.000Z" }; // cursor unchanged
      }
      return { items: [], cursor: "2026-09-02T00:00:00.000Z" }; // cursor advances
    };

    const redis = createFakeRedis();
    const pool = createSupplyPool({ fetch, redis, now: () => T });

    await pool.poll();
    // Only cursor writes are counted: the pool is persisted on every poll since 2026-09-06.
    const cursorSets = () => redis.setCalls.filter((c) => c.key === "director:supply:cursor");
    expect(cursorSets()).toHaveLength(1);
    expect(cursorSets()[0]).toEqual({ key: "director:supply:cursor", value: "2026-09-01T00:00:00.000Z" });

    await pool.poll();
    expect(cursorSets()).toHaveLength(1); // no new call when cursor equal

    await pool.poll();
    expect(cursorSets()).toHaveLength(2);
    expect(cursorSets()[1]).toEqual({ key: "director:supply:cursor", value: "2026-09-02T00:00:00.000Z" });
  });
});

describe("supply pool persistence across restarts (2026-09-06)", () => {
  const T = Date.parse("2026-09-06T12:00:00Z");
  const fresh = (id: string) => item("drevan", id, "2026-09-05T00:00:00.000Z");

  it("persists the pool beside the cursor on poll and on remove", async () => {
    const redis = createFakeRedis();
    const fetch = async () => ({ items: [fresh("a"), fresh("b")], cursor: "2026-09-06T00:00:00.000Z" });
    const pool = createSupplyPool({ fetch, redis, now: () => T });
    await pool.poll();
    expect(JSON.parse((await redis.get("director:supply:pool"))!)).toHaveLength(2);
    pool.remove("a");
    expect(JSON.parse((await redis.get("director:supply:pool"))!).map((p: DirectorSupplyItem) => p.id)).toEqual(["b"]);
  });

  it("a restarted worker reloads the persisted pool and resumes from the stored cursor (no rewind)", async () => {
    const redis = createFakeRedis();
    await redis.set("director:supply:cursor", "2026-09-06T00:00:00.000Z");
    await redis.set("director:supply:pool", JSON.stringify([fresh("kept")]));
    const fetched: string[] = [];
    const fetch = async (since: string) => { fetched.push(since); return { items: [], cursor: "2026-09-06T00:00:00.000Z" }; };
    const pool = createSupplyPool({ fetch, redis, now: () => T });
    await pool.poll();
    expect(fetched).toEqual(["2026-09-06T00:00:00.000Z"]);
    expect(pool.items().map((p) => p.id)).toEqual(["kept"]);
  });

  it("a persisted EMPTY pool is authoritative: keeps the cursor, does not rewind", async () => {
    const redis = createFakeRedis();
    await redis.set("director:supply:cursor", "2026-09-06T00:00:00.000Z");
    await redis.set("director:supply:pool", "[]");
    const fetched: string[] = [];
    const fetch = async (since: string) => { fetched.push(since); return { items: [], cursor: "2026-09-06T00:00:00.000Z" }; };
    const pool = createSupplyPool({ fetch, redis, now: () => T });
    await pool.poll();
    expect(fetched).toEqual(["2026-09-06T00:00:00.000Z"]);
  });

  it("a stored cursor with NO persisted pool (pre-persistence restart) rewinds 7d once to rebuild", async () => {
    const redis = createFakeRedis();
    await redis.set("director:supply:cursor", "2026-09-06T00:00:00.000Z");
    const fetched: string[] = [];
    const fetch = async (since: string) => { fetched.push(since); return { items: [fresh("old")], cursor: "2026-09-06T00:00:00.000Z" }; };
    const pool = createSupplyPool({ fetch, redis, now: () => T });
    await pool.poll();
    expect(fetched).toEqual([new Date(T - 7 * 24 * 3600_000).toISOString()]);
    expect(pool.items().map((p) => p.id)).toEqual(["old"]);
    await pool.poll();
    expect(fetched[1]).toBe("2026-09-06T00:00:00.000Z");
  });
});
