// Vendor failover (2026-08-23).
//
// The worker's first morning on Morph: the key was valid (probes 200'd before and after), but
// every call from 05:15 to 09:00 CDT got 401 invalid_api_key back -- a vendor-side auth flap.
// The worker had NO fallback, so all three night runs died with zero life produced (and each
// still debited its companion's weekly budget before failing). These pin the failover rules:
//
//   * 401/403/429/5xx and network errors on the PRIMARY fail over mid-call to the fallback
//     vendor, without spending the truncation-retry attempt.
//   * 400 is deterministic (the payload is wrong on every vendor) -- it stays fatal.
//   * No fallback configured -> the old behavior, error thrown, loud.
//   * Failover happens at most once per call: fallback errors are terminal.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env["DEEPSEEK_API_KEY"] = "primary-key";
process.env["DEEPSEEK_BASE_URL"] = "https://primary.example/v1";
process.env["WORKER_FALLBACK_BASE_URL"] = "https://fallback.example/v1";
process.env["WORKER_FALLBACK_API_KEY"] = "fallback-key";
process.env["WORKER_FALLBACK_MODEL"] = "deepseek-v4-flash";

const { chat } = await import("../deepseek.js");

function okReply(content: string): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { total_tokens: 10, completion_tokens_details: { reasoning_tokens: 0 } },
    }),
  } as unknown as Response;
}

function errReply(status: number, body = "vendor said no"): Response {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  warnSpy = vi.fn();
  vi.spyOn(console, "warn").mockImplementation(warnSpy as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const urlOf = (call: unknown[]): string => String(call[0]);
const authOf = (call: unknown[]): string =>
  String(((call[1] as RequestInit).headers as Record<string, string>)["Authorization"]);

describe("chat vendor failover", () => {
  it("401 on primary fails over to the fallback vendor with the fallback key", async () => {
    fetchSpy.mockResolvedValueOnce(errReply(401)).mockResolvedValueOnce(okReply("alive"));
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("alive");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchSpy.mock.calls[0]!)).toContain("primary.example");
    expect(urlOf(fetchSpy.mock.calls[1]!)).toContain("fallback.example");
    expect(authOf(fetchSpy.mock.calls[1]!)).toBe("Bearer fallback-key");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failing over"));
  });

  it("network error on primary fails over the same way", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(okReply("alive"));
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("alive");
    expect(urlOf(fetchSpy.mock.calls[1]!)).toContain("fallback.example");
  });

  it("400 is deterministic: no failover, error thrown", async () => {
    fetchSpy.mockResolvedValueOnce(errReply(400, "bad payload"));
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow("DeepSeek API error 400");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fallback errors are terminal -- no ping-pong", async () => {
    fetchSpy.mockResolvedValueOnce(errReply(401)).mockResolvedValueOnce(errReply(503));
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow("DeepSeek API error 503");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("failover does not consume the reasoning-starved retry attempt", async () => {
    const starved = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { total_tokens: 5, completion_tokens_details: { reasoning_tokens: 5 } },
      }),
    } as unknown as Response;
    fetchSpy
      .mockResolvedValueOnce(errReply(429))      // primary rate-limited -> failover
      .mockResolvedValueOnce(starved)            // fallback attempt 0: starved
      .mockResolvedValueOnce(okReply("finally")); // fallback attempt 1 (the retry) succeeds
    const r = await chat([{ role: "user", content: "hi" }]);
    expect(r.content).toBe("finally");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
