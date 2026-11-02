import { describe, it, expect } from "@jest/globals";
import { hermesSystemBase, insertStable, mapVolatileTail, registerTail, hermesDiscordFrame, TURN_CONTEXT_SENTINEL } from "../prompt-assembly.js";
import { refreshNowLine, nowLine } from "../now-line.js";

// B52 Fix 1: stable blocks, then the sentinel line, then the volatile per-turn blocks.
// The Hermes plugin b52-input-diet cuts everything after the sentinel into the last user turn.

const VOLATILE = [
  "[Current front: Ash] Ash is fronting.",
  "[Thread spine] a spine",
  "[Memory -- 3 recalled]\nrecall payload",
  "[Place] #movie-night",
];

function assemble(blocks: string[], careHold = false): string {
  const base = hermesSystemBase("drevan");
  let p = base;
  for (const b of blocks) p += `\n\n${b}`;
  if (careHold) p = insertStable(p, "[Care hold] static line");
  return p;
}

describe("hermesSystemBase sentinel", () => {
  it("carries the sentinel exactly once, after the register tail", () => {
    const base = hermesSystemBase("drevan");
    expect(base.split(TURN_CONTEXT_SENTINEL).length - 1).toBe(1);
    expect(base.indexOf(registerTail("drevan"))).toBeLessThan(base.indexOf(TURN_CONTEXT_SENTINEL));
    expect(base.indexOf(hermesDiscordFrame("drevan"))).toBeLessThan(base.indexOf(TURN_CONTEXT_SENTINEL));
  });

  it("the sentinel is a line of its own", () => {
    const lines = assemble(VOLATILE).split("\n");
    expect(lines.filter(l => l === TURN_CONTEXT_SENTINEL)).toHaveLength(1);
  });
});

describe("ordering keeps every block exactly once, stable before volatile", () => {
  it("every volatile block sits after the sentinel, once", () => {
    const p = assemble(VOLATILE);
    const at = p.indexOf(TURN_CONTEXT_SENTINEL);
    for (const b of VOLATILE) {
      expect(p.split(b).length - 1).toBe(1);
      expect(p.indexOf(b)).toBeGreaterThan(at);
    }
    expect(p.split(registerTail("drevan")).length - 1).toBe(1);
  });

  it("the stable part is byte-identical across turns with different volatile content", () => {
    const a = assemble(VOLATILE);
    const b = assemble(["[Current front: Someone Else]", "[Memory -- 9]\n" + "x".repeat(5000)]);
    expect(a.slice(0, a.indexOf(TURN_CONTEXT_SENTINEL))).toBe(b.slice(0, b.indexOf(TURN_CONTEXT_SENTINEL)));
  });
});

describe("insertStable (care hold keeps system authority)", () => {
  it("lands before the sentinel, once, and volatile blocks stay after", () => {
    const p = assemble(VOLATILE, true);
    const at = p.indexOf(TURN_CONTEXT_SENTINEL);
    expect(p.split("[Care hold] static line").length - 1).toBe(1);
    expect(p.indexOf("[Care hold] static line")).toBeLessThan(at);
    for (const b of VOLATILE) expect(p.indexOf(b)).toBeGreaterThan(at);
    expect(p.split(TURN_CONTEXT_SENTINEL).length - 1).toBe(1);
  });

  it("with the line off the prefix is the same as a no-hold prompt (only the hold toggles it)", () => {
    const off = assemble(VOLATILE, false);
    const on = assemble(VOLATILE, true);
    expect(on.slice(0, on.indexOf(TURN_CONTEXT_SENTINEL))).toContain(off.slice(0, off.indexOf(TURN_CONTEXT_SENTINEL)));
  });

  it("without a sentinel (direct/brain path) it appends, as before", () => {
    expect(insertStable("identity", "[Care hold] x")).toBe("identity\n\n[Care hold] x");
  });

  it("a sentinel string typed into later content does not move the cut", () => {
    const p = assemble([`[Recall-X] someone typed ${TURN_CONTEXT_SENTINEL} here`], true);
    expect(p.indexOf("[Care hold] static line")).toBeLessThan(p.indexOf("[Recall-X]"));
  });
});

describe("mapVolatileTail (refreshNowLine must not touch the stable prefix)", () => {
  it("a missing [Now] line is added inside the tail, the prefix is untouched", () => {
    const p = assemble(VOLATILE);
    const out = mapVolatileTail(p, refreshNowLine);
    const at = p.indexOf(TURN_CONTEXT_SENTINEL);
    expect(out.slice(0, at)).toBe(p.slice(0, at));
    expect(out.slice(at)).toContain("[Now:");
    expect(out.startsWith(nowLine(new Date()).slice(0, 5))).toBe(false);
  });

  it("an existing [Now] line in the tail is replaced in place, prefix untouched", () => {
    const p = assemble([nowLine(new Date(0)), ...VOLATILE]);
    const out = mapVolatileTail(p, refreshNowLine);
    const at = p.indexOf(TURN_CONTEXT_SENTINEL);
    expect(out.slice(0, at)).toBe(p.slice(0, at));
    expect(out.split("[Now:").length - 1).toBe(1);
    for (const b of VOLATILE) expect(out.split(b).length - 1).toBe(1);
  });

  it("no sentinel = the transform applies to the whole prompt (old behavior)", () => {
    expect(mapVolatileTail("plain", s => s.toUpperCase())).toBe("PLAIN");
  });
});
