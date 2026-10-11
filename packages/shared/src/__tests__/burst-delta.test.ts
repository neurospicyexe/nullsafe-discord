// Burst settle skips the earlier turns' REPLIES but must not skip their WORDS. The hermes delivered
// mark advances only after the gateway answers a turn (bot-message-handler.ts, "Advance the hermes
// delivered mark only now that the gateway actually answered"); a superseded turn returns at
// supersede check A, before any gateway call, so it never moves the mark. The answering turn's
// hermesDelta therefore folds EVERY undelivered earlier message into one prompt.

import { describe, it, expect } from "@jest/globals";
import { hermesDelta } from "../prompt-assembly.js";

describe("hermesDelta over a settled burst", () => {
  const history = [
    { role: "assistant", content: "earlier reply", timestamp: 1_000 },
    { role: "user", content: "Dre, are you up", authorName: "Crash", timestamp: 2_000 },     // burst message 1 (absorbed, superseded)
    { role: "user", content: "also the other thing", authorName: "Crash", timestamp: 3_000 }, // burst message 2 (the answering turn)
  ];

  it("both burst messages reach the prompt: the first in the witness block, the second as the live message", () => {
    // mark = 1_000: the last delivered turn. Message 1's superseded turn did NOT advance it.
    const out = hermesDelta(history, 1_000, 10_000);
    const body = out.messages[0]!.content;
    expect(body).toContain("Dre, are you up");
    expect(body).toContain("also the other thing");
    expect(body.indexOf("Dre, are you up")).toBeLessThan(body.indexOf("also the other thing"));
    expect(out.deliveredThroughTs).toBe(3_000);   // the mark moves to the live message only after the gateway answers
  });

  it("had the skipped turn advanced the mark, its words would be lost (the failure this guards)", () => {
    const out = hermesDelta(history, 2_000, 10_000);
    expect(out.messages[0]!.content).not.toContain("Dre, are you up");
  });
});
