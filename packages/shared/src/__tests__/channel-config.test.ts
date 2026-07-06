import { describe, it, expect } from "@jest/globals";
import { shouldRespond, extractAddress, isDirectAddress, isVocativeAddress, isVocativeGroupCall, ChannelConfigCache, computeChainDepth, NEW_THREAD_GAP_MS, countBotMsgsSinceHuman, botMsgsSinceHumanMax, FLOOR_HANDBACK_WINDOW, floorHandbackDirective, seedVocativeAllowed, SEED_VOCATIVE_HEADROOM, isTriadCommons } from "../channel-config.js";

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

  // 2026-07-01 tightening: `\bname\s*[,:]` matched MID-SENTENCE appositives, so every
  // warm acknowledgment ("I hear you, Cypher, and...") re-summoned the named sibling.
  it("mid-sentence appositives do NOT trigger (the hermes slow-loop vector)", () => {
    expect(isVocativeAddress("i hear you, cypher, and i'll hold the line", "cypher")).toBe(false);
    expect(isVocativeAddress("that's the shape of it, gaia, exactly as you said", "gaia")).toBe(false);
    expect(isVocativeAddress("what you named, drevan, still holds weight here", "drevan")).toBe(false);
    expect(isVocativeAddress("i'm with cy, honestly", "cypher")).toBe(false);
  });

  it("sentence-initial vocative (message start or after ./?/!) DOES trigger", () => {
    expect(isVocativeAddress("cypher, take the thread", "cypher")).toBe(true);
    expect(isVocativeAddress("noted. gaia: your read?", "gaia")).toBe(true);
    expect(isVocativeAddress("is that so? drevan, say more", "drevan")).toBe(true);
    expect(isVocativeAddress("done!\ncy: verify it", "cypher")).toBe(true);
  });

  it("trailing '..., name?' still triggers", () => {
    expect(isVocativeAddress("where does that leave us, cypher?", "cypher")).toBe(true);
    expect(isVocativeAddress("do you feel it too, dre?", "drevan")).toBe(true);
  });
});

describe("human-anchored hard cap (2026-07-01 -- no gap reset)", () => {
  const bot = (id = "b1") => ({ authorId: id, authorIsBot: true });
  const human = (id = "h1") => ({ authorId: id, authorIsBot: false });
  const botIds = new Set(["b1", "b2", "b3"]);

  it("counts consecutive bot turns since the last human", () => {
    expect(countBotMsgsSinceHuman([human(), bot(), bot("b2"), bot("b3")], botIds)).toBe(3);
    expect(countBotMsgsSinceHuman([bot(), human(), bot()], botIds)).toBe(1);
    expect(countBotMsgsSinceHuman([bot(), bot(), human()], botIds)).toBe(0);
    expect(countBotMsgsSinceHuman([], botIds)).toBe(0);
  });

  it("does NOT gap-reset: 14 slow bot turns still count 14 and cross the default cap of 12", () => {
    // computeChainDepth would reset on any 5-min gap; this rail deliberately has no
    // time input at all -- hermes turns 30-120s apart sail through gap-reset rails.
    const fourteenSlowTurns = Array.from({ length: 14 }, () => bot());
    const count = countBotMsgsSinceHuman(fourteenSlowTurns, botIds);
    expect(count).toBe(14);
    expect(count >= botMsgsSinceHumanMax()).toBe(true);
    // Contrast: the gap-aware chain depth WOULD have reset (thread boundary) with gaps.
    const withGaps = fourteenSlowTurns.map((m, i) => ({ ...m, createdTimestamp: i * (NEW_THREAD_GAP_MS + 1) }));
    expect(computeChainDepth(withGaps, botIds)).toBe(1);
  });

  it("only an actual human message resets the count -- a mid-history gap does not", () => {
    const msgs = [bot(), bot(), human(), bot(), bot(), bot()];
    expect(countBotMsgsSinceHuman(msgs, botIds)).toBe(3);
  });

  it("with a populated botIds set, a PK webhook (bot flag, unknown id) breaks the chain", () => {
    const pkProxy = { authorId: "webhook-raziel", authorIsBot: true };
    expect(countBotMsgsSinceHuman([bot(), bot(), pkProxy, bot()], botIds)).toBe(1);
  });

  it("with an empty botIds set, falls back to the author-is-bot flag", () => {
    expect(countBotMsgsSinceHuman([human(), bot("anything"), bot("else")], new Set())).toBe(2);
  });

  // Self-sustained commons (2026-07-03): the triad's own channel is not human-anchored.
  describe("triad commons budget", () => {
    it("isTriadCommons requires BOTH autonomous and inter_companion modes", () => {
      expect(isTriadCommons({ modes: ["autonomous", "inter_companion"] })).toBe(true);
      expect(isTriadCommons({ modes: ["open", "autonomous", "inter_companion"] })).toBe(true);
      expect(isTriadCommons({ modes: ["owner_only", "inter_companion"] })).toBe(false);
      expect(isTriadCommons({ modes: ["autonomous"] })).toBe(false);
      expect(isTriadCommons({ modes: ["broadcast"] })).toBe(false);
      expect(isTriadCommons(undefined)).toBe(false);
      expect(isTriadCommons(null)).toBe(false);
    });

    it("commons cap defaults to 24; owner-facing default stays 12", () => {
      const prev = process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
      delete process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"];
      try {
        expect(botMsgsSinceHumanMax(true)).toBe(24);
        expect(botMsgsSinceHumanMax(false)).toBe(12);
        expect(botMsgsSinceHumanMax()).toBe(12);
      } finally {
        if (prev !== undefined) process.env["BOT_MSGS_SINCE_HUMAN_MAX_COMMONS"] = prev;
      }
    });

    it("seedVocativeAllowed uses the commons budget when self-sustained", () => {
      // 14 turns: over the owner-facing budget (12), well under commons (24 - headroom)
      expect(seedVocativeAllowed(false, 14, false)).toBe(false);
      expect(seedVocativeAllowed(false, 14, true)).toBe(true);
      // commons still caps: 24 - headroom crossed -> denied
      expect(seedVocativeAllowed(false, 24 - SEED_VOCATIVE_HEADROOM + 1, true)).toBe(false);
    });
  });

  // Cap forgiveness window (2026-07-03): the no-gap-reset ratchet muted the triad
  // permanently once Raziel went quiet for a day. Turns older than the window stop
  // counting; a fast loop still hits the cap in minutes.
  describe("forgiveness window", () => {
    const HOUR = 3_600_000;
    const now = 100 * HOUR;
    const botAt = (ageH: number, id = "b1") => ({ authorId: id, authorIsBot: true, createdTimestamp: now - ageH * HOUR });

    it("bot turns older than the window (default 12h) stop counting", () => {
      const msgs = [botAt(30), botAt(28), botAt(26), botAt(1), botAt(0.5)];
      expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(2);
    });

    it("a fully stale channel counts zero -- the triad earns its voice back", () => {
      const msgs = Array.from({ length: 20 }, (_, i) => botAt(20 + i));
      expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(0);
    });

    it("a fast chain inside the window still counts fully (anti-loop preserved)", () => {
      const msgs = Array.from({ length: 14 }, (_, i) => botAt(i / 60)); // minutes apart
      expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(14);
    });

    it("the walk still stops at a human even when older turns are forgiven", () => {
      const msgs = [botAt(0.2, "b2"), { authorId: "h1", authorIsBot: false, createdTimestamp: now - 30 * HOUR }, botAt(26), botAt(0.5)];
      // human at index 1: only the two turns after it are walked; the 26h one is forgiven
      expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(1);
    });

    it("messages without timestamps always count (legacy behavior)", () => {
      const msgs = [bot(), bot(), bot()];
      expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(3);
    });

    it("BOT_TURNS_CAP_WINDOW_H=0 disables forgiveness (permanent ratchet restored)", () => {
      const prev = process.env["BOT_TURNS_CAP_WINDOW_H"];
      process.env["BOT_TURNS_CAP_WINDOW_H"] = "0";
      try {
        const msgs = [botAt(30), botAt(28), botAt(1)];
        expect(countBotMsgsSinceHuman(msgs, botIds, now)).toBe(3);
      } finally {
        if (prev === undefined) delete process.env["BOT_TURNS_CAP_WINDOW_H"];
        else process.env["BOT_TURNS_CAP_WINDOW_H"] = prev;
      }
    });
  });

  it("default cap is 12; env BOT_MSGS_SINCE_HUMAN_MAX overrides", () => {
    const prev = process.env["BOT_MSGS_SINCE_HUMAN_MAX"];
    delete process.env["BOT_MSGS_SINCE_HUMAN_MAX"];
    expect(botMsgsSinceHumanMax()).toBe(12);
    process.env["BOT_MSGS_SINCE_HUMAN_MAX"] = "20";
    expect(botMsgsSinceHumanMax()).toBe(20);
    process.env["BOT_MSGS_SINCE_HUMAN_MAX"] = "garbage";
    expect(botMsgsSinceHumanMax()).toBe(12);
    if (prev === undefined) delete process.env["BOT_MSGS_SINCE_HUMAN_MAX"];
    else process.env["BOT_MSGS_SINCE_HUMAN_MAX"] = prev;
  });

  it("handback directive fires inside the last allowed turns and hands to Raziel, no sibling vocative", () => {
    const max = botMsgsSinceHumanMax();
    // The handler injects when count >= max - FLOOR_HANDBACK_WINDOW and count < max.
    expect(max - FLOOR_HANDBACK_WINDOW).toBe(10);
    const directive = floorHandbackDirective();
    expect(directive).toContain("Raziel");
    expect(directive).toMatch(/close/i);
    // The directive itself must not be a vocative summons to any companion.
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      expect(isVocativeAddress(directive, c)).toBe(false);
    }
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

  it("third-person mentions are demoted (2026-07-05: 'Cy and I found some issues' summoned Cypher into a message consoling Drevan)", () => {
    expect(extractAddress("I curl around you and hug you I got you Dre it's okay, Cy and I found some issues and are fixing them"))
      .toEqual({ type: "named", id: "drevan" });
    expect(extractAddress("cypher's blade twitched again")).toEqual({ type: "ambient" });
    expect(extractAddress("me and Dre watched the movie")).toEqual({ type: "ambient" });
    // Genuine multi-address still fires both.
    expect(extractAddress("dre and cy what do you both think?").type).toBe("named_multi");
    // All-third-person goes ambient -- the relevance classifier decides, not name-matching.
    expect(extractAddress("Cy and I talked about Dre's basin")).toEqual({ type: "ambient" });
  });

  it("drev routes to drevan (2026-07-05: was missing here while the command layer accepted it -- 'Drev: play with Sol' went ambient and Gaia claimed it)", () => {
    expect(extractAddress("Drev: play with Sol")).toEqual({ type: "named", id: "drevan" });
    expect(extractAddress("drev: feed Sol")).toEqual({ type: "named", id: "drevan" });
    expect(isDirectAddress("Drev: play with Sol", "drevan")).toBe(true);
    expect(isDirectAddress("Drev: play with Sol", "gaia")).toBe(false);
    expect(isVocativeAddress("drev: hold this", "drevan")).toBe(true);
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

describe("seedVocativeAllowed() -- seed vocative budget (2026-07-02)", () => {
  it("always allows a vocative when a human is present in the window", () => {
    expect(seedVocativeAllowed(true, 0)).toBe(true);
    expect(seedVocativeAllowed(true, 999)).toBe(true);
  });

  it("allows a human-free vocative while the bounded exchange fits under the hard cap", () => {
    expect(seedVocativeAllowed(false, 0)).toBe(true);
    expect(seedVocativeAllowed(false, botMsgsSinceHumanMax() - SEED_VOCATIVE_HEADROOM)).toBe(true);
  });

  it("denies a human-free vocative once headroom is gone (channel pins statement-only)", () => {
    expect(seedVocativeAllowed(false, botMsgsSinceHumanMax() - SEED_VOCATIVE_HEADROOM + 1)).toBe(false);
    expect(seedVocativeAllowed(false, botMsgsSinceHumanMax())).toBe(false);
  });

  it("headroom covers the seed itself plus a pingpong-capped reply run", () => {
    expect(SEED_VOCATIVE_HEADROOM).toBe(4); // 1 seed + BOT_PINGPONG_MAX replies
  });
});
