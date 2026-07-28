// Delisted-model + reasoning-headroom guard for the SHARED inference layer (2026-07-28).
//
// `deepseek-chat` is delisted -- GET /v1/models returns exactly deepseek-v4-pro and
// deepseek-v4-flash. The alias still answers, which is the dangerous part: five separate places
// in the suite defaulted to it and all of them "worked" right up until the worker's copy started
// 400ing intermittently. These tests keep the shared layer off the deprecation path and pin the
// empty-content-to-null contract that makes the resilience tail actually resilient.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_MODELS } from "../models.js";
import { HERMES_REPLY_MAX_TOKENS, DEFAULT_MAX_TOKENS, replyMaxTokensFor } from "../inference.js";

const DELISTED = new Set(["deepseek-chat", "deepseek-reasoner"]);

describe("model registry points only at live DeepSeek models", () => {
  it("no registry entry sends a delisted model id over the wire", () => {
    const offenders = Object.entries(ALL_MODELS)
      .filter(([, e]) => e.provider === "deepseek" && DELISTED.has(e.model))
      .map(([k, e]) => `${k} -> ${e.model}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the legacy KEYS as aliases so a stored active_model still resolves", () => {
    // Cypher's stored active_model was literally "deepseek-chat". Dropping the key would have
    // made his setting unresolvable and silently reverted him to the env default.
    // Reported as a list so a failure names WHICH alias was dropped.
    const unresolvable = [...DELISTED].filter(k => !ALL_MODELS[k]);
    expect(unresolvable).toEqual([]);
    for (const key of DELISTED) {
      expect(ALL_MODELS[key]?.model).toMatch(/^deepseek-v4-(pro|flash)$/);
    }
  });

  it("exposes the short keys Raziel actually types", () => {
    // ops/hermes-model-map.json has `flash` and `pro`; the bot registry lacked both, so the
    // two surfaces disagreed about what a valid model name was.
    expect(ALL_MODELS["flash"]?.model).toBe("deepseek-v4-flash");
    expect(ALL_MODELS["pro"]?.model).toBe("deepseek-v4-pro");
  });

  it("maps the everyday alias to flash and the deep-thinking alias to pro", () => {
    expect(ALL_MODELS["deepseek-chat"]?.model).toBe("deepseek-v4-flash");
    expect(ALL_MODELS["deepseek-reasoner"]?.model).toBe("deepseek-v4-pro");
  });
});

describe("no source file ships a delisted DeepSeek model id", () => {
  // The durable half. SEVEN separate places in the suite defaulted to `deepseek-chat`; the
  // second through seventh were each found by grepping the shape after fixing the previous one,
  // and the seventh (halseth's basin-drift-check) was found only because the equivalent scan
  // test in that repo failed. This is that grep, run in CI, for both packages here.
  it("finds no delisted model id in any wire payload or adapter default", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith(".ts")) continue;
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          // A delisted id being SENT or defaulted to -- `model: "deepseek-chat"` or
          // `model: string = "deepseek-chat"`. Prose about the history is not flagged, and the
          // ALL_MODELS alias KEYS are quoted as keys, not as `model:` values.
          if (/model(:\s*string)?\s*(:|=)\s*["'](deepseek-chat|deepseek-reasoner)["']/.test(line)) {
            offenders.push(`${name}:${i + 1}`);
          }
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe("hermes reply ceiling leaves room for the reasoning pass", () => {
  it("is well above the non-hermes default -- reasoning is spent before content", () => {
    // Every model behind the gateway is a DeepSeek reasoning model, and Drevan's live profile
    // is on pro. At 3072 the reasoning pass ate into the reply itself.
    expect(HERMES_REPLY_MAX_TOKENS).toBeGreaterThanOrEqual(6144);
    expect(HERMES_REPLY_MAX_TOKENS).toBeGreaterThan(DEFAULT_MAX_TOKENS * 3);
  });

  it("applies the hermes ceiling to every companion, including the one with a custom cap", () => {
    // Drevan has REPLY_MAX_TOKENS 1500; the hermes ceiling must win via Math.max, not lose to
    // the per-companion override.
    expect(replyMaxTokensFor("drevan", "hermes")).toBe(HERMES_REPLY_MAX_TOKENS);
    expect(replyMaxTokensFor("gaia", "hermes")).toBe(HERMES_REPLY_MAX_TOKENS);
  });

  it("leaves the direct-mode ceilings untouched", () => {
    expect(replyMaxTokensFor("drevan")).toBe(1500);
    expect(replyMaxTokensFor("cypher")).toBe(DEFAULT_MAX_TOKENS);
  });
});
