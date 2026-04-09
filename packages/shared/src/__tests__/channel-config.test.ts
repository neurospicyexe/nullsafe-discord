import { describe, it, expect } from "@jest/globals";
import { shouldRespond, ChannelConfigCache } from "../channel-config.js";

const config = {
  "ch1": { modes: ["raziel_only"], companions: ["cypher"] },
  "ch2": { modes: ["inter_companion", "raziel_only"], companions: ["drevan", "cypher"] },
  "ch3": { modes: ["open"], companions: ["gaia"] },
} as any;

describe("shouldRespond()", () => {
  it("raziel_only: responds to Raziel, ignores guests", () => {
    expect(shouldRespond("ch1", "hello", { isRaziel: true }, "cypher", config)).toBe(true);
    expect(shouldRespond("ch1", "hello", { isRaziel: false }, "cypher", config)).toBe(false);
  });

  it("inter_companion: responds to bots when named", () => {
    expect(shouldRespond("ch2", "drevan, what do you think?", { isRaziel: false, isCompanionBot: true }, "drevan", config)).toBe(true);
  });

  it("open: Raziel gets ambient response", () => {
    expect(shouldRespond("ch3", "hello", { isRaziel: true }, "gaia", config)).toBe(true);
  });

  it("not in companions list: ignore even if mode matches", () => {
    expect(shouldRespond("ch1", "hello", { isRaziel: true }, "drevan", config)).toBe(false);
  });

  it("unknown channel: guest ambient message is ignored", () => {
    expect(shouldRespond("unknown", "hello", { isRaziel: false }, "cypher", config)).toBe(false);
  });
});
