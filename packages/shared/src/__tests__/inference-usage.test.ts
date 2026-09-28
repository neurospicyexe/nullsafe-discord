// Token accounting on the direct lanes (B22, 2026-09-28).
//
// The bot-side DIRECT calls (judges, narrator, clerk, med reminder, reach ask) logged zero tokens:
// 83 calls a day whose spend was invisible. These pin one `[inference:usage]` line per 2xx body,
// counts and ids only, never prompt or completion text, and the caller label riding withCaller.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  DeepInfraAdapter, DeepSeekAdapter, FallbackAdapter, USAGE_TAG, withCaller, formatUsageLine,
  currentInferenceCaller, type InferenceAdapter,
} from "../inference.js";
import { createDirectAdapter } from "../direct-inference.js";

const PROMPT = "SYSTEM-PROMPT-SENTINEL";
const USER = "USER-TEXT-SENTINEL";
const REPLY = "COMPLETION-SENTINEL";

const body = (content: string, usage?: unknown) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) }),
}) as any;

let log: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const usageLines = () => (log.mock.calls as unknown[][]).map((c) => String(c[0])).filter((l) => l.startsWith(USAGE_TAG));

const DI_USAGE = {
  prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280,
  prompt_tokens_details: { cached_tokens: 1024 },
  completion_tokens_details: { reasoning_tokens: 30 },
  estimated_cost: 0.0000912,
};

describe("DeepInfraAdapter usage line", () => {
  it("prints one line with in/out/cached/reasoning/cost and no content", async () => {
    const fetchMock = jest.fn(async () => body(REPLY, DI_USAGE));
    const a = new DeepInfraAdapter("di", "deepseek-ai/DeepSeek-V4-Flash-0731", fetchMock as any);
    await expect(a.generate(PROMPT, [{ role: "user", content: USER }])).resolves.toBe(REPLY);
    const lines = usageLines();
    expect(lines).toEqual([
      "[inference:usage] provider=deepinfra model=deepseek-ai/DeepSeek-V4-Flash-0731 caller=- in=1200 out=80 cached=1024 reasoning=30 cost=0.0000912",
    ]);
    for (const l of lines) {
      expect(l).not.toContain(PROMPT);
      expect(l).not.toContain(USER);
      expect(l).not.toContain(REPLY);
    }
  });

  it("still counts an EMPTY-content 2xx (the tokens were spent) and returns null", async () => {
    const fetchMock = jest.fn(async () => body("", { prompt_tokens: 900, completion_tokens: 1024 }));
    const a = new DeepInfraAdapter("di", "deepseek-ai/DeepSeek-V4-Flash-0731", fetchMock as any);
    await expect(a.generate(PROMPT, [{ role: "user", content: USER }])).resolves.toBeNull();
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0]).toContain("in=900 out=1024 cached=0 reasoning=0 cost=-");
  });

  it("a 2xx with no usage object says usage=absent, so lines still equal calls", async () => {
    const fetchMock = jest.fn(async () => body(REPLY));
    const a = new DeepInfraAdapter("di", "m", fetchMock as any);
    await a.generate(PROMPT, [{ role: "user", content: USER }]);
    expect(usageLines()).toEqual(["[inference:usage] provider=deepinfra model=m caller=- usage=absent"]);
  });

  it("a non-2xx prints no usage line (nothing was billed)", async () => {
    const fetchMock = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as any);
    const a = new DeepInfraAdapter("di", "m", fetchMock as any);
    await expect(a.generate(PROMPT, [{ role: "user", content: USER }])).resolves.toBeNull();
    expect(usageLines()).toEqual([]);
  });
});

describe("DeepSeekAdapter usage line", () => {
  it("reads DeepSeek's prompt_cache_hit_tokens as the cached count", async () => {
    const fetchMock = jest.fn(async () => body(REPLY, { prompt_tokens: 500, completion_tokens: 40, prompt_cache_hit_tokens: 384, prompt_cache_miss_tokens: 116 }));
    const a = new DeepSeekAdapter("dk", "deepseek-v4-flash", fetchMock as any);
    await expect(a.generate(PROMPT, [{ role: "user", content: USER }])).resolves.toBe(REPLY);
    expect(usageLines()).toEqual([
      "[inference:usage] provider=deepseek model=deepseek-v4-flash caller=- in=500 out=40 cached=384 reasoning=0 cost=-",
    ]);
  });
});

describe("withCaller", () => {
  it("attributes calls made through the wrapper, including through a FallbackAdapter", async () => {
    const fetchMock = jest.fn(async () => body(REPLY, DI_USAGE));
    const chain = new FallbackAdapter([{ name: "deepinfra", adapter: new DeepInfraAdapter("di", "m", fetchMock as any) }]);
    await withCaller(chain, "writeback").generate(PROMPT, [{ role: "user", content: USER }]);
    await chain.generate(PROMPT, [{ role: "user", content: USER }]);
    const lines = usageLines();
    expect(lines[0]).toContain("caller=writeback ");
    expect(lines[1]).toContain("caller=- ");
  });

  it("passes null and undefined through so `withCaller(x) ?? fallback` keeps working", () => {
    expect(withCaller(null, "x")).toBeNull();
    expect(withCaller(undefined, "x")).toBeUndefined();
  });

  it("does not leak the label outside the call, and concurrent callers keep their own label", async () => {
    const seen: Array<string | undefined> = [];
    const probe: InferenceAdapter = {
      generate: async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(currentInferenceCaller()); return "ok"; },
    };
    await Promise.all([withCaller(probe, "a").generate("", []), withCaller(probe, "b").generate("", [])]);
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(currentInferenceCaller()).toBeUndefined();
  });

  it("sanitizes a label so it cannot break the key=value line", () => {
    const fetchMock = jest.fn(async () => body(REPLY, DI_USAGE));
    const a = withCaller(new DeepInfraAdapter("di", "m", fetchMock as any), "bad label=x");
    return a.generate("", []).then(() => {
      expect(usageLines()[0]).toContain("caller=bad_label_x ");
    });
  });
});

describe("createDirectAdapter chain", () => {
  it("the real direct chain emits the usage line on the DeepInfra link", async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => body(REPLY, DI_USAGE));
    (globalThis as any).fetch = fetchMock;
    try {
      const direct = createDirectAdapter({ deepinfra: "di", deepseek: "dk" });
      await withCaller(direct, "narrator")!.generate(PROMPT, [{ role: "user", content: USER }]);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
    expect(usageLines()).toHaveLength(1);
    expect(usageLines()[0]).toMatch(/^\[inference:usage\] provider=deepinfra model=\S+ caller=narrator in=1200 out=80 cached=1024 /);
  });
});

describe("formatUsageLine", () => {
  it("guards junk numbers to 0", () => {
    expect(formatUsageLine("deepinfra", "m", { prompt_tokens: NaN, completion_tokens: -3 } as any))
      .toBe("[inference:usage] provider=deepinfra model=m caller=- in=0 out=0 cached=0 reasoning=0 cost=-");
  });
});
