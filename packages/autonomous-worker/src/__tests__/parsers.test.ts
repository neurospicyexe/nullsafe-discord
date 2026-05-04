import { describe, it, expect } from "vitest";
import { stripJsonFence, sanitizeEvidence, sanitizeIdList, clampStrength } from "../parsers.js";

describe("stripJsonFence", () => {
  it("returns input unchanged when no fence present", () => {
    expect(stripJsonFence(`{"x":1}`)).toBe(`{"x":1}`);
  });

  it("strips ```json ... ``` fence", () => {
    expect(stripJsonFence("```json\n{\"x\":1}\n```")).toBe(`{"x":1}`);
  });

  it("strips bare ``` ... ``` fence", () => {
    expect(stripJsonFence("```\n{\"x\":1}\n```")).toBe(`{"x":1}`);
  });

  it("trims surrounding whitespace", () => {
    expect(stripJsonFence("   ```json\n{\"x\":1}\n```   ")).toBe(`{"x":1}`);
  });
});

describe("sanitizeEvidence", () => {
  it("returns [] for non-arrays", () => {
    expect(sanitizeEvidence(null)).toEqual([]);
    expect(sanitizeEvidence(undefined)).toEqual([]);
    expect(sanitizeEvidence("string")).toEqual([]);
    expect(sanitizeEvidence({ quote: "x" })).toEqual([]);
  });

  it("drops entries with short or missing quote", () => {
    const out = sanitizeEvidence([
      { quote: "tiny" },              // < 8 chars after trim -> drop
      { quote: "   " },               // empty after trim -> drop
      { },                            // missing quote -> drop
      { quote: "this quote is long enough" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.quote).toBe("this quote is long enough");
  });

  it("preserves source_url, source_id, source_companion when present and valid", () => {
    const out = sanitizeEvidence([{
      quote: "valid evidence quote here",
      source_url: "https://x.test/y",
      source_id: "abc-123",
      source_companion: "drevan",
    }]);
    expect(out[0]).toEqual({
      quote: "valid evidence quote here",
      source_url: "https://x.test/y",
      source_id: "abc-123",
      source_companion: "drevan",
    });
  });

  it("rejects unknown source_companion values (no schema injection)", () => {
    const out = sanitizeEvidence([{
      quote: "another valid quote",
      source_companion: "raziel",  // not in {cypher, drevan, gaia}
    }]);
    expect(out[0]!.source_companion).toBeUndefined();
  });

  it("truncates over-long quotes to 400 chars", () => {
    const long = "x".repeat(500);
    const out = sanitizeEvidence([{ quote: long }]);
    expect(out[0]!.quote.length).toBe(400);
  });

  it("caps array at 16 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ quote: `entry number ${i} long enough` }));
    expect(sanitizeEvidence(many)).toHaveLength(16);
  });

  it("ignores non-object array entries (model nonsense)", () => {
    const out = sanitizeEvidence([null, undefined, 42, "string", { quote: "the only valid entry" }]);
    expect(out).toHaveLength(1);
  });
});

describe("sanitizeIdList", () => {
  it("returns [] for non-arrays", () => {
    expect(sanitizeIdList(null)).toEqual([]);
    expect(sanitizeIdList("ab-cd-ef-gh")).toEqual([]);
  });

  it("strips entries that don't match UUID-shaped regex", () => {
    expect(sanitizeIdList(["abc12345", "not a uuid", "xx", "12345678-90ab-cdef-1234-567890abcdef"])).toEqual([
      "abc12345",
      "12345678-90ab-cdef-1234-567890abcdef",
    ]);
  });

  it("strips non-string entries", () => {
    expect(sanitizeIdList([null, 42, undefined, "12345678"])).toEqual(["12345678"]);
  });

  it("dedupes identical ids", () => {
    expect(sanitizeIdList(["abc12345", "abc12345", "abc12345"])).toEqual(["abc12345"]);
  });

  it("caps at 32 entries", () => {
    const many = Array.from({ length: 50 }, (_, i) => `${i.toString(16).padStart(8, "0")}`);
    expect(sanitizeIdList(many)).toHaveLength(32);
  });
});

describe("clampStrength", () => {
  it("clamps below 1 to 1", () => {
    expect(clampStrength(0)).toBe(1);
    expect(clampStrength(-3)).toBe(1);
  });

  it("clamps above 10 to 10", () => {
    expect(clampStrength(11)).toBe(10);
    expect(clampStrength(99)).toBe(10);
  });

  it("rounds non-integers", () => {
    expect(clampStrength(3.4)).toBe(3);
    expect(clampStrength(3.6)).toBe(4);
  });

  it("returns default 3 for non-numbers", () => {
    expect(clampStrength("5")).toBe(3);
    expect(clampStrength(null)).toBe(3);
    expect(clampStrength(undefined)).toBe(3);
    expect(clampStrength(NaN)).toBe(3);
    expect(clampStrength(Infinity)).toBe(3);
  });

  it("preserves valid integer values 1..10", () => {
    for (let n = 1; n <= 10; n++) expect(clampStrength(n)).toBe(n);
  });
});
