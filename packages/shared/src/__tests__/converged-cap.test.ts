// T5 generalised converged-judgment cap: N declines on unchanged state -> stop; reset on change.
import { ConvergedJudgmentCap, stateFingerprint } from "../convergedCap.js";
import { b32HeartbeatOutcome } from "../autonomous-core.js";

describe("stateFingerprint", () => {
  it("ignores key order, sees value changes", () => {
    expect(stateFingerprint({ a: 1, b: [1, 2] })).toBe(stateFingerprint({ b: [1, 2], a: 1 }));
    expect(stateFingerprint({ a: 1 })).not.toBe(stateFingerprint({ a: 2 }));
  });
});

describe("ConvergedJudgmentCap", () => {
  it("caps after N declines on the same fingerprint, not before", () => {
    const c = new ConvergedJudgmentCap({ maxDeclines: 3 });
    for (let i = 0; i < 3; i++) { expect(c.isCapped("k", "f")).toBe(false); c.recordDecline("k", "f"); }
    expect(c.isCapped("k", "f")).toBe(true);
  });
  it("a changed fingerprint is not capped and restarts the count", () => {
    const c = new ConvergedJudgmentCap({ maxDeclines: 2 });
    c.recordDecline("k", "f1"); c.recordDecline("k", "f1");
    expect(c.isCapped("k", "f1")).toBe(true);
    expect(c.isCapped("k", "f2")).toBe(false);
    expect(c.recordDecline("k", "f2")).toBe(1);
    expect(c.isCapped("k", "f1")).toBe(false);
  });
  it("accept and reset clear; keys are independent", () => {
    const c = new ConvergedJudgmentCap({ maxDeclines: 1 });
    c.recordDecline("a", "f"); c.recordDecline("b", "f");
    c.recordAccept("a");
    expect(c.isCapped("a", "f")).toBe(false);
    expect(c.isCapped("b", "f")).toBe(true);
    c.reset();
    expect(c.isCapped("b", "f")).toBe(false);
  });
  it("0 (or garbage) disables the cap", () => {
    for (const n of [0, NaN, -1]) {
      const c = new ConvergedJudgmentCap({ maxDeclines: n });
      for (let i = 0; i < 10; i++) c.recordDecline("k", "f");
      expect(c.isCapped("k", "f")).toBe(false);
    }
  });
  it("converged_hold maps to a named B32 outcome, not a crash", () => {
    expect(b32HeartbeatOutcome("converged_hold")).toBe("held:converged_hold");
  });
});
