// DeepInfra-by-default vendor precedence (2026-09-26).
//
// Raziel's rule: ALL DeepSeek-model inference goes through DeepInfra; direct DeepSeek is a ~$10
// emergency lane. The live worker is DeepInfra-first only because WORKER_INFERENCE_* points at
// DeepInfra -- remove that override and, before this, direct DeepSeek became PRIMARY even with
// DEEPINFRA_API_KEY in the same .env. These pin: DeepInfra key => DeepInfra primary, DeepSeek
// armed as fallback, no DeepSeek call when DeepInfra answers, a loud line when it falls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEYS = [
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPINFRA_API_KEY",
  "WORKER_INFERENCE_BASE_URL", "WORKER_INFERENCE_API_KEY", "WORKER_INFERENCE_MODEL",
  "WORKER_FALLBACK_BASE_URL", "WORKER_FALLBACK_API_KEY", "WORKER_FALLBACK_MODEL",
];
const saved: Record<string, string | undefined> = {};

function setEnv(env: Record<string, string>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

function reply(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 1 } }),
    text: async () => "",
  } as unknown as Response;
}
function fail(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => "nope" } as unknown as Response;
}

let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  vi.resetModules();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as typeof warn;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const warnLines = (): string[] => (warn.mock.calls as unknown[][]).map((c) => String(c[0]));

describe("vendor precedence without an override", () => {
  it("DEEPINFRA_API_KEY makes DeepInfra primary and arms direct DeepSeek as the fallback", async () => {
    setEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds", DEEPSEEK_MODEL: "deepseek-v4-flash" });
    const c = await import("../config.js");
    expect(c.DEEPSEEK_BASE_URL).toBe("https://api.deepinfra.com/v1/openai");
    expect(c.DEEPSEEK_API_KEY).toBe("di");
    // DEEPSEEK_MODEL is a platform id; it must not be sent to DeepInfra.
    expect(c.DEEPSEEK_MODEL).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(c.FALLBACK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(c.FALLBACK_API_KEY).toBe("ds");
    expect(c.FALLBACK_MODEL).toBe("deepseek-v4-flash");
  });

  it("with no DeepInfra key, direct DeepSeek is primary and no fallback is armed (unchanged)", async () => {
    setEnv({ DEEPSEEK_API_KEY: "ds" });
    const c = await import("../config.js");
    expect(c.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(c.DEEPSEEK_API_KEY).toBe("ds");
    expect(c.FALLBACK_BASE_URL).toBe("");
  });

  it("the WORKER_INFERENCE_* override still wins (live VPS shape)", async () => {
    setEnv({
      DEEPINFRA_API_KEY: "di-shared", DEEPSEEK_API_KEY: "ds",
      WORKER_INFERENCE_BASE_URL: "https://api.deepinfra.com/v1/openai",
      WORKER_INFERENCE_API_KEY: "di-worker", WORKER_INFERENCE_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
    });
    const c = await import("../config.js");
    expect(c.DEEPSEEK_API_KEY).toBe("di-worker");
    expect(c.FALLBACK_API_KEY).toBe("ds");
  });

  it("DeepInfra's DeepSeek id is a reasoning model (it used to get NO headroom)", async () => {
    setEnv({ DEEPSEEK_API_KEY: "ds" });
    const c = await import("../config.js");
    expect(c.isReasoningModel("deepseek-ai/DeepSeek-V4-Flash-0731")).toBe(true);
    expect(c.contentBudget(100, "deepseek-ai/DeepSeek-V4-Flash-0731")).toBe(100 + c.REASONING_HEADROOM);
    expect(c.isReasoningModel("google/gemma-3-27b-it")).toBe(false);
  });
});

describe("chat() on the DeepInfra-by-default chain", () => {
  it("never calls DeepSeek when DeepInfra answers", async () => {
    setEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" });
    const fetchMock = vi.fn(async () => reply("fine"));
    vi.stubGlobal("fetch", fetchMock);
    const { chat } = await import("../deepseek.js");
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toMatchObject({ content: "fine" });
    expect(fetchMock.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      "https://api.deepinfra.com/v1/openai/chat/completions",
    ]);
    expect(warnLines().some((l) => l.includes("FELL BACK"))).toBe(false);
  });

  it("falls to direct DeepSeek on a DeepInfra 503 and prints the FELL BACK line", async () => {
    setEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" });
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(reply("rescued"));
    vi.stubGlobal("fetch", fetchMock);
    const { chat, FELL_BACK_TAG } = await import("../deepseek.js");
    await expect(chat([{ role: "user", content: "hi" }], { maxTokens: 100 })).resolves.toMatchObject({ content: "rescued" });
    const calls = fetchMock.mock.calls as unknown[][];
    expect(calls.map((c) => String(c[0]))).toEqual([
      "https://api.deepinfra.com/v1/openai/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ]);
    const second = JSON.parse(String((calls[1]![1] as RequestInit).body));
    expect(second.model).toBe("deepseek-v4-flash");
    expect((calls[1]![1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer ds");
    expect(warnLines().find((l) => l.includes(FELL_BACK_TAG))).toContain("HTTP 503");
  });

  it("a 400 on DeepInfra does not spend the emergency lane", async () => {
    setEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" });
    const fetchMock = vi.fn(async () => fail(400));
    vi.stubGlobal("fetch", fetchMock);
    const { chat } = await import("../deepseek.js");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
