// P5 standing calibration (scripts/jev-calibration.mjs): pure analysis functions.
import { describe, it, expect } from "@jest/globals";
// @ts-ignore -- plain ESM script, no types
import * as cal from "../../../../scripts/jev-calibration.mjs";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const row = (o: Record<string, unknown> = {}) => ({
  ts: new Date(NOW - 3_600_000).toISOString(), companion: "drevan", message_id: String(Math.random()),
  jev_ok: true, worth: 0.8, judge: "skip", salience: 1, ...o,
});
const OPTS = { warnWriteShift: 10, warnFallback: 5, warnKs: 0.25, minRows: 30 };

describe("primitives", () => {
  it("auroc: perfect, inverted, tied, empty", () => {
    expect(cal.auroc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(cal.auroc([0.1], [0.9])).toBe(0);
    expect(cal.auroc([0.5], [0.5])).toBe(0.5);
    expect(cal.auroc([], [0.5])).toBeNull();
  });
  it("KS is 0 for identical histograms and 1 for disjoint", () => {
    expect(cal.ksFromHist([1, 1, 0, 0], [2, 2, 0, 0])).toBe(0);
    expect(cal.ksFromHist([1, 0], [0, 1])).toBe(1);
  });
  it("parseLabels: keep/skip/drift, unsure ignored, id map form", () => {
    const m = cal.parseLabels(JSON.stringify([{ message_id: "1", label: "KEEP" }, { id: "2", label: "DRIFT" }, { id: "3", label: "unsure" }]));
    expect([...m.entries()]).toEqual([["1", 1], ["2", 0]]);
    expect(cal.parseLabels(JSON.stringify({ a: "keep", b: "skip" })).get("a")).toBe(1);
  });
  it("bestTheta maximises accuracy, ties go nearest the live theta", () => {
    const pairs = [{ worth: 0.9, y: 1 }, { worth: 0.7, y: 1 }, { worth: 0.4, y: 0 }, { worth: 0.3, y: 0 }];
    const b = cal.bestTheta(pairs, 0.6);
    expect(b.acc).toBe(1);
    expect(b.theta).toBe(0.7);
  });
  it("parseThetas: defaults, env, flag override", () => {
    expect(cal.parseThetas("", {})).toEqual({ cypher: 0.7, drevan: 0.7, gaia: 0.6 });
    expect(cal.parseThetas("gaia=0.5", { JEV_WRITEBACK_THETA_CYPHER: "0.8" })).toMatchObject({ cypher: 0.8, gaia: 0.5 });
  });
});

describe("analyseCompanion", () => {
  it("agreement matrix and write rates at the live theta", () => {
    const rows = [row({ worth: 0.9, judge: "companion_note" }), row({ worth: 0.9, judge: "skip" }), row({ worth: 0.2, judge: "companion_note" }), row({ worth: 0.2, judge: "skip" })];
    const r = cal.analyseCompanion("drevan", rows, 0.7, 2, null, null, OPTS, NOW);
    expect(r.legacy.matrix).toEqual({ both_write: 1, jev_only: 1, judge_only: 1, both_skip: 1 });
    expect(r.jev_write_rate).toBe(0.5);
    expect(r.legacy.judge_write_rate).toBe(0.5);
  });
  it("fallback/error rate warns past the limit once there are enough rows; stays quiet below minRows", () => {
    const many = [...Array(30).fill(0).map(() => row()), ...Array(10).fill(0).map(() => row({ jev_ok: false, reason: "http_401", worth: undefined, fallback: "legacy" }))];
    const r = cal.analyseCompanion("drevan", many, 0.7, 2, null, null, OPTS, NOW);
    expect(r.warnings.map((w: { name: string }) => w.name)).toEqual(expect.arrayContaining(["fallback_rate", "error_rate_24h"]));
    const few = cal.analyseCompanion("drevan", [row({ jev_ok: false, reason: "x", worth: undefined })], 0.7, 2, null, null, OPTS, NOW);
    expect(few.warnings).toEqual([]);
  });
  it("drift vs baseline: write-rate shift and KS warn; same distribution does not", () => {
    const mk = (w: number) => Array(40).fill(0).map(() => row({ worth: w }));
    const baseRep = cal.buildReport({ rows: mk(0.9), thetas: { cypher: 0.7, drevan: 0.7, gaia: 0.6 }, notable: 2, baseline: null, labels: null, days: 7, opts: OPTS, now: NOW });
    const baseline = cal.baselineFrom(baseRep);
    const same = cal.analyseCompanion("drevan", mk(0.9), 0.7, 2, baseline, null, OPTS, NOW);
    expect(same.warnings).toEqual([]);
    const shifted = cal.analyseCompanion("drevan", mk(0.3), 0.7, 2, baseline, null, OPTS, NOW);
    expect(shifted.warnings.map((w: { name: string }) => w.name)).toEqual(expect.arrayContaining(["write_rate_shift", "worth_distribution_drift"]));
  });
  it("labels: precision, recall, AUROC and best theta", () => {
    const rows = [row({ message_id: "a", worth: 0.9 }), row({ message_id: "b", worth: 0.8 }), row({ message_id: "c", worth: 0.75 }), row({ message_id: "d", worth: 0.3 })];
    const labels = new Map([["a", 1], ["b", 1], ["c", 0], ["d", 0]]);
    const r = cal.analyseCompanion("drevan", rows, 0.7, 2, null, labels, OPTS, NOW);
    expect(r.labels.precision).toBeCloseTo(2 / 3);
    expect(r.labels.recall).toBe(1);
    expect(r.labels.auroc).toBe(1);
    expect(r.labels.best.theta).toBe(0.8);
  });
});
