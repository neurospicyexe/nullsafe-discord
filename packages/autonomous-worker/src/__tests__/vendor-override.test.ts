// Vendor override precedence (2026-08-28).
//
// The DeepInfra cutover died on its first night: ecosystem.config.js mapped
// WORKER_INFERENCE_* -> DEEPSEEK_* at exec time, but env.ts then reloaded the raw .env
// with file-wins override (itself the fix for the 06-27 stale-pm2-secret trap) and stomped
// DEEPSEEK_API_KEY back to the real DeepSeek key -- which DeepInfra 401'd all night
// ("User is not authorized"), and the fallback lane 402'd on an empty DeepSeek balance.
// Two layers resolving the same precedence disagreed. These pin the ONE gate:
//
//   * config.ts itself resolves WORKER_INFERENCE_* over DEEPSEEK_*, so a raw .env reload
//     can never un-map the override.
//   * The direct-DeepSeek fallback lane arms from the override's presence, without any
//     ecosystem-level env surgery.
//   * No override in the environment -> plain DEEPSEEK_* / explicit WORKER_FALLBACK_*,
//     unchanged.

import { describe, it, expect } from "vitest";

process.env["DEEPSEEK_API_KEY"] = "real-deepseek-key";
process.env["DEEPSEEK_BASE_URL"] = "https://api.deepseek.example/v1";
process.env["DEEPSEEK_MODEL"] = "deepseek-v4-flash";
process.env["WORKER_INFERENCE_BASE_URL"] = "https://api.deepinfra.example/v1/openai";
process.env["WORKER_INFERENCE_API_KEY"] = "deepinfra-key";
process.env["WORKER_INFERENCE_MODEL"] = "deepseek-ai/DeepSeek-V4-Flash-0731";
delete process.env["WORKER_FALLBACK_BASE_URL"];
delete process.env["WORKER_FALLBACK_API_KEY"];
delete process.env["WORKER_FALLBACK_MODEL"];

const config = await import("../config.js");

describe("worker vendor override precedence", () => {
  it("WORKER_INFERENCE_* wins over DEEPSEEK_* for the primary vendor", () => {
    expect(config.DEEPSEEK_BASE_URL).toBe("https://api.deepinfra.example/v1/openai");
    expect(config.DEEPSEEK_API_KEY).toBe("deepinfra-key");
    expect(config.DEEPSEEK_MODEL).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });

  it("an active override arms the direct-DeepSeek fallback lane with the raw DeepSeek key", () => {
    expect(config.FALLBACK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(config.FALLBACK_API_KEY).toBe("real-deepseek-key");
    expect(config.FALLBACK_MODEL).toBe("deepseek-v4-flash");
  });
});
