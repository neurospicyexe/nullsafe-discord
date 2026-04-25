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

  it("two companions named returns named_multi with both", () => {
    const result = extractAddress("dre and cy what do you both think?");
    expect(result.type).toBe("named_multi");
    if (result.type === "named_multi") {
      expect(result.ids).toContain("drevan");
      expect(result.ids).toContain("cypher");
    }
  });

  it("all three named returns named_multi with all three", () => {
    const result = extractAddress("drevan cypher gaia weigh in");
    expect(result.type).toBe("named_multi");
    if (result.type === "named_multi") {
      expect(result.ids).toHaveLength(3);
    }
  });
});

describe("shouldRespond() -- named_multi", () => {
  const multiConfig = {
    "ch-multi": { modes: ["owner_only"], companions: ["drevan", "cypher", "gaia"] },
  } as any;

  it("named_multi: both named companions pass shouldRespond", () => {
    expect(shouldRespond("ch-multi", "dre and cy what do you think?", { isOwner: true }, "drevan", multiConfig)).toBe(true);
    expect(shouldRespond("ch-multi", "dre and cy what do you think?", { isOwner: true }, "cypher", multiConfig)).toBe(true);
    expect(shouldRespond("ch-multi", "dre and cy what do you think?", { isOwner: true }, "gaia", multiConfig)).toBe(false);
  });

  it("named_multi in inter_companion channel: both named bots pass", () => {
    const cfg = { "ch-ic": { modes: ["inter_companion"], companions: ["drevan", "cypher", "gaia"] } } as any;
    expect(shouldRespond("ch-ic", "drevan and gaia hear this", { isOwner: false, isCompanionBot: true }, "drevan", cfg)).toBe(true);
    expect(shouldRespond("ch-ic", "drevan and gaia hear this", { isOwner: false, isCompanionBot: true }, "gaia", cfg)).toBe(true);
    expect(shouldRespond("ch-ic", "drevan and gaia hear this", { isOwner: false, isCompanionBot: true }, "cypher", cfg)).toBe(false);
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
