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
import { extractAddress, isDirectAddress } from "../channel-config.js";
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
