import { jest, describe, it, expect } from "@jest/globals";
import { createAdapter, samplingParamsFor } from "../inference.js";
import type { ChatMessage } from "../types.js";

describe("DeepSeekAdapter", () => {
  it("returns generated text on success", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from deepseek" } }],
      }),
    } as any);
    const adapter = createAdapter("deepseek", "deepseek-chat", { deepseek: "key-xxx" }, {}, mockFetch as any);
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await adapter.generate("system", msgs);
    expect(result).toBe("hello from deepseek");
  });

  it("retries on 5xx, returns null after second failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as any);
    const adapter = createAdapter("deepseek", "deepseek-chat", { deepseek: "key-xxx" }, {}, mockFetch as any);
    const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("createAdapter fallback chain (Finding 4b)", () => {
  it("falls through to Kimi when DeepSeek fails", async () => {
    // DeepSeek (primary) 503s on both attempts; Kimi (moonshot) then succeeds.
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes("deepseek.com")) return { ok: false, status: 503 } as any;
      if (url.includes("moonshot.ai")) {
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "hello from kimi" } }] }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    const adapter = createAdapter(
      "deepseek", "deepseek-chat",
      { deepseek: "dk", kimi: "mk" }, {},
      mockFetch as any,
    );
    const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(result).toBe("hello from kimi");
  }, 10000);

  it("returns the bare primary adapter when only one provider is configured", async () => {
    // No fallback providers present -> no wrapper, single 503 path returns null.
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as any);
    const adapter = createAdapter("deepseek", "deepseek-chat", { deepseek: "dk" }, {}, mockFetch as any);
    const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2); // only deepseek's two attempts, no fallthrough
  });

  it("does not throw when the requested provider has no local key; uses what is configured", async () => {
    // Companion switched to Kimi from Discord, but this host only has the DeepSeek key.
    // createAdapter must NOT throw (that would crash-loop the bot at boot) -- it falls
    // through to DeepSeek for the direct-mode fallback. Brain runs the real Kimi voice.
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes("deepseek.com")) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "deepseek fallback" } }] }) } as any;
      }
      return { ok: false, status: 401 } as any; // moonshot would 401 with no key
    });
    expect(() =>
      createAdapter("kimi", "kimi-k2", { deepseek: "dk" }, {}, mockFetch as any),
    ).not.toThrow();
    const adapter = createAdapter("kimi", "kimi-k2", { deepseek: "dk" }, {}, mockFetch as any);
    const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(result).toBe("deepseek fallback");
  });

  it("throws only when no provider is configured at all", () => {
    expect(() => createAdapter("kimi", "kimi-k2", {}, {}, (async () => {}) as any)).toThrow();
  });
});

describe("per-provider sampling profile (patter-lock fix)", () => {
  it("Mistral sends anti-repetition penalties + top_p, not just temperature", async () => {
    let sentBody: any = null;
    const mockFetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as any;
    });
    const adapter = createAdapter("mistral", "mistral-large-latest", { mistral: "mk" }, {}, mockFetch as any);
    await adapter.generate("system", [{ role: "user", content: "hi" }], 0.85);

    // temperature is untouched (the dynamic curve still flows through)
    expect(sentBody.temperature).toBe(0.85);
    // the knobs that were missing entirely until now
    expect(sentBody.frequency_penalty).toBe(0.4);
    expect(sentBody.presence_penalty).toBe(0.3);
    expect(sentBody.top_p).toBe(0.95);
  });

  it("helper returns the OpenAI-compatible param names for Mistral", () => {
    expect(samplingParamsFor("mistral")).toEqual({
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
      top_p: 0.95,
    });
  });

  it("an unprofiled provider gets no sampling overrides (zero behavior change)", () => {
    expect(samplingParamsFor("deepseek")).toEqual({});
  });

  it("DeepSeek body stays clean -- no penalties leak into unprofiled providers", async () => {
    let sentBody: any = null;
    const mockFetch = jest.fn(async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) } as any;
    });
    const adapter = createAdapter("deepseek", "deepseek-chat", { deepseek: "dk" }, {}, mockFetch as any);
    await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(sentBody.frequency_penalty).toBeUndefined();
    expect(sentBody.presence_penalty).toBeUndefined();
    expect(sentBody.top_p).toBeUndefined();
  });
});
