import { relativeTime, stampRelative } from "../relative-time.js";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const agoMs = (ms: number) => NOW - ms;
const H = 3_600_000, D = 24 * H;

describe("relativeTime", () => {
  it("buckets recent moments", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * H), NOW)).toBe("3 hours ago");
  });

  it("distinguishes yesterday from 2+ days ago (the reported commons bug)", () => {
    expect(relativeTime(ago(1 * D), NOW)).toBe("yesterday");
    expect(relativeTime(ago(2 * D), NOW)).toBe("2 days ago");
  });

  it("degrades safely on null/garbage", () => {
    expect(relativeTime(null, NOW)).toBe("recently");
    expect(relativeTime("nope", NOW)).toBe("recently");
  });
});

describe("stampRelative", () => {
  it("prefixes turns older than 'just now' with their relative age", () => {
    const out = stampRelative([
      { role: "user", content: "morning question", timestamp: agoMs(3 * H) },
    ], NOW);
    expect(out[0].content).toBe("[3 hours ago] morning question");
  });

  it("leaves 'just now' turns unstamped so active back-and-forth stays clean", () => {
    const out = stampRelative([
      { role: "user", content: "right now", timestamp: agoMs(10_000) },
    ], NOW);
    expect(out[0].content).toBe("right now");
  });

  it("passes through turns with no timestamp (DB-restored history)", () => {
    const out = stampRelative([
      { role: "assistant", content: "no stamp" },
    ], NOW);
    expect(out[0].content).toBe("no stamp");
  });

  it("ignores a non-finite timestamp instead of throwing", () => {
    const out = stampRelative([
      { role: "user", content: "nan stamp", timestamp: Number.NaN },
    ], NOW);
    expect(out[0].content).toBe("nan stamp");
  });

  it("does not mutate the input array or its entries (STM stays raw)", () => {
    const input = [{ role: "user" as const, content: "keep raw", timestamp: agoMs(2 * D) }];
    const out = stampRelative(input, NOW);
    expect(input[0].content).toBe("keep raw");
    expect(out[0]).not.toBe(input[0]);
    expect(out[0].content).toBe("[2 days ago] keep raw");
  });
});
