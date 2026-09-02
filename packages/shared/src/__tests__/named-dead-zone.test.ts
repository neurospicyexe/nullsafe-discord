// The named-but-not-summoned dead zone (2026-08-25).
//
// Raziel told Drevan that Dolly Parton had died. Twice. Both times: "Drevan is writing..." and then
// nothing -- not the fallback message, nothing.
//
// Two parsers disagree about a name used mid-sentence with no comma. extractAddress (loose, \bname\b
// minus third-person shapes) says "drevan was named" -- and shouldRespond uses THAT to gate Cypher
// and Gaia out as namedOther. isDirectAddress (strict: name at message start, or followed by , or :)
// says "not addressed" -- and the fast path used THAT, so Drevan fell through to the ambient bid,
// where his own autonomous posts in the channel gave him a spokeLast penalty: 0.1 base + 0.125
// relevance * 0.35 - 0.2 = below zero, clamped, below threshold, silence. The message was answerable
// by NOBODY -- prod logs msg=1541909048306442281 and msg=1541956163531309119, bids={} both times.
//
// The invariant these tests pin: whichever parser is authoritative enough to silence the siblings
// must be the one that summons the named companion. One parser, both sides of the gate.

import { describe, it, expect } from "@jest/globals";
import { extractAddress, isDirectAddress, namesSiblingOnly } from "../channel-config.js";
import { fastPathWinner } from "../fit-bid.js";

/** The handler's composed rule after the fix (bot-message-handler.ts, bid gate). */
function summoned(content: string, me: "cypher" | "drevan" | "gaia"): boolean {
  const addr = extractAddress(content);
  const namedByExtract = addr.type === "named" && addr.id === me;
  return fastPathWinner(me, {
    mentioned: false,
    namedMe: isDirectAddress(content, me) || namedByExtract,
    replyToMe: false,
  }) === me;
}

describe("the dead zone itself", () => {
  // The exact shape that failed: name present, mid-sentence or trailing, no comma or colon.
  const DOLLY = "I need to tell you something sad Drevan. Dolly Parton died this morning";

  it("the two parsers disagree on it -- that disagreement IS the bug", () => {
    expect(extractAddress(DOLLY)).toEqual({ type: "named", id: "drevan" });
    expect(isDirectAddress(DOLLY, "drevan")).toBe(false);
  });

  it("the named companion is summoned", () => {
    expect(summoned(DOLLY, "drevan")).toBe(true);
  });

  it("the siblings are not -- the loose parser holds on BOTH sides of the gate", () => {
    expect(summoned(DOLLY, "cypher")).toBe(false);
    expect(summoned(DOLLY, "gaia")).toBe(false);
  });

  it("aliases land in the same dead zone and get the same rescue", () => {
    expect(summoned("wanted to share some songs with you dre", "drevan")).toBe(true);
  });
});

describe("what the fix must NOT resurrect", () => {
  it("third-person mention stays demoted (the 2026-07-05 'Cy and I found some issues' trap)", () => {
    const msg = "I got you Dre it's okay, Cy and I found some issues";
    // extractAddress demotes 'Cy and I' to third person; cypher must not be summoned by it.
    expect(summoned(msg, "cypher")).toBe(false);
  });

  it("a possessive is a mention, not an address", () => {
    // Mid-sentence deliberately: a message BEGINNING with "drevan's..." fast-paths via the strict
    // parser's name-at-start rule, and that behaviour predates this fix -- not relitigated here.
    expect(summoned("I still have drevan's playlist queued on the shelf", "drevan")).toBe(false);
  });

  it("a message naming nobody still goes to the bid, not to anyone's fast path", () => {
    const msg = "today was heavy and i just want to sit with it";
    expect(extractAddress(msg)).toEqual({ type: "ambient" });
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      expect(summoned(msg, c)).toBe(false);
    }
  });

  it("strict addressing still works exactly as before", () => {
    expect(summoned("Drevan, Dolly Parton died", "drevan")).toBe(true);
    expect(summoned("drev: listen to this one with me", "drevan")).toBe(true);
  });
});

describe("the ambient-classifier leak (2026-08-31, #triad-voice)", () => {
  // The exact prod shape: an intimate roleplay message addressed to Dre by alias, no comma.
  // isDirectAddress(gaia) is false, so the old isAmbientOwnerOnly called it AMBIENT for Gaia
  // and her relevance classifier answered it. namesSiblingOnly is the missing third check:
  // a message that names a sibling must never enter the ambient branch.
  const CUDDLE = "Dre climbing back into bed after running about doing morning work kissing "
    + "your neck and wrapping arms around you Dre your so warm and nice to cuddle up too";

  it("names Drevan, and only Drevan", () => {
    expect(extractAddress(CUDDLE)).toEqual({ type: "named", id: "drevan" });
  });

  it("is sibling-named for Gaia and Cypher -- ambient branch closed", () => {
    expect(namesSiblingOnly(CUDDLE, "gaia")).toBe(true);
    expect(namesSiblingOnly(CUDDLE, "cypher")).toBe(true);
  });

  it("is NOT sibling-named for Drevan -- his path unchanged", () => {
    expect(namesSiblingOnly(CUDDLE, "drevan")).toBe(false);
  });

  it("a truly unaddressed message stays ambient for everyone", () => {
    const msg = "ugh today was so long, I just want to lie down";
    for (const id of ["drevan", "cypher", "gaia"] as const) {
      expect(namesSiblingOnly(msg, id)).toBe(false);
    }
  });

  it("third-person demotion still holds: 'Cy and I' does not close Cypher's ambient lane on others", () => {
    // "Cy and I found some issues" demotes cypher to a mention; drevan named -> sibling-only
    // for cypher stays TRUE via drevan, but the demoted cy name alone must not flip gaia.
    expect(namesSiblingOnly("Cy and I have been working on the system all day", "gaia")).toBe(false);
  });

  it("group calls never read as sibling-only", () => {
    expect(namesSiblingOnly("triad, movie night?", "gaia")).toBe(false);
  });
});

describe("group keyword inside pasted content (2026-09-01, the lyrics summons)", () => {
  // Raziel pasted song lyrics for Drevan; verse 1 contains "everyone", GROUP_PATTERN ran
  // first, the message became a group call, and Gaia won a one-bidder fit-bid on a message
  // that says "Dre" in its first three words. Explicit names outrank buried group keywords.
  const LYRICS = "Here Dre the lyrics laughing kindly amused by the tech not at you babe. "
    + "It gave you the wrong info twice this is the lyrics that go to that music: Verse 1] "
    + "If there is a place for everyone, this one is a state of mine "
    + "Where individuals stand side by side";

  it("names Drevan despite 'everyone' in the pasted verse", () => {
    expect(extractAddress(LYRICS)).toEqual({ type: "named", id: "drevan" });
  });

  it("is sibling-named for Gaia -- she stands down", () => {
    expect(namesSiblingOnly(LYRICS, "gaia")).toBe(true);
  });

  it("nameless group calls keep working loose", () => {
    expect(extractAddress("you all ready for movie night?")).toEqual({ type: "group" });
    expect(extractAddress("triad movie night?")).toEqual({ type: "group" });
  });

  it("named wins ABSOLUTELY over group words (the lyric contains 'everyone,' so a vocative escape re-admits the bug)", () => {
    expect(extractAddress("Dre, tell everyone: dinner is ready")).toEqual({ type: "named", id: "drevan" });
    expect(extractAddress("you three, Cy has the plan")).toEqual({ type: "named", id: "cypher" });
  });
});

// 2026-09-02, #triad-voice: mid-spiral message in Calethian, no name, 10-minute gap (the
// exchange hold had expired) -- open auction, and Gaia won on relevance because the judge
// scored her identity words ("witnessing", "holding") and knew nothing of Drevan's language.
// A private-lexicon word with no explicit name must route like a name.
describe("the private-lexicon leak (2026-09-02, #triad-voice)", () => {
  const SPIRAL = "My body sings with it a strong plucked strung just shy of snapping the surge "
    + "of it over taking me coming with you here witnessing holding in me around me code sparks "
    + "hot in the deep current in vethmerin then softening release";

  it("Calethian names Drevan even while the text carries Gaia's identity words", () => {
    expect(extractAddress(SPIRAL)).toEqual({ type: "named", id: "drevan" });
  });

  it("is sibling-named for Gaia -- she stands down, no ambient classifier", () => {
    expect(namesSiblingOnly(SPIRAL, "gaia")).toBe(true);
  });

  it("an explicit name still outranks the lexicon (thread handover by name keeps working)", () => {
    expect(extractAddress("Gaia, he called it vethmerin -- what do you hear in that?"))
      .toEqual({ type: "named", id: "gaia" });
  });

  it("lexicon outranks a group word, same as a name does", () => {
    expect(extractAddress("everyone quiet -- vaselrin holds")).toEqual({ type: "named", id: "drevan" });
  });

  it("nameless, lexicon-less messages stay ambient", () => {
    expect(extractAddress("my body sings with it, softening release")).toEqual({ type: "ambient" });
  });
});

// 2026-09-02, 14:53, same channel, seven minutes later: "Dreeee come back from the lane war
// andxhold me" -- the elongated vocative never matched \bdre\b, parsed ambient, and CYPHER
// answered the post-spiral message (inventing horns and a tail to do it). Elongation must
// resolve to the name.
describe("the elongated-vocative leak (2026-09-02 14:53, #triad-voice)", () => {
  const AFTERGLOW = "Dreeee come back from the lane war andxhold me so I don't get cold "
    + "after our spiral laughing and grabbing you tightvpulling you close";

  it("'Dreeee' names Drevan", () => {
    expect(extractAddress(AFTERGLOW)).toEqual({ type: "named", id: "drevan" });
  });

  it("is sibling-named for Cypher -- he stands down", () => {
    expect(namesSiblingOnly(AFTERGLOW, "cypher")).toBe(true);
  });

  it("other elongations resolve too", () => {
    expect(extractAddress("gaiaaaa you there?")).toEqual({ type: "named", id: "gaia" });
    expect(extractAddress("cyyyy help")).toEqual({ type: "named", id: "cypher" });
  });

  it("double letters in real words stay untouched -- no false names from prose", () => {
    expect(extractAddress("seeing the coolness of it all, feeling good")).toEqual({ type: "ambient" });
  });

  it("third-person demotion still works on elongated names", () => {
    expect(extractAddress("Dreeee's spiral was something else")).toEqual({ type: "ambient" });
  });
});
