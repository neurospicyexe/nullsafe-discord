import { describe, it, expect } from "vitest";
import { decideSeedSource, ensureOutward, extractLiveText, pickOldestForage } from "../phases/seed.js";
import { INWARD_RE } from "@nullsafe/shared";
import type { PipelineContext } from "../types.js";
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
    ({ openLoops: openLoops.map(text => ({ text })), pressureFlags } as unknown as PipelineContext);

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
