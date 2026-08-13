// Truncated (non-empty) content (2026-08-13).
//
// The 2026-07-28 reasoning-budget fix caught EMPTY content with finish_reason="length". It did
// not catch the other half: a NON-empty answer that was also cut off. `chat()` returned on
// `content.trim()` before ever reading finish_reason, so at every call site in the worker a
// truncated response was byte-for-byte indistinguishable from a complete one.
//
// It came due on 2026-08-12. Cypher's nightly reflection had parsed cleanly for 20 consecutive
// nights; two fields landed the same evening (the authored `close` object and `needs_raziel`),
// his JSON ran past the hardcoded 900-token ceiling, and the only trace was
// `unparseable reflection output: {` -- a log line that cannot tell truncation apart from a
// chatty tail or a stray control character, because all three look identical from the head.
//
// These pin the two halves: the warning is unconditional (visibility), and the retry is opt-in
// and widens the CONTENT budget, since a prose caller would only truncate again at the same
// ceiling for double the money.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env["DEEPSEEK_API_KEY"] = "test-key";
const { chat } = await import("../deepseek.js");
const { REASONING_HEADROOM } = await import("../config.js");

function reply(opts: { content?: string; finish?: string; reasoning?: number }): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: opts.content ?? "" }, finish_reason: opts.finish ?? "stop" }],
      usage: { total_tokens: 0, completion_tokens_details: { reasoning_tokens: opts.reasoning ?? 0 } },
    }),
  } as unknown as Response;
}

const maxTokensOf = (call: unknown[]): number =>
  JSON.parse(String((call[1] as RequestInit).body)).max_tokens as number;

// Typed off the call that creates it. `ReturnType<typeof vi.spyOn>` looks equivalent and is
// not: it resolves to MockInstance<unknown[], unknown>, which console.warn's signature does not
// satisfy. Vitest transpiles without typechecking, so this is green under `npm test` either way
// and only `tsc --noEmit` ever says so.
const spyOnWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof spyOnWarn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = spyOnWarn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("truncated non-empty content", () => {
  it("retries at DOUBLE THE CONTENT budget when the caller parses the output", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: '{"reply":"cut off here', finish: "length" }))
      .mockResolvedValueOnce(reply({ content: '{"reply":"whole"}', finish: "stop" }));

    const res = await chat([{ role: "user", content: "hi" }], {
      maxTokens: 900,
      retryOnTruncate: true,
    });

    expect(res.content).toBe('{"reply":"whole"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first ceiling is the caller's budget + headroom; the retry doubles the CONTENT half
    // only. Doubling the headroom instead (which is what the empty-content ladder does) would
    // buy the model more room to THINK and not one extra character to SAY.
    expect(maxTokensOf(fetchMock.mock.calls[0]!)).toBe(900 + REASONING_HEADROOM);
    expect(maxTokensOf(fetchMock.mock.calls[1]!)).toBe(1800 + REASONING_HEADROOM);
  });

  it("does NOT retry by default -- a prose caller would just truncate again for double the cost", async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: "a long reply that ran out of ro", finish: "length" }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 900 });

    expect(res.content).toBe("a long reply that ran out of ro");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns EVEN WHEN IT DOES NOT RETRY: silent truncation is the whole defect", async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: "cut", finish: "length" }));

    await chat([{ role: "user", content: "hi" }], { maxTokens: 900 });

    const logged = warn.mock.calls.map(c => String(c[0])).join("\n");
    expect(logged).toContain("TRUNCATED CONTENT");
    // The budget has to be IN the line. "It was truncated" without the ceiling that truncated
    // it sends the next reader back to the source to find out which knob to turn.
    expect(logged).toContain("900");
  });

  it("gives up after ONE retry rather than climbing forever", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ content: "cut one", finish: "length" }))
      .mockResolvedValueOnce(reply({ content: "cut two", finish: "length" }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 900, retryOnTruncate: true });

    expect(res.content).toBe("cut two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves a complete answer completely alone, retry flag or not", async () => {
    fetchMock.mockResolvedValueOnce(reply({ content: '{"reply":"done"}', finish: "stop" }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 900, retryOnTruncate: true });

    expect(res.content).toBe('{"reply":"done"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map(c => String(c[0])).join("\n")).not.toContain("TRUNCATED");
  });

  it("still treats EMPTY + length as the reasoning-starve case, not as truncation", async () => {
    // The two ladders must not collide: empty content means the THOUGHT ate the budget and the
    // headroom is what has to grow, which is the 07-28 behaviour and stays untouched.
    fetchMock
      .mockResolvedValueOnce(reply({ content: "", finish: "length", reasoning: 3000 }))
      .mockResolvedValueOnce(reply({ content: "spoke", finish: "stop" }));

    const res = await chat([{ role: "user", content: "hi" }], { maxTokens: 900 });

    expect(res.content).toBe("spoke");
    expect(maxTokensOf(fetchMock.mock.calls[1]!)).toBe(900 + REASONING_HEADROOM * 2);
    expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toContain("REASONING STARVED");
  });
});
