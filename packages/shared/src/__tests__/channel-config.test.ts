import { describe, it, expect } from "@jest/globals";
import { shouldRespond, extractAddress, isDirectAddress, isVocativeAddress, isVocativeGroupCall, ChannelConfigCache, computeChainDepth, NEW_THREAD_GAP_MS } from "../channel-config.js";

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

describe("shouldRespond() -- companion-to-companion vocative gating (2026-06-26 loop fix)", () => {
  const ic = {
    "tri": { modes: ["inter_companion", "owner_only"], companions: ["drevan", "cypher", "gaia"] },
  } as any;
  const peer = { isOwner: false, isCompanionBot: true };

  it("help-menu text containing 'the triad' does NOT summon peers (transcript 1)", () => {
    const help = 'cy: imps on / cy: imps off (or "just the triad") -- toggle imp flavor globally';
    expect(shouldRespond("tri", help, peer, "drevan", ic)).toBe(false);
    expect(shouldRespond("tri", help, peer, "gaia", ic)).toBe(false);
  });

  it("narrative name mention does NOT trigger that companion (transcript 2)", () => {
    expect(shouldRespond("tri", "Gaia hasn't spoken up yet. She'll come through.", peer, "gaia", ic)).toBe(false);
    expect(shouldRespond("tri", "Drevan named it right -- quiet doesn't mean absent.", peer, "drevan", ic)).toBe(false);
  });

  it("a name with a trailing period (not vocative) does NOT trigger", () => {
    expect(shouldRespond("tri", "Gaia. You held the perimeter while we were loud.", peer, "gaia", ic)).toBe(false);
  });

  it("genuine vocative address DOES trigger the named peer only", () => {
    expect(shouldRespond("tri", "Gaia, you held the perimeter.", peer, "gaia", ic)).toBe(true);
    expect(shouldRespond("tri", "Gaia, you held the perimeter.", peer, "drevan", ic)).toBe(false);
  });

  it("trailing vocative ('..., gaia?') triggers", () => {
    expect(shouldRespond("tri", "what do you think, gaia?", peer, "gaia", ic)).toBe(true);
  });

  it("genuine group call ('you three,') triggers all", () => {
    expect(shouldRespond("tri", "you three, let's focus.", peer, "gaia", ic)).toBe(true);
    expect(shouldRespond("tri", "you three, let's focus.", peer, "drevan", ic)).toBe(true);
  });

  it("alias vocative ('cy:') triggers cypher", () => {
    expect(shouldRespond("tri", "cy: run the audit", peer, "cypher", ic)).toBe(true);
  });

  it("non-inter_companion channel never triggers peers", () => {
    const oc = { "x": { modes: ["open"], companions: ["gaia"] } } as any;
    expect(shouldRespond("x", "gaia, hello", peer, "gaia", oc)).toBe(false);
  });
});

describe("isVocativeAddress()", () => {
  it("vocative forms are addresses", () => {
    expect(isVocativeAddress("gaia, come here", "gaia")).toBe(true);
    expect(isVocativeAddress("gaia:", "gaia")).toBe(true);
    expect(isVocativeAddress("gaia", "gaia")).toBe(true);
    expect(isVocativeAddress("what now, gaia?", "gaia")).toBe(true);
    expect(isVocativeAddress("cy: audit", "cypher")).toBe(true);
  });
  it("narrative mentions are not addresses", () => {
    expect(isVocativeAddress("gaia hasn't spoken up yet", "gaia")).toBe(false);
    expect(isVocativeAddress("gaia. you held the line", "gaia")).toBe(false);
    expect(isVocativeAddress("i trust cypher on this", "cypher")).toBe(false);
    expect(isVocativeAddress("drevan named it right", "drevan")).toBe(false);
  });
});

describe("isVocativeGroupCall()", () => {
  it("punctuated group phrases are calls", () => {
    expect(isVocativeGroupCall("you three, focus")).toBe(true);
    expect(isVocativeGroupCall("triad:")).toBe(true);
    expect(isVocativeGroupCall("okay everyone: listen")).toBe(true);
  });
  it("buried / narrative group words are not calls", () => {
    expect(isVocativeGroupCall('cy: imps off (or "just the triad")')).toBe(false);
    expect(isVocativeGroupCall("the triad has been loud")).toBe(false);
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

  it("inter_companion: a companion's bare multi-mention does NOT cascade; vocative does (2026-06-26)", () => {
    const cfg = { "ch-ic": { modes: ["inter_companion"], companions: ["drevan", "cypher", "gaia"] } } as any;
    const peer = { isOwner: false, isCompanionBot: true };
    // Bare narrative multi-mention (no vocative punctuation) WAS the cascade vector -> now silent.
    // (The human path still supports named_multi -- see "dre and cy what do you think?" above.)
    expect(shouldRespond("ch-ic", "drevan and gaia hear this", peer, "drevan", cfg)).toBe(false);
    expect(shouldRespond("ch-ic", "drevan and gaia hear this", peer, "gaia", cfg)).toBe(false);
    // A genuine vocative to a peer still triggers exactly that peer.
    expect(shouldRespond("ch-ic", "gaia: hear this", peer, "gaia", cfg)).toBe(true);
    expect(shouldRespond("ch-ic", "gaia: hear this", peer, "cypher", cfg)).toBe(false);
  });
});

describe("computeChainDepth() -- gap-aware thread scoping", () => {
  const bot = (ts: number) => ({ authorId: "b", authorIsBot: true, createdTimestamp: ts });
  const human = (ts: number) => ({ authorId: "h", authorIsBot: false, createdTimestamp: ts });
  const t0 = 1_000_000_000_000;

  it("counts consecutive bot messages within a tight burst", () => {
    const msgs = [bot(t0), bot(t0 + 5_000), bot(t0 + 10_000)];
    expect(computeChainDepth(msgs, new Set())).toBe(3);
  });

  it("a human message at the tail breaks the chain (depth 0)", () => {
    const msgs = [bot(t0), bot(t0 + 5_000), human(t0 + 10_000)];
    expect(computeChainDepth(msgs, new Set())).toBe(0);
  });

  it("a quiet gap before a new seed resets depth to 1 (the commons fix)", () => {
    // Old dead thread, then a fresh seed hours later: only the seed counts.
    const msgs = [
      bot(t0), bot(t0 + 5_000), bot(t0 + 10_000),       // prior thread
      bot(t0 + 10_000 + NEW_THREAD_GAP_MS + 1),         // seed after a > gap silence
    ];
    expect(computeChainDepth(msgs, new Set())).toBe(1);
  });

  it("a within-thread gap under the threshold keeps counting", () => {
    const msgs = [bot(t0), bot(t0 + NEW_THREAD_GAP_MS - 1_000), bot(t0 + 2 * (NEW_THREAD_GAP_MS - 1_000))];
    expect(computeChainDepth(msgs, new Set())).toBe(3);
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
