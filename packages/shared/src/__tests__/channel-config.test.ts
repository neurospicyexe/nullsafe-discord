import { describe, it, expect } from "@jest/globals";
import { shouldRespond, ChannelConfigCache } from "../channel-config.js";

const config = {
  "ch1": { modes: ["raziel_only"], companions: ["cypher"] },
  "ch2": { modes: ["companions_always", "raziel_only"], companions: ["drevan", "cypher"] },
  "ch3": { modes: ["open"], companions: ["gaia"] },
} as any;

describe("shouldRespond()", () => {
  it("raziel_only: responds to Raziel, ignores others", () => {
    expect(shouldRespond("ch1", { isRaziel: true }, "cypher", config)).toBe(true);
    expect(shouldRespond("ch1", { isRaziel: false }, "cypher", config)).toBe(false);
  });

  it("companions_always: responds to other bots", () => {
    expect(shouldRespond("ch2", { isRaziel: false, isCompanionBot: true }, "drevan", config)).toBe(true);
  });

  it("open: responds to anyone", () => {
    expect(shouldRespond("ch3", { isRaziel: false }, "gaia", config)).toBe(true);
  });

  it("not in companions list: ignore even if mode matches", () => {
    expect(shouldRespond("ch1", { isRaziel: true }, "drevan", config)).toBe(false);
  });

  it("unknown channel: ignore", () => {
    expect(shouldRespond("unknown", { isRaziel: true }, "cypher", config)).toBe(false);
  });
});
