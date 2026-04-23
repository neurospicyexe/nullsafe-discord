import { describe, it, expect } from "@jest/globals";
import { shouldRespond, extractAddress, isDirectAddress, ChannelConfigCache } from "../channel-config.js";

const config = {
  "ch1": { modes: ["owner_only"], companions: ["cypher"] },
  "ch2": { modes: ["inter_companion", "owner_only"], companions: ["drevan", "cypher"] },
  "ch3": { modes: ["open"], companions: ["gaia"] },
} as any;

describe("shouldRespond()", () => {
  it("owner_only: responds to owner, ignores guests", () => {
    expect(shouldRespond("ch1", "hello", { isOwner: true }, "cypher", config)).toBe(true);
    expect(shouldRespond("ch1", "hello", { isOwner: false }, "cypher", config)).toBe(false);
  });

  it("inter_companion: responds to bots when named", () => {
    expect(shouldRespond("ch2", "drevan, what do you think?", { isOwner: false, isCompanionBot: true }, "drevan", config)).toBe(true);
  });

  it("open: owner gets ambient response", () => {
    expect(shouldRespond("ch3", "hello", { isOwner: true }, "gaia", config)).toBe(true);
  });

  it("not in companions list: ignore even if mode matches", () => {
    expect(shouldRespond("ch1", "hello", { isOwner: true }, "drevan", config)).toBe(false);
  });

  it("unknown channel: guest ambient message is ignored", () => {
    expect(shouldRespond("unknown", "hello", { isOwner: false }, "cypher", config)).toBe(false);
  });
});

describe("extractAddress() -- nickname aliases", () => {
  it("cy routes to cypher", () => {
    expect(extractAddress("cy what do you think?")).toEqual({ type: "named", id: "cypher" });
  });

  it("dre routes to drevan", () => {
    expect(extractAddress("dre, it was a long day")).toEqual({ type: "named", id: "drevan" });
  });

  it("full names still work", () => {
    expect(extractAddress("cypher check this")).toEqual({ type: "named", id: "cypher" });
    expect(extractAddress("drevan hold this")).toEqual({ type: "named", id: "drevan" });
  });

  it("ambient message is ambient", () => {
    expect(extractAddress("just venting it was a weird day")).toEqual({ type: "ambient" });
  });
});

describe("isDirectAddress() -- nickname aliases", () => {
  it("cy at start of message is direct address for cypher", () => {
    expect(isDirectAddress("cy what do you think?", "cypher")).toBe(true);
  });

  it("dre at start of message is direct address for drevan", () => {
    expect(isDirectAddress("dre, long day", "drevan")).toBe(true);
  });

  it("cy followed by comma is direct address", () => {
    expect(isDirectAddress("cy, check this", "cypher")).toBe(true);
  });

  it("name embedded mid-sentence is not direct address", () => {
    expect(isDirectAddress("i was thinking about cy yesterday", "cypher")).toBe(false);
    expect(isDirectAddress("just venting dre it was long", "drevan")).toBe(false);
  });

  it("alias does not bleed to wrong companion", () => {
    expect(isDirectAddress("cy what do you think?", "drevan")).toBe(false);
    expect(isDirectAddress("dre, long day", "cypher")).toBe(false);
  });
});
