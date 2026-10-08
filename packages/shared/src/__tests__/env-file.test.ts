// env-file.ts: the .env loader every process imports first (2026-09-11 -- the bots used to trust
// pm2's injected env alone, and one bare `pm2 restart --update-env` dropped DEEPINFRA_API_KEY).
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, findEnvFile, loadEnvFile, botEnvPrefix } from "../env-file.js";
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

describe("per-bot overrides (P2-12: a generic HERMES_API_URL= in .env must not flatten the three bots onto one port)", () => {
  const writeEnv = (lines: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "nullsafe-env-perbot-"));
    const file = join(root, ".env");
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };
  const quiet = () => {};

  it("generic key in the file + per-bot key present -> the per-bot value wins, and the take is logged by name", () => {
    const env: NodeJS.ProcessEnv = { NULLSAFE_BOT: "cypher", CYPHER_HERMES_API_URL: "http://127.0.0.1:8642/v1" };
    const lines: string[] = [];
    const r = loadEnvFile({ path: writeEnv(["HERMES_API_URL=http://127.0.0.1:9999/v1", "INFERENCE_MODE=direct", "CYPHER_INFERENCE_MODE=hermes"]), env, log: l => lines.push(l) });
    expect(env["HERMES_API_URL"]).toBe("http://127.0.0.1:8642/v1");
    expect(env["INFERENCE_MODE"]).toBe("hermes");
    expect(r.perBot.sort()).toEqual(["HERMES_API_URL", "INFERENCE_MODE"]);
    expect(lines).toContain("[env] HERMES_API_URL taken from CYPHER_HERMES_API_URL");
    expect(lines).toContain("[env] INFERENCE_MODE taken from CYPHER_INFERENCE_MODE");
    for (const l of lines) expect(l).not.toContain("8642"); // names only, never values
  });

  it("only the generic key -> the generic (file) value stands", () => {
    const env: NodeJS.ProcessEnv = { NULLSAFE_BOT: "drevan" };
    const r = loadEnvFile({ path: writeEnv(["HERMES_API_URL=http://127.0.0.1:9999/v1"]), env, log: quiet });
    expect(env["HERMES_API_URL"]).toBe("http://127.0.0.1:9999/v1");
    expect(r.perBot).toEqual([]);
  });

  it("only the per-bot key -> the per-bot value is applied even with no generic line in the file", () => {
    const env: NodeJS.ProcessEnv = { NULLSAFE_BOT: "gaia", GAIA_HERMES_API_URL: "http://127.0.0.1:8644/v1", HERMES_API_URL: "http://stale-pm2:1/v1" };
    const r = loadEnvFile({ path: writeEnv(["UNRELATED=1"]), env, log: quiet });
    expect(env["HERMES_API_URL"]).toBe("http://127.0.0.1:8644/v1");
    expect(r.perBot).toEqual(["HERMES_API_URL"]);
  });

  it("no bot identity -> no overrides (the worker is not a bot)", () => {
    const env: NodeJS.ProcessEnv = { CYPHER_HERMES_API_URL: "http://127.0.0.1:8642/v1" };
    loadEnvFile({ path: writeEnv(["HERMES_API_URL=http://generic/v1"]), env, log: quiet });
    expect(env["HERMES_API_URL"]).toBe("http://generic/v1");
  });

  it("derives the prefix from NULLSAFE_BOT first, then pm2's `name` with -bot stripped", () => {
    expect(botEnvPrefix({ NULLSAFE_BOT: "cypher", name: "drevan-bot" })).toBe("CYPHER");
    expect(botEnvPrefix({ name: "gaia-bot" })).toBe("GAIA");
    expect(botEnvPrefix({ name: "autonomous-worker" })).toBeNull(); // a hyphen is not a bot name
    expect(botEnvPrefix({})).toBeNull();
  });

  it("file wins is preserved for everything else (a stale pm2 value is still overridden by the file)", () => {
    const env: NodeJS.ProcessEnv = { NULLSAFE_BOT: "cypher", HALSETH_URL: "http://stale" };
    const r = loadEnvFile({ path: writeEnv(["HALSETH_URL=http://fresh"]), env, log: quiet });
    expect(env["HALSETH_URL"]).toBe("http://fresh");
    expect(r.overridden).toBe(1);
  });
});
