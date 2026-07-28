// Reasoning-budget guard (2026-07-28).
//
// Every live DeepSeek model (v4-pro AND v4-flash) is a reasoning model: reasoning tokens are
// billed against `max_tokens` and emitted BEFORE any content. A ceiling at or below the
// reasoning burn returns `content: "", finish_reason: "length"`, which surfaced downstream as
// "0 finds gathered across ALL companions", `POST /mind/notes/archive 400: summary is required`
// and `POST /mind/autonomy/reflections 400: reflection_text required` -- never as an inference
// error, which is why it went a full day unnoticed after the pro cutover.
//
// These tests pin the two halves of the fix: headroom on the way out, and the retry that makes
// the failure self-correcting instead of silent.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config.js reads env at import time -- set before dynamic import (same as scratchpad.test.ts).
process.env["DEEPSEEK_API_KEY"] = "test-key";
const { chat, contentBudget, isReasoningModel } = await import("../deepseek.js");
const { DEEPSEEK_MODEL, REASONING_HEADROOM } = await import("../config.js");

/** Minimal OpenAI-shaped response. */
function reply(opts: {
  content?: string;
  finish?: string;
  reasoning?: number;
  total?: number;
}): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: opts.content ?? "" }, finish_reason: opts.finish ?? "stop" }],
      usage: {
        total_tokens: opts.total ?? 0,
        completion_tokens_details: { reasoning_tokens: opts.reasoning ?? 0 },
      },
    }),
  } as unknown as Response;
}

function bodyOf(call: unknown[]): { max_tokens: number; model: string } {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("isReasoningModel", () => {
  it("matches every live DeepSeek tier -- both of them reason, which was the trap", () => {
    expect(isReasoningModel("deepseek-v4-pro")).toBe(true);
    expect(isReasoningModel("deepseek-v4-flash")).toBe(true);
  });

  it("matches the family, not a hardcoded pair, so a v5 tier inherits the guard", () => {
    expect(isReasoningModel("deepseek-v5-pro")).toBe(true);
    expect(isReasoningModel("deepseek-reasoner")).toBe(true);
  });

  it("does not match the delisted non-reasoning alias", () => {
    expect(isReasoningModel("deepseek-chat")).toBe(false);
  });

  it("tolerates surrounding whitespace and case from a hand-edited .env", () => {
    expect(isReasoningModel("  DeepSeek-V4-Pro  ")).toBe(true);
  });
});

describe("contentBudget", () => {
  it("adds headroom on top of the caller's CONTENT ceiling for a reasoning model", () => {
    expect(contentBudget(100, "deepseek-v4-pro")).toBe(100 + REASONING_HEADROOM);
  });

  it("leaves a non-reasoning model's ceiling exactly as the caller asked", () => {
    expect(contentBudget(100, "deepseek-chat")).toBe(100);
  });

  it("keeps small classifier ceilings small in CONTENT terms -- headroom is not a rewrite", () => {
    // The 80-500 token extractor ceilings exist so the model cannot editorialize into a
    // structured field. Headroom must not be mistaken for permission to ramble: the delta
    // between two call sites is preserved exactly.
    const tight = contentBudget(80, "deepseek-v4-pro");
    const loose = contentBudget(500, "deepseek-v4-pro");
    expect(loose - tight).toBe(420);
  });
});

describe("chat() reasoning-starvation retry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the caller's content budget PLUS headroom on the first attempt", async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: "ok", total: 10 }));
    await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });
    expect(bodyOf(fetchMock.mock.calls[0]).max_tokens).toBe(contentBudget(100));
  });

  it("does not retry when content comes back on the first attempt", async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: "a real answer", total: 42 }));
    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 400 });
    expect(res.content).toBe("a real answer");
    expect(res.tokensUsed).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries at DOUBLE headroom when the thought ate the whole budget", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 100, total: 100 }))
      .mockResolvedValueOnce(reply({ content: "recovered", finish: "stop", total: 250 }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1]).max_tokens).toBe(100 + REASONING_HEADROOM * 2);
    expect(res.content).toBe("recovered");
  });

  it("bills the caller for BOTH attempts -- a starved attempt still costs tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 100, total: 100 }))
      .mockResolvedValueOnce(reply({ content: "recovered", total: 250 }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });
    expect(res.tokensUsed).toBe(350);
  });

  it("does NOT retry an empty answer that finished with 'stop'", async () => {
    // finish=stop with no content is the model choosing to say nothing. Retrying burns tokens
    // to receive the same silence, so only "length" is retryable.
    fetchMock.mockResolvedValueOnce(reply({ content: "", finish: "stop", total: 30 }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.content).toBe("");
  });

  it("treats whitespace-only content as empty", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "   \n\t ", finish: "length", total: 100 }))
      .mockResolvedValueOnce(reply({ content: "real", total: 100 }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.content).toBe("real");
  });

  it("gives up after exactly one retry and logs loudly rather than looping", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 100, total: 100 }))
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 3100, total: 3100 }));

    const errorSpy = vi.spyOn(console, "error");
    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.content).toBe("");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("EMPTY CONTENT AFTER RETRY"));
  });

  it("names the tunable knob in the starvation warning -- the log has to be actionable", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 100, total: 100 }))
      .mockResolvedValueOnce(reply({ content: "ok", total: 100 }));

    const warnSpy = vi.spyOn(console, "warn");
    await chat([{ role: "user", content: "hi" }], { maxTokens: 100 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DEEPSEEK_REASONING_HEADROOM"));
  });

  it("still throws on a non-2xx -- the retry is for starvation, not for API errors", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"Model Not Exist"}',
    } as unknown as Response);

    await expect(chat([{ role: "user", content: "hi" }], { maxTokens: 100 })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ships pointed at a model that exists -- 'deepseek-chat' is delisted", () => {
    // GET /v1/models returns exactly deepseek-v4-pro and deepseek-v4-flash (2026-07-28). The
    // delisted alias still answers, so a wrong default here fails silently until it doesn't.
    expect(DEEPSEEK_MODEL).not.toBe("deepseek-chat");
    expect(DEEPSEEK_MODEL).toMatch(/^deepseek-v4-(pro|flash)$/);
  });

  it("defaults the headroom high enough to clear a real measured reasoning burn", () => {
    // Measured: 216-292 reasoning tokens on a 19-token prompt; a large reflect prompt reasons
    // far longer. A headroom below ~1k would reintroduce the bug on the phases that think.
    expect(REASONING_HEADROOM).toBeGreaterThanOrEqual(1000);
  });
});
