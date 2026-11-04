import { describe, it, expect, jest } from "@jest/globals";
import { normalizeBlocks, BLOCK_CONTENT_MAX, BLOCK_BATCH_MAX } from "../distillation.js";
import { isPermanentWriteError, isDeterministicHttp4xx } from "../write-queue.js";
import { refreshStaggerMs } from "../bot-core.js";

describe("normalizeBlocks (Halseth /persona-blocks contract)", () => {
  it("passes valid blocks unchanged and logs nothing", () => {
    const log = jest.fn();
    const out = normalizeBlocks([{ block_type: "memory", content: "a" }, { block_type: "agent", content: "b" }], "x", log);
    expect(out).toEqual([{ block_type: "memory", content: "a" }, { block_type: "agent", content: "b" }]);
    expect(log).not.toHaveBeenCalled();
  });
  it("lowercases known types and maps unknown types to memory", () => {
    const log = jest.fn();
    const out = normalizeBlocks([{ block_type: "Relationship", content: "a" }, { block_type: "feeling", content: "b" }, { content: "c" }], "x", log);
    expect(out.map((b) => b.block_type)).toEqual(["relationship", "memory", "memory"]);
    expect(String(log.mock.calls[0]![0])).toContain("retyped=3");
  });
  it("drops empty and non-string content, clamps long content, caps the batch", () => {
    const log = jest.fn();
    const many = Array.from({ length: BLOCK_BATCH_MAX + 3 }, () => ({ block_type: "memory", content: "z" }));
    const out = normalizeBlocks([{ block_type: "memory", content: "   " }, { block_type: "memory", content: 7 }, null, { block_type: "memory", content: "y".repeat(BLOCK_CONTENT_MAX + 50) }, ...many], "x", log);
    expect(out.length).toBe(BLOCK_BATCH_MAX);
    expect(out[0]!.content.length).toBe(BLOCK_CONTENT_MAX);
    expect(String(log.mock.calls[0]![0])).toMatch(/dropped=3 clamped=1 capped=4/);
  });
  it("is empty for non-arrays and never logs content", () => {
    expect(normalizeBlocks("nope")).toEqual([]);
    const log = jest.fn();
    normalizeBlocks([{ block_type: "x", content: "secret words" }], "x", log);
    expect(String(log.mock.calls[0]![0])).not.toContain("secret");
  });
});

describe("plain HTTP 4xx from a direct writer is permanent", () => {
  it("400/404/422 are permanent, 408/429/5xx are not", () => {
    expect(isPermanentWriteError(new Error("writePersonaBlocks 400: Invalid block entry"))).toBe(true);
    expect(isPermanentWriteError(new Error("writeHumanBlocks 404"))).toBe(true);
    expect(isDeterministicHttp4xx("stmWrite 422")).toBe(true);
    expect(isPermanentWriteError(new Error("writeHumanBlocks 408"))).toBe(false);
    expect(isPermanentWriteError(new Error("writeHumanBlocks 429"))).toBe(false);
    expect(isPermanentWriteError(new Error("writeHumanBlocks 503"))).toBe(false);
    expect(isPermanentWriteError(new Error("fetch failed"))).toBe(false);
  });
  it("keeps the existing declined/ack markers", () => {
    expect(isPermanentWriteError(new Error("x declined: no"))).toBe(true);
  });
});

describe("refreshStaggerMs", () => {
  it("spreads the three companions across the period", () => {
    const p = 300_000;
    expect(refreshStaggerMs("cypher", p)).toBe(0);
    expect(refreshStaggerMs("drevan", p)).toBe(100_000);
    expect(refreshStaggerMs("gaia", p)).toBe(200_000);
  });
});
