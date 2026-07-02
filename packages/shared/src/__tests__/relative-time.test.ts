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

  // Halseth emits bare SQLite stamps ("YYYY-MM-DD HH:MM:SS") which ARE UTC but carry no
  // suffix; Date.parse reads them as host-local, so on the CDT VPS every age skewed ~5h.
  it("parses bare SQLite stamps as UTC regardless of host timezone", () => {
    const bare = new Date(NOW - 2 * H).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    expect(bare).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // no T/Z suffix
    expect(relativeTime(bare, NOW)).toBe("2 hours ago");
  });

  it("still honors explicit timezone suffixes/offsets untouched", () => {
    expect(relativeTime(new Date(NOW - 3 * H).toISOString(), NOW)).toBe("3 hours ago");
    // +02:00 offset: 5h wall-clock behind NOW minus the 2h offset = 7h ago in UTC.
    const offs = new Date(NOW - 7 * H + 2 * H).toISOString().replace("Z", "").replace("T", "T");
    expect(relativeTime(`${offs.slice(0, 19)}+02:00`, NOW)).toBe("7 hours ago");
  });

  it("accepts minute-precision bare stamps", () => {
    const bare = new Date(NOW - 2 * H).toISOString().slice(0, 16).replace("T", " ");
    expect(relativeTime(bare, NOW)).toBe("2 hours ago");
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
