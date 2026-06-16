import { jest, beforeAll, afterEach } from "@jest/globals";
import { formatSearchReply, formatImageReply, handleCouncilConvene } from "../tools-command.js";
import { CHANNEL } from "../events.js";

describe("formatSearchReply", () => {
  test("lists found results as a deterministic ack (title + url)", () => {
    const out = formatSearchReply("rome weather", [
      { title: "Rome forecast", url: "https://w.test/rome", snippet: "sunny", score: 0.9 },
      { title: "Climate", url: "https://w.test/clim", snippet: "warm", score: 0.6 },
    ]);
    expect(out).toContain("rome weather");
    expect(out).toContain("2 result");
    expect(out).toContain("Rome forecast");
    expect(out).toContain("https://w.test/rome");
  });

  test("handles an empty result set without throwing", () => {
    const out = formatSearchReply("obscure thing", []);
    expect(out).toContain("0 result");
  });

  test("caps the number of listed results to keep the message Discord-safe", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `R${i}`, url: `https://x.test/${i}`, snippet: "s", score: 0.5,
    }));
    const out = formatSearchReply("q", many);
    // at most 5 bullets listed
    expect((out.match(/\n•/g) ?? []).length).toBeLessThanOrEqual(5);
  });
});

describe("formatImageReply", () => {
  test("returns the ack text plus the image url to attach", () => {
    const out = formatImageReply("a black truck at dusk", { url: "https://h.test/mind/tools/image/abc", key: "tool-images/drevan/abc.png" });
    expect(out.text).toContain("a black truck at dusk");
    expect(out.imageUrl).toBe("https://h.test/mind/tools/image/abc");
  });

  test("omits the attachment when no url is present", () => {
    const out = formatImageReply("x", { url: "", key: "" });
    expect(out.imageUrl).toBeUndefined();
  });
});

describe("handleCouncilConvene wake publishing", () => {
  const realFetch = global.fetch;
  beforeAll(() => {
    process.env["HALSETH_URL"] = "https://h.test";
    process.env["HALSETH_SECRET"] = "secret";
  });
  afterEach(() => { global.fetch = realFetch; });

  function fakeRedis() {
    return { publish: jest.fn().mockResolvedValue(1) };
  }

  test("publishes a council wake when convene succeeds and redis is provided", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
    const redis = fakeRedis();
    const reply = await handleCouncilConvene("should we ship?", redis as never);
    expect(reply).toContain("council convened on");
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledWith(CHANNEL.wake, expect.stringContaining("\"kind\":\"council\""));
  });

  test("does NOT publish when the convene call fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as typeof fetch;
    const redis = fakeRedis();
    const reply = await handleCouncilConvene("q", redis as never);
    expect(reply).toContain("couldn't convene the council");
    expect(redis.publish).not.toHaveBeenCalled();
  });

  test("does not throw and still acks when redis is absent", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }) as unknown as typeof fetch;
    const reply = await handleCouncilConvene("q", null);
    expect(reply).toContain("council convened on");
  });

  test("rejects an empty question before any network or publish", async () => {
    const redis = fakeRedis();
    const reply = await handleCouncilConvene("   ", redis as never);
    expect(reply).toContain("give the council a question");
    expect(redis.publish).not.toHaveBeenCalled();
  });
});
