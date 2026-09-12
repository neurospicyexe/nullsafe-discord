// env-file.ts: the .env loader every process imports first (2026-09-11 -- the bots used to trust
// pm2's injected env alone, and one bare `pm2 restart --update-env` dropped DEEPINFRA_API_KEY).
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, findEnvFile } from "../env-file.js";
import { directChainNames } from "../direct-inference.js";

describe("parseEnv", () => {
  it("parses KEY=VALUE, skips comments/blanks/bad keys, strips one quote layer, never interprets", () => {
    const parsed = parseEnv([
      "# comment",
      "",
      "A=1",
      "  B = two words ",
      'C="quoted # not a comment"',
      "D='single'",
      "9BAD=x",
      "=novalue",
      "E=has`backtick`and#hash",
    ].join("\n"));
    expect(parsed).toEqual({
      A: "1",
      B: "two words",
      C: "quoted # not a comment",
      D: "single",
      E: "has`backtick`and#hash",
    });
  });

  it("keeps a double-equals value verbatim (the resolver, not the parser, strips it)", () => {
    expect(parseEnv("DEEPINFRA_API_KEY==abc")).toEqual({ DEEPINFRA_API_KEY: "=abc" });
  });
});

describe("findEnvFile", () => {
  it("walks up from a pm2-style per-app cwd to the repo root .env", () => {
    const root = mkdtempSync(join(tmpdir(), "nullsafe-env-"));
    writeFileSync(join(root, ".env"), "X=1\n");
    const appDir = join(root, "bots", "cypher");
    mkdirSync(appDir, { recursive: true });
    expect(findEnvFile(appDir, {})).toBe(join(root, ".env"));
  });

  it("honours NULLSAFE_ENV_FILE, then the worker's older WORKER_ENV_FILE", () => {
    const root = mkdtempSync(join(tmpdir(), "nullsafe-env-"));
    const a = join(root, "a.env"); writeFileSync(a, "X=1\n");
    const b = join(root, "b.env"); writeFileSync(b, "X=2\n");
    expect(findEnvFile(root, { NULLSAFE_ENV_FILE: a, WORKER_ENV_FILE: b })).toBe(a);
    expect(findEnvFile(root, { WORKER_ENV_FILE: b })).toBe(b);
    expect(findEnvFile(root, { NULLSAFE_ENV_FILE: join(root, "missing.env"), WORKER_ENV_FILE: b })).toBe(b);
  });

  it("returns null when nothing is found within four levels", () => {
    const root = mkdtempSync(join(tmpdir(), "nullsafe-env-empty-"));
    const deep = join(root, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    expect(findEnvFile(deep, {})).toBeNull();
  });
});

describe("directChainNames (the boot label reads the same resolver as the chain)", () => {
  it("names deepinfra first, then deepseek", () => {
    expect(directChainNames({ deepinfra: "di", deepseek: "ds" })).toEqual(["deepinfra", "deepseek"]);
  });
  it("is DeepSeek-only when the DeepInfra key is missing -- the 2026-09-11 shape", () => {
    expect(directChainNames({ deepseek: "ds" })).toEqual(["deepseek"]);
    expect(directChainNames({ deepinfra: "  ", deepseek: "ds" })).toEqual(["deepseek"]);
  });
  it("strips a KEY==value leading '=' like the bots' config.ts does", () => {
    expect(directChainNames({ deepinfra: "=di" })).toEqual(["deepinfra"]);
    expect(directChainNames({ deepinfra: "==" })).toEqual([]);
  });
  it("is empty with no keys", () => {
    expect(directChainNames({})).toEqual([]);
  });
});
