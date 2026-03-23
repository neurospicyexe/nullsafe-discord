import { createAdapter } from "../inference.js";
import type { ChatMessage } from "../types.js";

describe("DeepSeekAdapter", () => {
  it("returns generated text on success", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from deepseek" } }],
      }),
    });
    const adapter = createAdapter("deepseek", "key-xxx", undefined, undefined, mockFetch as any);
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await adapter.generate("system", msgs);
    expect(result).toBe("hello from deepseek");
  });

  it("retries on 5xx, returns null after second failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const adapter = createAdapter("deepseek", "key-xxx", undefined, undefined, mockFetch as any);
    const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
