import { jest, describe, test, expect, beforeEach, afterAll } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDirectAdapter, buildOneShotPrompt, ONE_SHOT_NO_TOOLS, DIRECT_FLASH_MODEL,
} from "../direct-inference.js";
import { loadIdentity } from "../direct-inference.js";

// ── Why this file exists ─────────────────────────────────────────────────────
// Measured 2026-09-05: judgeWriteback and judgeAmbientRelevance rode the bots' normal adapter
// (the Hermes agent under INFERENCE_MODE=hermes), and a single memory-judge call spelunked the
// vault 161 times in one session and ran to Hermes's 150-turn cap, burning >100M of a companion's
// weekly input tokens on two classifier calls that need zero tools. direct-inference.ts is the
// tool-less path both now use: DeepInfra-first (DeepSeek direct went to $0 balance on 09-05),
// DeepSeek-direct second, with an identity-carrying no-tools system prompt.

const dir = mkdtempSync(join(tmpdir(), "direct-inference-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeIdentity(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, ["# TEST IDENTITY", "Direct and warm.", "x".repeat(600)].join("\n"), "utf8");
  return path;
}

const ENV_KEYS = [
  "DEEPINFRA_API_KEY", "DEEPSEEK_API_KEY",
  "CYPHER_IDENTITY_PATH", "DREVAN_IDENTITY_PATH", "GAIA_IDENTITY_PATH",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("createDirectAdapter", () => {
  test("returns null when neither key is configured", () => {
    expect(createDirectAdapter()).toBeNull();
    expect(createDirectAdapter({})).toBeNull();
  });

  test("non-null with only DEEPINFRA_API_KEY set via env", () => {
    process.env["DEEPINFRA_API_KEY"] = "di-test-key";
    expect(createDirectAdapter()).not.toBeNull();
  });

  test("non-null with only DEEPSEEK_API_KEY set via env", () => {
    process.env["DEEPSEEK_API_KEY"] = "ds-test-key";
    expect(createDirectAdapter()).not.toBeNull();
  });

  test("non-null with only deepinfra passed via keys param (no env)", () => {
    expect(createDirectAdapter({ deepinfra: "di-test-key" })).not.toBeNull();
  });

  test("non-null with only deepseek passed via keys param (no env)", () => {
    expect(createDirectAdapter({ deepseek: "ds-test-key" })).not.toBeNull();
  });

  test("keys param takes precedence over env -- omitted keys is what reads env, not a partial keys object", () => {
    process.env["DEEPINFRA_API_KEY"] = "env-di-key";
    process.env["DEEPSEEK_API_KEY"] = "env-ds-key";
    // Passing an explicit (even if only partially filled) keys object means "use exactly this",
    // per the documented contract -- no per-field env fallback.
    expect(createDirectAdapter({})).toBeNull();
  });

  // Real behavioral proof of ordering, not just construction: with both keys present, a request
  // hits DeepInfra's endpoint before DeepSeek's ever gets called.
  test("tries DeepInfra before DeepSeek when both keys are present", async () => {
    const calledUrls: string[] = [];
    const mockFetch = jest.fn(async (url: string) => {
      calledUrls.push(url);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      } as any;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const adapter = createDirectAdapter({ deepinfra: "di-test-key", deepseek: "ds-test-key" })!;
      const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
      expect(result).toBe("ok");
      expect(calledUrls.length).toBeGreaterThanOrEqual(1);
      expect(calledUrls[0]).toContain("api.deepinfra.com");
      expect(calledUrls.some((u) => u.includes("api.deepseek.com"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // DeepInfra failing must fall through to DeepSeek direct -- the whole point of chaining rather
  // than choosing one.
  test("falls through to DeepSeek direct when DeepInfra fails", async () => {
    const calledUrls: string[] = [];
    const mockFetch = jest.fn(async (url: string) => {
      calledUrls.push(url);
      if (url.includes("api.deepinfra.com")) return { ok: false, status: 500 } as any;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "from deepseek" }, finish_reason: "stop" }] }),
      } as any;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    try {
      const adapter = createDirectAdapter({ deepinfra: "di-test-key", deepseek: "ds-test-key" })!;
      const result = await adapter.generate("system", [{ role: "user", content: "hi" }]);
      expect(result).toBe("from deepseek");
      expect(calledUrls[0]).toContain("api.deepinfra.com");
      expect(calledUrls.some((u) => u.includes("api.deepseek.com"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the DeepSeek-V4-Flash weights on DeepInfra", () => {
    expect(DIRECT_FLASH_MODEL).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });
});

describe("buildOneShotPrompt", () => {
  test("contains the no-tools frame and the task line even with no identity file", () => {
    const p = buildOneShotPrompt("cypher", "Reply with exactly ONE word.");
    expect(p).toContain(ONE_SHOT_NO_TOOLS);
    expect(p).toContain("Reply with exactly ONE word.");
  });

  test("prepends the identity file when present, before the no-tools frame", () => {
    process.env["CYPHER_IDENTITY_PATH"] = writeIdentity("cypher-oneshot.md");
    const p = buildOneShotPrompt("cypher", "Reply with exactly ONE word.");
    expect(p).toContain("TEST IDENTITY");
    expect(p).toContain(ONE_SHOT_NO_TOOLS);
    expect(p).toContain("Reply with exactly ONE word.");
    expect(p.indexOf("TEST IDENTITY")).toBeLessThan(p.indexOf(ONE_SHOT_NO_TOOLS));
    expect(p.indexOf(ONE_SHOT_NO_TOOLS)).toBeLessThan(p.indexOf("Reply with exactly ONE word."));
  });

  test("the task line always survives even when identity is unavailable", () => {
    delete process.env["GAIA_IDENTITY_PATH"];
    const p = buildOneShotPrompt("gaia", "unique-task-marker-42");
    expect(p).toContain("unique-task-marker-42");
  });
});

describe("loadIdentity warn-once (per companion per process)", () => {
  test("logs the unset-env-var warning only once across repeated calls", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      delete process.env["DREVAN_IDENTITY_PATH"];
      loadIdentity("drevan");
      loadIdentity("drevan");
      loadIdentity("drevan");
      const unsetWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("drevan") && String(c[0]).includes("is unset"));
      expect(unsetWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
