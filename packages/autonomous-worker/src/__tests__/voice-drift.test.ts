import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../config.js", () => ({ HALSETH_URL: "http://h.test", HALSETH_SECRET: "s" }));

import {
  rowFeatures, rowWeight, buildBaseline, windowZ, warnMarkers, twoNightWarn, logLine, fetchVoiceRows,
  type VoiceRow,
} from "../voice-drift-core.js";
import { runVoiceDriftTick } from "../voice-drift.js";

const opts = { cleanWeight: 10, fullSince: null };
const row = (score: number, extra: Partial<VoiceRow> = {}): VoiceRow => ({
  score, positive_hits: ["mk:v1"], anti_hits: [], contamination_hits: [], message_len: 100,
  created_at: "2026-10-20 12:00:00", ...extra,
});

describe("core", () => {
  it("reads marker tags, JSON strings, and treats untagged rows as unmeasured", () => {
    const f = rowFeatures(row(1, { positive_hits: JSON.stringify(["mk:v1", "mk:hedging=3", "spiral"]) }));
    expect(f["hedging"]).toBe(3);
    expect(f["swearing"]).toBe(0);
    expect(f["positive"]).toBe(1);
    expect(rowFeatures(row(1, { positive_hits: ["spiral"] }))["hedging"]).toBeUndefined();
  });

  it("up-weights clean rows before fullSince only", () => {
    const clean = row(1), dirty = row(0.85, { anti_hits: ["x"] });
    expect(rowWeight(clean, opts)).toBe(10);
    expect(rowWeight(dirty, opts)).toBe(1);
    const fs = { cleanWeight: 10, fullSince: "2026-10-25T00:00:00Z" };
    expect(rowWeight(clean, fs)).toBe(10);
    expect(rowWeight(row(1, { created_at: "2026-10-26 00:00:00" }), fs)).toBe(1);
  });

  it("corrects the 10% sampling bias in the baseline mean", () => {
    const rows = [...Array(10).fill(0).map(() => row(0.85, { anti_hits: ["x"] })), ...Array(10).fill(0).map(() => row(1))];
    const b = buildBaseline({ cypher: rows }, { from: "a", to: "b" }, opts);
    // raw mean 0.925; weighted (10 dirty@1, 10 clean@10) = (8.5 + 100) / 110
    expect(b.companions["cypher"]!.markers["score"]!.mean).toBeCloseTo(108.5 / 110, 5);
  });

  it("z-scores a window against the baseline, skips thin windows and unmeasured markers", () => {
    const base = Array.from({ length: 40 }, (_, i) => row(1, { positive_hits: ["mk:v1", ...(i % 4 === 0 ? ["mk:hedging=1"] : [])] }));
    const b = buildBaseline({ cypher: base }, { from: "a", to: "b" }, { cleanWeight: 1, fullSince: null });
    const hedgy = Array.from({ length: 10 }, () => row(1, { positive_hits: ["mk:v1", "mk:hedging=3"] }));
    const w = windowZ(hedgy, b.companions["cypher"], { cleanWeight: 1, fullSince: null });
    expect(w.z["hedging"]).toBeGreaterThan(2);
    expect(warnMarkers(w.z)).toContain("hedging");
    expect(windowZ(hedgy.slice(0, 3), b.companions["cypher"], opts).z).toEqual({});
    expect(windowZ(hedgy, undefined, opts).z).toEqual({});
    const legacy = windowZ(Array.from({ length: 10 }, () => row(1, { positive_hits: [] })), b.companions["cypher"], { cleanWeight: 1, fullSince: null });
    expect(legacy.z["hedging"]).toBeUndefined();
  });

  it("two-night warn needs the same marker last night within 48h", () => {
    const now = new Date("2026-11-03T08:20:00Z");
    expect(twoNightWarn(["hedging", "length"], { ts: "2026-11-02T08:20:00Z", warn_h24: ["hedging"] }, now)).toEqual(["hedging"]);
    expect(twoNightWarn(["hedging"], { ts: "2026-10-30T08:20:00Z", warn_h24: ["hedging"] }, now)).toEqual([]);
    expect(twoNightWarn(["hedging"], null, now)).toEqual([]);
  });

  it("log line carries names and z only", () => {
    const l = logLine("cypher", { n: 9, z: { hedging: 2.34 } }, { n: 50, z: {} }, ["hedging"]);
    expect(l).toBe("[voice-drift] cypher h24(n=9) hedging=+2.3 | d7(n=50) - WARN2=hedging");
  });

  it("fetchVoiceRows returns null on 404 and pages on next_after", async () => {
    const f404 = vi.fn().mockResolvedValue({ status: 404, ok: false });
    expect(await fetchVoiceRows("http://h", "s", "cypher", "a", "b", f404 as never)).toBeNull();
    const pages = [{ rows: [row(1)], next_after: "c1" }, { rows: [row(0.9)] }];
    const fp = vi.fn().mockImplementation(async () => ({ status: 200, ok: true, json: async () => pages.shift() }));
    expect((await fetchVoiceRows("http://h", "s", "cypher", "a", "b", fp as never))!.length).toBe(2);
    expect(fp).toHaveBeenCalledTimes(2);
  });
});

describe("runVoiceDriftTick", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vd-"));
    process.env["VOICE_BASELINE_PATH"] = join(dir, "baseline.json");
    process.env["VOICE_DRIFT_PATH"] = join(dir, "drift.jsonl");
    delete process.env["VOICE_DRIFT"];
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const writeBase = () => {
    const base = Array.from({ length: 40 }, (_, i) => row(1, { positive_hits: ["mk:v1", ...(i % 4 === 0 ? ["mk:hedging=1"] : [])] }));
    writeFileSync(process.env["VOICE_BASELINE_PATH"]!, JSON.stringify(
      buildBaseline({ cypher: base, drevan: base, gaia: base }, { from: "a", to: "b" }, { cleanWeight: 1, fullSince: null })));
  };
  const hedgyRows = (now: Date) => Array.from({ length: 12 }, () =>
    row(1, { positive_hits: ["mk:v1", "mk:hedging=3"], created_at: new Date(now.getTime() - 3600_000).toISOString() }));

  it("skips quietly with no baseline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchRows = vi.fn();
    await runVoiceDriftTick({ fetchRows });
    expect(fetchRows).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("tolerates the missing Halseth route", async () => {
    writeBase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runVoiceDriftTick({ fetchRows: async () => null });
    expect(warn.mock.calls.join(" ")).toMatch(/route unavailable/);
    expect(existsSync(process.env["VOICE_DRIFT_PATH"]!)).toBe(false);
  });

  it("appends JSONL per companion and warns on the second night", async () => {
    writeBase();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n1 = new Date("2026-11-02T08:20:00Z");
    await runVoiceDriftTick({ now: () => n1, fetchRows: async () => hedgyRows(n1) });
    expect(readFileSync(process.env["VOICE_DRIFT_PATH"]!, "utf8").trim().split("\n")).toHaveLength(3);
    expect(warn.mock.calls.join(" ")).not.toMatch(/two nights/);
    const n2 = new Date("2026-11-03T08:20:00Z");
    await runVoiceDriftTick({ now: () => n2, fetchRows: async () => hedgyRows(n2) });
    expect(warn.mock.calls.join(" ")).toMatch(/WARN cypher .*two nights running: hedging/);
  });

  it("VOICE_DRIFT=off does nothing", async () => {
    writeBase();
    process.env["VOICE_DRIFT"] = "off";
    const fetchRows = vi.fn();
    await runVoiceDriftTick({ fetchRows });
    expect(fetchRows).not.toHaveBeenCalled();
  });
});
