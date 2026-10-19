import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  TurnTrace, runWithTurn, currentTurn, turnTelemetryEnabled, traceRailOutcome, timeHalseth,
} from "../turn-telemetry.js";
import { railSuppressed } from "../rail-telemetry.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

function mkTrace(c: ReturnType<typeof clock>, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const trace = new TurnTrace({
    companionId: "drevan", channelId: "chan-1", messageId: "m-1", side: "blue",
    createdAt: c.now() - 500, enqueuedAt: c.now() - 400, startedAt: c.now(),
    queueMs: 300, settleMs: 100, gathered: 2, catchup: false,
    now: c.now, log: (l: string) => lines.push(l),
    ...over,
  });
  return { trace, lines };
}

const parse = (line: string) => JSON.parse(line.replace(/^\[turn\] /, ""));

describe("turnTelemetryEnabled", () => {
  it("defaults ON; off/0/false/no (any case, trimmed) disable", () => {
    expect(turnTelemetryEnabled({})).toBe(true);
    for (const v of ["off", "0", "false", "no", " OFF ", "No"]) expect(turnTelemetryEnabled({ TURN_TELEMETRY: v })).toBe(false);
    expect(turnTelemetryEnabled({ TURN_TELEMETRY: "on" })).toBe(true);
    expect(turnTelemetryEnabled({ TURN_TELEMETRY: "junk" })).toBe(true);
  });
});

describe("TurnTrace line", () => {
  it("one [turn] JSON line with the whole schema, ids/counts/timings only", () => {
    const c = clock();
    const { trace, lines } = mkTrace(c);
    trace.setVision(1200, "wait");
    trace.addHalseth(80); trace.addHalseth(40);
    trace.setInference(4000);
    c.tick(4300);
    trace.setPost(150);
    trace.setOutcome("posted");
    c.tick(150);
    trace.emit();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("[turn] {")).toBe(true);
    const o = parse(lines[0]!);
    expect(o).toEqual({
      c: "drevan", ch: "chan-1", msg: "m-1", side: "blue", outcome: "posted",
      queue_ms: 300, settle_ms: 100, gathered: 2,
      vision_ms: 1200, vision: "wait", halseth_ms: 120, inference_ms: 4000, post_ms: 150,
      total_ms: 500 + 4300 + 150, catchup: false, in_tok: null, at: expect.any(String),
    });
  });

  it("emits at most once", () => {
    const c = clock(); const { trace, lines } = mkTrace(c);
    trace.setOutcome("posted"); trace.emit(); trace.emit();
    expect(lines).toHaveLength(1);
  });

  it("unmeasured stages read 0 / vision none / side null when unknown", () => {
    const c = clock(); const { trace, lines } = mkTrace(c, { side: null });
    trace.setOutcome("absorbed"); trace.emit();
    const o = parse(lines[0]!);
    expect(o.side).toBeNull();
    expect(o.vision).toBe("none");
    expect(o.vision_ms).toBe(0); expect(o.halseth_ms).toBe(0); expect(o.inference_ms).toBe(0); expect(o.post_ms).toBe(0);
  });

  it("falls back to the enqueue time when createdAt is missing or in the future (clock skew)", () => {
    const c = clock();
    const a = mkTrace(c, { createdAt: null }); c.tick(50); a.trace.setOutcome("posted"); a.trace.emit();
    expect(parse(a.lines[0]!).total_ms).toBe(450);
    const c2 = clock();
    const b = mkTrace(c2, { createdAt: c2.now() + 9999 }); b.trace.setOutcome("posted"); b.trace.emit();
    expect(parse(b.lines[0]!).total_ms).toBe(400);
  });

  it("records in_tok when the adapter reported it", () => {
    const c = clock(); const { trace, lines } = mkTrace(c);
    trace.setInTok(1234); trace.setOutcome("posted"); trace.emit();
    expect(parse(lines[0]!).in_tok).toBe(1234);
  });

  it("first outcome wins, except posted which always wins", () => {
    const c = clock();
    const a = mkTrace(c); a.trace.setOutcome("skipped:echo"); a.trace.setOutcome("skipped:coherence"); a.trace.emit();
    expect(parse(a.lines[0]!).outcome).toBe("skipped:echo");
    const b = mkTrace(c); b.trace.setOutcome("skipped:echo"); b.trace.setOutcome("posted"); b.trace.emit();
    expect(parse(b.lines[0]!).outcome).toBe("posted");
  });

  it("never carries message or reply text: only the schema keys exist", () => {
    const c = clock(); const { trace, lines } = mkTrace(c);
    trace.setOutcome("posted"); trace.emit();
    expect(Object.keys(parse(lines[0]!)).sort()).toEqual([
      "at", "c", "catchup", "ch", "gathered", "halseth_ms", "in_tok", "inference_ms", "msg", "outcome",
      "post_ms", "queue_ms", "settle_ms", "side", "total_ms", "vision", "vision_ms",
    ].sort());
  });

  it("finish() derives the outcome when none was set: superseded -> absorbed, else skipped:other, threw -> skipped:error", () => {
    const c = clock();
    const a = mkTrace(c); a.trace.finish({ superseded: true }); expect(parse(a.lines[0]!).outcome).toBe("absorbed");
    const b = mkTrace(c); b.trace.finish({ superseded: false }); expect(parse(b.lines[0]!).outcome).toBe("skipped:other");
    const d = mkTrace(c); d.trace.finish({ superseded: false, threw: true }); expect(parse(d.lines[0]!).outcome).toBe("skipped:error");
    const e = mkTrace(c); e.trace.setOutcome("posted"); e.trace.finish({ superseded: true }); expect(parse(e.lines[0]!).outcome).toBe("posted");
  });

  it("TURN_TELEMETRY=off: emit writes nothing", () => {
    const c = clock(); const { trace, lines } = mkTrace(c, { enabled: false });
    trace.setOutcome("posted"); trace.emit();
    expect(lines).toHaveLength(0);
  });
});

describe("ambient turn (AsyncLocalStorage)", () => {
  beforeEach(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it("currentTurn() is the trace across awaits; undefined outside", async () => {
    const c = clock(); const { trace } = mkTrace(c);
    expect(currentTurn()).toBeUndefined();
    await runWithTurn(trace, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTurn()).toBe(trace);
    });
    expect(currentTurn()).toBeUndefined();
  });

  it("railSuppressed inside a turn marks skipped:<rail>; superseded maps to superseded_b", async () => {
    const c = clock();
    const a = mkTrace(c);
    await runWithTurn(a.trace, async () => { railSuppressed("drevan", "echo", { channelId: "chan-1" }); });
    a.trace.emit();
    expect(parse(a.lines[0]!).outcome).toBe("skipped:echo");
    const b = mkTrace(c);
    await runWithTurn(b.trace, async () => { railSuppressed("drevan", "superseded", { channelId: "chan-1" }); });
    b.trace.emit();
    expect(parse(b.lines[0]!).outcome).toBe("superseded_b");
  });

  it("railSuppressed outside a turn is untouched (no throw)", () => {
    expect(() => railSuppressed("drevan", "echo", {})).not.toThrow();
    expect(() => traceRailOutcome("echo")).not.toThrow();
  });

  it("timeHalseth adds the call's duration to the ambient turn and returns the value", async () => {
    const c = clock(); const { trace, lines } = mkTrace(c);
    const v = await runWithTurn(trace, () => timeHalseth(async () => { c.tick(70); return "ok"; }, c.now));
    expect(v).toBe("ok");
    trace.setOutcome("posted"); trace.emit();
    expect(parse(lines[0]!).halseth_ms).toBe(70);
  });

  it("timeHalseth counts a throwing call and rethrows", async () => {
    const c = clock(); const { trace, lines } = mkTrace(c);
    await expect(runWithTurn(trace, () => timeHalseth(async () => { c.tick(30); throw new Error("x"); }, c.now))).rejects.toThrow("x");
    trace.setOutcome("posted"); trace.emit();
    expect(parse(lines[0]!).halseth_ms).toBe(30);
  });

  it("timeHalseth outside a turn just runs the function", async () => {
    expect(await timeHalseth(async () => 5)).toBe(5);
  });
});
