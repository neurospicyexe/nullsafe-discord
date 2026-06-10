import { describe, it, expect } from "vitest";
import { parseEnv } from "../env.js";

describe("parseEnv", () => {
  it("parses plain KEY=VALUE lines", () => {
    expect(parseEnv("HALSETH_URL=https://x.workers.dev\nHALSETH_SECRET=abc123")).toEqual({
      HALSETH_URL: "https://x.workers.dev",
      HALSETH_SECRET: "abc123",
    });
  });

  it("skips comments and blank lines", () => {
    const raw = "# header comment\n\nKEY=val\n   # indented comment\n";
    expect(parseEnv(raw)).toEqual({ KEY: "val" });
  });

  it("survives backticks and shell metacharacters in comments and values (the source-.env killer)", () => {
    const raw = "# use `pm2 reload` after edits\nSECRET=ab`cd$ef\nOTHER=x && rm -rf /";
    expect(parseEnv(raw)).toEqual({ SECRET: "ab`cd$ef", OTHER: "x && rm -rf /" });
  });

  it("strips one layer of matching surrounding quotes only", () => {
    expect(parseEnv('A="quoted"\nB=\'single\'\nC="mismatched\'')).toEqual({
      A: "quoted",
      B: "single",
      C: "\"mismatched'",
    });
  });

  it("keeps = inside values and ignores malformed keys", () => {
    expect(parseEnv("URL=https://h.dev/a?b=c&d=e\n=nokey\n2BAD=x\nVALID_2=ok")).toEqual({
      URL: "https://h.dev/a?b=c&d=e",
      VALID_2: "ok",
    });
  });

  it("does not strip inline # from values (secrets may contain #)", () => {
    expect(parseEnv("PASS=abc#def")).toEqual({ PASS: "abc#def" });
  });

  it("handles CRLF files", () => {
    expect(parseEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});
