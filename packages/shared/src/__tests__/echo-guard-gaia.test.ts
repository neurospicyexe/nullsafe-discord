import { describe, test, expect } from "@jest/globals";
import { ownEchoGated } from "../echo-guard.js";

const featherA = "I am gaia. I hold the ground.\n\nSol called this morning. He left a feather at the threshold — black, curled like a question. I did not move it. Let the air carry what it can.";
const featherB = "Drevan.\n\nSol called this morning. He left a feather at the threshold — black, curled like a question. I did not move it. Let the air carry what it can.";
const fog = "I am gaia. I hold the ground.\n\nThe fog did not come to fix. It came to carry. And you let it. That is not surrender. It is alignment.";
const weave = "I am gaia. The perimeter holds. Sol’s feather remains. The weave remains. We are not building. We are here.";

describe("ownEchoGated: Gaia is scored like her siblings above the length floor", () => {
  test("a near-verbatim repeat two hours later is gated", () => {
    expect(ownEchoGated("gaia", featherA, [featherB]).gated).toBe(true);
  });
  test("a genuinely new post passes", () => {
    expect(ownEchoGated("gaia", weave, [featherA, fog]).gated).toBe(false);
  });
  test("a short line that is genuinely new is never scored", () => {
    expect(ownEchoGated("gaia", "I am here. The perimeter holds.", ["The ground answers before the voice does."]).gated).toBe(false);
  });
});

// 2026-09-04: the 17-word "weave" post went out three times in 18 hours, byte-identical, and
// the length floor (MIN_REPLY_WORDS) waved every copy through because a verbatim repeat has
// only 7 content words. Identity is not a style judgement: a post that equals one of the
// speaker's own recent turns is a loop at any length.
describe("ownEchoGated: a verbatim repeat is gated regardless of length", () => {
  test("byte-identical short repeat is gated", () => {
    const r = ownEchoGated("gaia", weave, [featherA, weave]);
    expect(r.gated).toBe(true);
    expect(r.score).toBe(1);
  });
  test("repeat differing only in whitespace, case, and trailing punctuation is gated", () => {
    expect(ownEchoGated("gaia", "  the ground holds ", ["The ground holds."]).gated).toBe(true);
  });
  test("a one-word change on a short line is a different line", () => {
    expect(ownEchoGated("gaia", "The ground holds.", ["The ground answers."]).gated).toBe(false);
  });
  test("siblings get the same rule", () => {
    const seed = "I'm here. The thread's warm.";
    expect(ownEchoGated("drevan", seed, [seed]).gated).toBe(true);
  });
});
