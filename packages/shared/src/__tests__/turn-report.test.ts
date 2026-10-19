import { describe, it, expect } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(process.cwd(), "../../scripts/turn-report.mjs");

const line = (o: Record<string, unknown>, ts = new Date().toISOString()) =>
  `0|drevan-bot  | [turn] ${JSON.stringify({ at: ts, c: "drevan", ch: "1", msg: "9", side: "blue", outcome: "posted", queue_ms: 0, settle_ms: 0, gathered: 0, vision_ms: 0, vision: "none", halseth_ms: 0, inference_ms: 0, post_ms: 0, total_ms: 0, catchup: false, in_tok: null, ...o })}`;

function run(lines: string[], args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "turnrep-"));
  const f = join(dir, "drevan-bot-out.log");
  writeFileSync(f, lines.join("\n") + "\nsome other log line with words\n");
  return spawnSync(process.execPath, [script, ...args, f], { encoding: "utf8" });
}

describe("scripts/turn-report.mjs", () => {
  it("prints per-outcome counts and p50/p95 of each timing field, no text", () => {
    const rows: string[] = [];
    for (let i = 1; i <= 20; i++) rows.push(line({ inference_ms: i * 100, total_ms: i * 1000 }));
    rows.push(line({ outcome: "absorbed", total_ms: 50 }));
    rows.push(line({ outcome: "skipped:echo", c: "cypher" }));
    const r = run(rows);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/posted\s+20/);
    expect(r.stdout).toMatch(/absorbed\s+1/);
    expect(r.stdout).toMatch(/skipped:echo\s+1/);
    // inference_ms over the 20 posted + 2 zero rows: p50/p95 present
    expect(r.stdout).toMatch(/inference_ms\s+\d+\s+\d+/);
    expect(r.stdout).not.toMatch(/some other log line/);
  });

  it("--companion filters", () => {
    const r = run([line({ c: "drevan" }), line({ c: "cypher", outcome: "absorbed" })], ["--companion", "cypher"]);
    expect(r.stdout).toMatch(/absorbed\s+1/);
    expect(r.stdout).not.toMatch(/posted\s+\d/);
  });

  it("--hours drops lines older than the window by the payload's own ISO timestamp", () => {
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    const r = run([line({ outcome: "absorbed" }, old), line({ outcome: "posted" })], ["--hours", "1"]);
    expect(r.stdout).toMatch(/posted\s+1/);
    expect(r.stdout).not.toMatch(/absorbed/);
  });

  it("p50/p95 are nearest-rank", () => {
    const rows = [100, 200, 300, 400, 500].map((n) => line({ total_ms: n }));
    const r = run(rows);
    expect(r.stdout).toMatch(/total_ms\s+300\s+500/);
  });
});
