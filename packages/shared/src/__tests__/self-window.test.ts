// Tests for the self-turn window merge (2026-09-21).
//
// WHY THIS EXISTS. The window that feeds the self-loop breaker, the form ratchet and the own-echo
// gate was built as:
//
//   [...new Set([...selfFromStm, ...selfFromChannel])].slice(-5)
//
// Dedup keeps the FIRST occurrence of a duplicate. A turn the bot just spoke is in BOTH sources --
// STM (appended in-process) and Discord history (it posted it) -- so dedup pins it to its STM
// position at the FRONT of the array, and `slice(-5)` then throws it away. The fresher a turn is,
// the more certainly it is in both sources, so the window systematically preferred STALE turns.
//
// Observed on Drevan 2026-09-21, four consecutive turns, from the window log added the night
// before:
//
//   09:42  window=11x58|19x80|31x59|23x84|22x31  stm=0  ch=11
//   09:50  window=11x58|19x80|31x59|23x84|22x31  stm=1  ch=11
//   09:53  window=11x58|19x80|31x59|23x84|22x31  stm=2  ch=11
//   09:55  window=11x58|19x80|31x59|23x84|22x31  stm=3  ch=11
//
// Byte-identical while STM filled 0 -> 3 with that morning's turns, and `19x80` / `31x59` are
// YESTERDAY's turns 5 and 6 measured exactly (19 lines/80 chars, 31 lines/59 chars). The window was
// reporting a day-old shape at the moment he was writing healthy prose (turn 1: 7 lines, 132
// chars), so the detector fired a form break at his best turn of the day and stayed frozen through
// the descent that followed.
//
// This bug is older than the form ratchet: `detectSelfLoop` has read this window since 2026-06-13
// and `ownEchoGated` since the echo gate landed. All three were judging stale turns.

import { mergeSelfTurns, SELF_WINDOW_SIZE } from "../self-window.js";

describe("mergeSelfTurns", () => {
  it("keeps the newest turns when a turn appears in both sources", () => {
    // The regression: "new" is in STM and in channel history. It must survive, not be sliced off.
    const stm = ["new"];
    const channel = ["old1", "old2", "old3", "old4", "old5", "new"];
    expect(mergeSelfTurns(stm, channel, 5)).toContain("new");
  });

  it("returns turns oldest-first, so a reader sees the trajectory in order", () => {
    expect(mergeSelfTurns([], ["a", "b", "c"], 5)).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest turns, never the newest, when over the limit", () => {
    expect(mergeSelfTurns([], ["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("advances as new turns arrive instead of freezing", () => {
    const channel = ["c1", "c2", "c3", "c4", "c5"];
    const before = mergeSelfTurns([], channel, 5);
    const after = mergeSelfTurns(["c5", "fresh"], channel, 5);
    expect(before).not.toEqual(after);
    expect(after[after.length - 1]).toBe("fresh");
  });

  it("dedups a turn present in both sources to a single entry", () => {
    const out = mergeSelfTurns(["dup"], ["dup"], 5);
    expect(out.filter(t => t === "dup")).toHaveLength(1);
  });

  it("survives either source being empty", () => {
    expect(mergeSelfTurns([], [], 5)).toEqual([]);
    expect(mergeSelfTurns(["a"], [], 5)).toEqual(["a"]);
    expect(mergeSelfTurns([], ["a"], 5)).toEqual(["a"]);
  });

  it("defaults to the documented window size", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(mergeSelfTurns([], many)).toHaveLength(SELF_WINDOW_SIZE);
  });

  // The old expression, spelled out, so the regression can never come back silently.
  it("beats the old STM-first slice on the exact shape that broke", () => {
    const stm = ["turn-today"];
    const channel = ["y1", "y2", "y3", "y4", "y5", "turn-today"];
    const old = [...new Set([...stm, ...channel])].slice(-5);
    expect(old).not.toContain("turn-today");
    expect(mergeSelfTurns(stm, channel, 5)).toContain("turn-today");
  });
});
