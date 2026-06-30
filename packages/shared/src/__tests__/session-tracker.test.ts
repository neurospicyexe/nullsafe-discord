import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { isIdle, markConsolidated, isConsolidated, clearConsolidation } from "../session-tracker.js";

const mockRedis = {
  _store: new Map<string, { value: string; expiresAt?: number }>(),
  async set(key: string, value: string, ...args: unknown[]) {
    let expiresAt: number | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (String(args[i]).toUpperCase() === "EX") {
        expiresAt = Date.now() + Number(args[i + 1]) * 1000;
      }
    }
    this._store.set(key, { value, expiresAt });
  },
  async get(key: string): Promise<string | null> {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  },
  async del(key: string) { this._store.delete(key); },
};

describe("session-tracker", () => {
  beforeEach(() => { (mockRedis as any)._store.clear(); });

  describe("isIdle (pure)", () => {
    test("returns false when no activity recorded", () => {
      expect(isIdle(null, 30)).toBe(false);
    });

    test("returns true when last activity was 40 min ago vs 30 min threshold", () => {
      expect(isIdle(Date.now() - 40 * 60 * 1000, 30)).toBe(true);
    });

    test("returns false when activity was 5 min ago", () => {
      expect(isIdle(Date.now() - 5 * 60 * 1000, 30)).toBe(false);
    });
  });

  describe("consolidated flag (Redis)", () => {
    test("markConsolidated + isConsolidated roundtrip", async () => {
      expect(await isConsolidated(mockRedis as any, "cypher")).toBe(false);
      await markConsolidated(mockRedis as any, "cypher", 7200);
      expect(await isConsolidated(mockRedis as any, "cypher")).toBe(true);
    });

    test("clearConsolidation removes the flag", async () => {
      await markConsolidated(mockRedis as any, "cypher", 7200);
      await clearConsolidation(mockRedis as any, "cypher");
      expect(await isConsolidated(mockRedis as any, "cypher")).toBe(false);
    });

    test("flags are per-companion (cypher flag does not affect drevan)", async () => {
      await markConsolidated(mockRedis as any, "cypher", 7200);
      expect(await isConsolidated(mockRedis as any, "drevan")).toBe(false);
    });
  });
});
