import { relativeTime } from "../relative-time.js";

const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
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
