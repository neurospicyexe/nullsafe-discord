// DeepInfra-first resilience chain (2026-09-26).
//
// Raziel's rule: ALL DeepSeek-model inference goes through DeepInfra (same V4-Flash weights);
// direct DeepSeek is a ~$10 emergency lane. createAdapter's chain used to put `deepseek`
// BEFORE `deepinfra`, and models.ts maps "flash" to provider "deepseek" -- so any non-Hermes
// process spent the direct balance first. Dormant on the live bots (forceHermes), live anywhere
// else. These pin: DeepInfra first, no DeepSeek call when DeepInfra answers, a loud line on fall.

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createAdapter, FELL_BACK_TAG, isDeepSeekFlash, DEEPINFRA_FLASH_MODEL } from "../inference.js";

const ok = (content: string) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
}) as any;
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) }) as any;

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());
const warnLines = () => (warn.mock.calls as unknown[][]).map((c) => String(c[0]));

describe("createAdapter -- DeepSeek flash requests go to DeepInfra first", () => {
  it("never calls api.deepseek.com when DeepInfra answers", async () => {
    const fetchMock = jest.fn(async (_url: string) => ok("from deepinfra"));
    const adapter = createAdapter("deepseek", "deepseek-v4-flash", { deepseek: "dk", deepinfra: "di" }, {}, fetchMock as any);
    await expect(adapter.generate("sys", [{ role: "user", content: "hi" }])).resolves.toBe("from deepinfra");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["https://api.deepinfra.com/v1/openai/chat/completions"]);
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as any).body);
    expect(body.model).toBe(DEEPINFRA_FLASH_MODEL);
    expect(warnLines().some((l) => l.includes(FELL_BACK_TAG))).toBe(false);
  });

  it("falls to direct DeepSeek when DeepInfra fails, with the FELL BACK line", async () => {
    const fetchMock = jest.fn(async (url: string) => (url.includes("deepinfra") ? fail(503) : ok("from deepseek")));
    const adapter = createAdapter("deepseek", "deepseek-v4-flash", { deepseek: "dk", deepinfra: "di" }, {}, fetchMock as any);
    await expect(adapter.generate("sys", [{ role: "user", content: "hi" }])).resolves.toBe("from deepseek");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain("deepinfra.com");
    expect(urls.some((u) => u.includes("api.deepseek.com"))).toBe(true);
    expect(warnLines().some((l) => l.includes(FELL_BACK_TAG))).toBe(true);
  }, 15000);

  it("the delisted `deepseek-chat` alias is flash and reroutes too; pro is NOT rerouted", async () => {
    expect(isDeepSeekFlash("deepseek-chat")).toBe(true);
    expect(isDeepSeekFlash("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekFlash("deepseek-v4-pro")).toBe(false);

    const fetchMock = jest.fn(async (_url: string) => ok("pro answer"));
    const adapter = createAdapter("deepseek", "deepseek-v4-pro", { deepseek: "dk", deepinfra: "di" }, {}, fetchMock as any);
    await adapter.generate("sys", [{ role: "user", content: "hi" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
  });

  it("the resilience tail tries DeepInfra before DeepSeek for a non-DeepSeek primary", async () => {
    const fetchMock = jest.fn(async (url: string) => (url.includes("moonshot") ? fail(503) : ok("tail")));
    const adapter = createAdapter("kimi", "kimi-k2", { kimi: "mk", deepseek: "dk", deepinfra: "di" }, {}, fetchMock as any);
    await expect(adapter.generate("sys", [{ role: "user", content: "hi" }])).resolves.toBe("tail");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes("api.deepseek.com"))).toBe(false);
    expect(urls[urls.length - 1]).toContain("deepinfra.com");
  });

  it("with no DeepInfra key the chain is unchanged (DeepSeek direct primary)", async () => {
    const fetchMock = jest.fn(async (_url: string) => ok("ds"));
    const adapter = createAdapter("deepseek", "deepseek-v4-flash", { deepseek: "dk" }, {}, fetchMock as any);
    await adapter.generate("sys", [{ role: "user", content: "hi" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
  });
});
