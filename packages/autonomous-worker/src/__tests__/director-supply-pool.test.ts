import { describe, it, expect } from "vitest";
import { createSupplyPool } from "../director/supply.js";
import type { DirectorSupplyItem } from "@nullsafe/shared";
import type { Redis } from "@nullsafe/shared";

const createFakeRedis = (): Redis => {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); },
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
});
