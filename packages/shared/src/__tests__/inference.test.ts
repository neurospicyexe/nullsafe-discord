import { jest, describe, it, expect } from "@jest/globals";
import { createAdapter } from "../inference.js";
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
      if (url.includes("moonshot.cn")) {
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
});
