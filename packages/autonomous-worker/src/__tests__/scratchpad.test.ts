import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config.js reads env at import time -- set before dynamic import
process.env.DEEPSEEK_API_KEY = "test-key";
const { OWNER_PRONOUN_RULE } = await import("@nullsafe/shared");

function mockResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
  } as Response;
}

describe("promptWithScratchpad", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("makes two calls, threading the scratchpad as an assistant turn", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse("private thinking"))
      .mockResolvedValueOnce(mockResponse('{"final": true}'));
    const { promptWithScratchpad } = await import("../deepseek.js");
    const res = await promptWithScratchpad("think about X", "now emit JSON", "you are cypher");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    // promptWithScratchpad carries the owner pronoun rule by default (2026-09-24 pronoun fix) --
    // the system message is the identity string plus that rule, not the bare identity string.
    expect(secondBody.messages).toEqual([
      { role: "system", content: `you are cypher\n\n${OWNER_PRONOUN_RULE}` },
      { role: "user", content: "think about X" },
      { role: "assistant", content: "private thinking" },
      { role: "user", content: "now emit JSON" },
    ]);
    expect(res.content).toBe('{"final": true}');
    expect(res.scratchpad).toBe("private thinking");
    expect(res.tokensUsed).toBe(20);
  });
});
