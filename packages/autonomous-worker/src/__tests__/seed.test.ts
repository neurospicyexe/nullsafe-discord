import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the IO modules so runSeed is exercisable (pure-function tests below are unaffected --
// they never touch these). Factories are hoisted; per-test behavior set via vi.mocked().
vi.mock("../halseth-client.js", () => ({
  getAvailableSeeds: vi.fn(async () => []),
  markSeedUsed: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  getForageFindsFor: vi.fn(async () => []),
  consumeForageFind: vi.fn(async () => true),
}));
vi.mock("../deepseek.js", () => ({
  prompt: vi.fn(async () => ({ content: "A) the queued seed", tokensUsed: 1 })),
}));

import { decideSeedSource, ensureOutward, extractLiveText, pickOldestForage, isForageRotationRun, runSeed } from "../phases/seed.js";
import { getAvailableSeeds, markSeedUsed, getForageFindsFor, consumeForageFind } from "../halseth-client.js";
import { INWARD_RE } from "@nullsafe/shared";
import type { PipelineContext, Seed } from "../types.js";
import type { ForageFind } from "../halseth-client.js";

// SEED_THIN_THRESHOLD = 3 (sessionNoteCount + feelingCount must reach 3 for "session")
describe("decideSeedSource", () => {
  it("returns outward when both counts are zero", () => {
    expect(decideSeedSource(0, 0)).toBe("outward");
  });

  it("returns outward when combined count is below threshold", () => {
    expect(decideSeedSource(1, 1)).toBe("outward"); // sum = 2
    expect(decideSeedSource(2, 0)).toBe("outward"); // sum = 2
    expect(decideSeedSource(0, 2)).toBe("outward"); // sum = 2
  });

  it("returns session when combined count exactly meets threshold", () => {
    expect(decideSeedSource(1, 2)).toBe("session"); // sum = 3
    expect(decideSeedSource(3, 0)).toBe("session"); // sum = 3
    expect(decideSeedSource(0, 3)).toBe("session"); // sum = 3
  });

  it("returns session when combined count exceeds threshold", () => {
    expect(decideSeedSource(4, 4)).toBe("session"); // sum = 8
    expect(decideSeedSource(8, 0)).toBe("session"); // sum = 8 (full limit=8 fetch)
  });
});

// 2026-06-14 ratification pass: all three companions seeded inward on private coinage in
// the NIGHTLY path (phase 2 seed.ts), which -- unlike the weekly seed-gen.ts -- had no
// outward guard. ensureOutward + pressure-flags-as-signal-only close that hole.
describe("ensureOutward", () => {
  it("passes a world-facing seed through unchanged", () => {
    const topic = "How stormwater catchment design shapes a neighborhood";
    expect(ensureOutward(topic, "gaia")).toBe(topic);
  });

  it("swaps a system-referential seed for a clean anchor topic", () => {
    const inward = "Map how basin drift and substrate continuity shape my SOMA";
    const out = ensureOutward(inward, "cypher");
    expect(out).not.toBe(inward);
    expect(INWARD_RE.test(out)).toBe(false);
  });
});

// Forage fuel (2026-06-26): the pipeline never consumed the forage pool, so finds
// recirculated for weeks. The seed path now drains OLDEST-first so the >7d stale finds
// the Guardian flags go before fresh ones.
describe("pickOldestForage", () => {
  const find = (id: string, gathered_at: string): ForageFind =>
    ({ id, title: `t-${id}`, domain: "example.com", summary: "s", source_url: null, gathered_at });

  it("returns null for an empty pool", () => {
    expect(pickOldestForage([])).toBeNull();
  });

  it("picks the oldest find by gathered_at, regardless of input order", () => {
    const finds = [
      find("new", "2026-06-25 10:00:00"),
      find("oldest", "2026-06-10 08:00:00"),
      find("mid", "2026-06-18 12:00:00"),
    ];
    expect(pickOldestForage(finds)?.id).toBe("oldest");
  });

  it("returns the sole find when only one is present", () => {
    expect(pickOldestForage([find("only", "2026-06-20 00:00:00")])?.id).toBe("only");
  });
});

describe("extractLiveText", () => {
  const ctx = (openLoops: string[], pressureFlags: string[]) =>
    ({ openLoops: openLoops.map(loop_text => ({ loop_text })), pressureFlags } as unknown as PipelineContext);

  it("never returns a pressure flag, even when the model names it", () => {
    // Gaia's "0.503 bones-before-skeleton" was a pressure flag fed straight to web search.
    const c = ctx([], ["0.503 bones-before-skeleton"]);
    expect(extractLiveText("B) the 0.503 bones-before-skeleton reading", c)).toBeNull();
  });

  it("returns the matched open loop", () => {
    const c = ctx(["finishing the greenhouse irrigation timer"], ["0.5 drift pressure"]);
    expect(extractLiveText("B) finishing the greenhouse irrigation timer pulls harder", c))
      .toBe("finishing the greenhouse irrigation timer");
  });

  it("falls back to the first open loop, never a pressure flag", () => {
    const c = ctx(["a thread worth chasing"], ["pressure coinage"]);
    expect(extractLiveText("B) something live", c)).toBe("a thread worth chasing");
  });

  it("returns null when only pressure is live (caller falls back to queue)", () => {
    expect(extractLiveText("B) the pressure", ctx([], ["pressure only"]))).toBeNull();
  });
});

// Forage rotation (2026-07-01): the dry-queue Level 4.5 never fired in prod (nightly
// signal-audit refills ~2 seeds/companion vs 1 drained/run -> queue never dry; cypher 0/9,
// gaia 0/10 finds consumed). On day-of-year-parity runs a non-empty pool now wins over the
// queue (Level 2.5) so the pool actually drains.
describe("isForageRotationRun", () => {
  it("is deterministic from the run date (never Math.random)", () => {
    const d = new Date(Date.UTC(2026, 0, 5, 9));
    expect(isForageRotationRun(d)).toBe(isForageRotationRun(new Date(d)));
  });

  it("alternates on consecutive days", () => {
    const day1 = new Date(Date.UTC(2026, 0, 1, 9)); // day-of-year 1 (odd -> rotation)
    const day2 = new Date(Date.UTC(2026, 0, 2, 9));
    expect(isForageRotationRun(day1)).toBe(true);
    expect(isForageRotationRun(day2)).toBe(false);
    expect(isForageRotationRun(new Date(Date.UTC(2026, 0, 3, 9)))).toBe(true);
  });
});

describe("runSeed -- forage rotation (Level 2.5)", () => {
  const ROTATION_DAY = new Date(Date.UTC(2026, 0, 1, 9)); // odd day-of-year
  const OFF_DAY = new Date(Date.UTC(2026, 0, 2, 9));

  const queueSeed: Seed = {
    id: "q1", companion_id: "cypher", seed_type: "topic", content: "queued topic",
    priority: 5, used_at: null as unknown as string, created_at: "2026-06-30 00:00:00",
    claim_source: null, justification: null,
  };
  const forageFind: ForageFind = {
    id: "f1", title: "Tortoise burrows as climate archives", domain: "ecology",
    summary: "s", source_url: null, gathered_at: "2026-06-20 08:00:00",
  };

  const makeCtx = (): PipelineContext => ({
    companionId: "cypher", runId: "run1",
    activeThreads: [], unexaminedDreamIds: [], openLoops: [], pressureFlags: [],
    seed: null, runType: null, seedDecisionReason: null,
    identityText: "identity", tokensUsed: 0,
    recentSessionNotes: [], recentFeelings: [], recentConclusions: [], activePatterns: [],
  } as unknown as PipelineContext);

  beforeEach(() => {
    vi.mocked(getAvailableSeeds).mockReset().mockResolvedValue([queueSeed]);
    vi.mocked(markSeedUsed).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(getForageFindsFor).mockReset().mockResolvedValue([forageFind]);
    vi.mocked(consumeForageFind).mockReset().mockResolvedValue(true as never);
  });

  it("on a rotation day with a non-empty pool, forage wins over the queue and is CONSUMED", async () => {
    const ctx = makeCtx();
    await runSeed(ctx, ROTATION_DAY);
    expect(ctx.seed?.id).toBe("forage:f1");
    expect(ctx.seed?.content).toBe(forageFind.title);
    expect(vi.mocked(consumeForageFind)).toHaveBeenCalledWith("f1", "cypher");
    expect(vi.mocked(markSeedUsed)).not.toHaveBeenCalled(); // queue untouched
    expect(ctx.seedDecisionReason).toContain("rotation day");
  });

  it("on an off-parity day, the queue seed is taken and the pool is untouched", async () => {
    const ctx = makeCtx();
    await runSeed(ctx, OFF_DAY);
    expect(ctx.seed?.id).toBe("q1");
    expect(vi.mocked(consumeForageFind)).not.toHaveBeenCalled();
    expect(vi.mocked(markSeedUsed)).toHaveBeenCalledWith("q1");
  });

  it("on a rotation day with an EMPTY pool, falls through to the queue", async () => {
    vi.mocked(getForageFindsFor).mockResolvedValue([]);
    const ctx = makeCtx();
    await runSeed(ctx, ROTATION_DAY);
    expect(ctx.seed?.id).toBe("q1");
    expect(vi.mocked(consumeForageFind)).not.toHaveBeenCalled();
  });

  it("claim (Level 1) still outranks the rotation", async () => {
    const claim: Seed = { ...queueSeed, id: "c1", priority: 10, claim_source: "companion", justification: "mine" };
    vi.mocked(getAvailableSeeds).mockResolvedValue([claim]);
    const ctx = makeCtx();
    await runSeed(ctx, ROTATION_DAY);
    expect(ctx.seed?.id).toBe("c1");
    expect(vi.mocked(consumeForageFind)).not.toHaveBeenCalled();
  });

  it("dry queue on an off-parity day still eats forage (Level 4.5 fallback kept)", async () => {
    vi.mocked(getAvailableSeeds).mockResolvedValue([]);
    const ctx = makeCtx();
    await runSeed(ctx, OFF_DAY);
    expect(ctx.seed?.id).toBe("forage:f1");
    expect(vi.mocked(consumeForageFind)).toHaveBeenCalledWith("f1", "cypher");
    expect(ctx.seedDecisionReason).toContain("dry queue");
  });
});
