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
  test("her short register is never scored", () => {
    expect(ownEchoGated("gaia", "I am here. The perimeter holds.", ["I am here. The perimeter holds."]).gated).toBe(false);
  });
});
