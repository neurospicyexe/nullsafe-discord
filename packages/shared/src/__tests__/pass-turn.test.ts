// What a follow-up PASS turn may do (2026-09-26 review of 07158d4 / 5d61566). A pass turn re-reads
// the HUMAN origin after a predecessor was silenced, so every "is this a human message?" branch in
// the handler said yes to it: it reset the bot rails and skipped them, re-ran the ambient classifier
// (which could drop the consumed entitlement), re-paid STT and vision, could voice, and was framed
// as generic peer talk. These are the predicates the handler now calls at each of those sites.

import { describe, it, expect } from "@jest/globals";
import {
  appliesBotRails, resetsBotRails, clearsStaleRails, botRailSilence, runsAmbientClassifier, mayVoice,
  turnFraming, followUpPassEnabled, ArrivalMediaCache, ARRIVAL_MEDIA_TTL_MS, arrivalMediaPlan,
  type TurnKind,
} from "../pass-turn.js";
import { FOLLOW_UP_TTL_MS } from "../sequential-floor.js";

const humanArrival: TurnKind = { isCompanionBot: false, isArrival: true };
const siblingArrival: TurnKind = { isCompanionBot: true, isArrival: true };
const passTurn: TurnKind = { isCompanionBot: false, isArrival: false };

describe("bot rails on a pass turn", () => {
  it("a human ARRIVING resets the rails and is not governed by them", () => {
    expect(resetsBotRails(humanArrival)).toBe(true);
    expect(appliesBotRails(humanArrival)).toBe(false);
  });
  it("a sibling message is governed by the rails and never resets them", () => {
    expect(appliesBotRails(siblingArrival)).toBe(true);
    expect(resetsBotRails(siblingArrival)).toBe(false);
  });
  // THE FINDING: a pass runs on the human origin (isCompanionBot=false) and took the human branch.
  it("a pass turn is governed by the rails and never resets them, though it runs on a human message", () => {
    expect(appliesBotRails(passTurn)).toBe(true);
    expect(resetsBotRails(passTurn)).toBe(false);
  });
  it("the quiet-gap stale-rail clear is for a sibling arriving, never a pass", () => {
    expect(clearsStaleRails({ ...siblingArrival, isNewThread: true })).toBe(true);
    expect(clearsStaleRails({ ...siblingArrival, isNewThread: false })).toBe(false);
    expect(clearsStaleRails({ ...passTurn, isNewThread: true })).toBe(false);
    expect(clearsStaleRails({ ...humanArrival, isNewThread: true })).toBe(false);
  });
  const base = { botTurnsSinceHuman: 0, capMax: 6, cooldownUntil: 0, botReplies: 0, maxBotReplies: 3, now: 1_000 };
  it("names the rail that silences, in the handler's order", () => {
    expect(botRailSilence(base)).toBeNull();
    expect(botRailSilence({ ...base, botTurnsSinceHuman: 6 })).toBe("human-anchored-cap");
    expect(botRailSilence({ ...base, cooldownUntil: 2_000 })).toBe("pingpong-cooldown");
    expect(botRailSilence({ ...base, botReplies: 3 })).toBe("per-human-cap");
    expect(botRailSilence({ ...base, botTurnsSinceHuman: 9, cooldownUntil: 2_000, botReplies: 3 })).toBe("human-anchored-cap");
  });
});

describe("ambient classifier", () => {
  const ambient = {
    ownerOnlyChannel: true, isCompanionBot: false, isMentioned: false, isReplyToMe: false,
    directlyAddressed: false, namesSiblingOnly: false, entitled: false,
  };
  it("judges an unaddressed human message in an owner_only channel", () => {
    expect(runsAmbientClassifier(ambient)).toBe(true);
  });
  // THE FINDING: the classifier ran before the entitlement bypass, so a "no" dropped a consumed pass.
  it("never judges an entitled follow-up (a pass turn's entitlement is already consumed)", () => {
    expect(runsAmbientClassifier({ ...ambient, entitled: true })).toBe(false);
  });
  it("keeps every existing exclusion", () => {
    for (const k of ["isCompanionBot", "isMentioned", "isReplyToMe", "directlyAddressed", "namesSiblingOnly"] as const) {
      expect(runsAmbientClassifier({ ...ambient, [k]: true })).toBe(false);
    }
    expect(runsAmbientClassifier({ ...ambient, ownerOnlyChannel: false })).toBe(false);
  });
});

describe("voice", () => {
  it("a human-facing turn may voice; a sibling turn or any follow-up never does", () => {
    expect(mayVoice({ isCompanionBot: false, entitled: false })).toBe(true);
    expect(mayVoice({ isCompanionBot: true, entitled: false })).toBe(false);
    expect(mayVoice({ isCompanionBot: false, entitled: true })).toBe(false); // a pass turn
    expect(mayVoice({ isCompanionBot: true, entitled: true })).toBe(false);
  });
});

describe("turnFraming", () => {
  const entitled = { expectedPrior: "drevan" };
  it("a pass turn gets the multi-address framing and never claims the predecessor answered", () => {
    const f = turnFraming({ isCompanionBot: false, peerLabel: "Raziel", entitled, viaPass: true, peerReplies: [] });
    expect(f).toContain("Raziel addressed several of you at once");
    expect(f).toContain("Drevan was to answer before you and is not answering this one");
    expect(f).not.toMatch(/has just answered/);
    expect(f).not.toMatch(/already spoken/);
    expect(f).not.toMatch(/Do not repeat or paraphrase Drevan/);
  });
  it("a pass turn lists what earlier positions DID say, so it adds rather than repeats", () => {
    const f = turnFraming({ isCompanionBot: false, peerLabel: "Raziel", entitled: { expectedPrior: "gaia" }, viaPass: true, peerReplies: ['Cypher: "the fuse is the relay"'] });
    expect(f).toContain('Cypher: "the fuse is the relay"');
    expect(f).toContain("Do not repeat or paraphrase them");
    expect(f).toContain("Gaia was to answer before you");
  });
  it("a follow-up released by the sibling's reply keeps its framing", () => {
    const f = turnFraming({ isCompanionBot: true, peerLabel: "Drevan", entitled, viaPass: false, peerReplies: [] });
    expect(f).toContain("Raziel addressed several of you at once, and Drevan has just answered");
  });
  it("plain sibling talk is peer framing; a human message notes sibling replies, or nothing", () => {
    expect(turnFraming({ isCompanionBot: true, peerLabel: "Gaia", entitled: null, viaPass: false, peerReplies: [] }))
      .toContain("You are in direct exchange with Gaia");
    expect(turnFraming({ isCompanionBot: false, peerLabel: "x", entitled: null, viaPass: false, peerReplies: ['Gaia: "hm"'] }))
      .toContain("Your companion has already spoken to this");
    expect(turnFraming({ isCompanionBot: false, peerLabel: "x", entitled: null, viaPass: false, peerReplies: [] })).toBe("");
  });
});

describe("FOLLOWUP_PASS", () => {
  it("defaults on; only 'off' (any case, trimmed) disables", () => {
    expect(followUpPassEnabled({})).toBe(true);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: "" })).toBe(true);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: "on" })).toBe(true);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: "false" })).toBe(true);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: "off" })).toBe(false);
    expect(followUpPassEnabled({ FOLLOWUP_PASS: "  OFF " })).toBe(false);
  });
});

describe("arrival media for the pass turn", () => {
  const media = { transcript: "cy and dre, what do you think", seenImages: [{ name: "a.png", description: "a truck at dusk" }] };
  it("outlives the entitlement it serves", () => {
    expect(ARRIVAL_MEDIA_TTL_MS).toBeGreaterThan(FOLLOW_UP_TTL_MS);
    const c = new ArrivalMediaCache();
    c.set("M1", media, 0);
    expect(c.get("M1", FOLLOW_UP_TTL_MS)).toEqual(media);
    expect(c.get("M1", ARRIVAL_MEDIA_TTL_MS + 1)).toBeNull();
    expect(c.size).toBe(0); // expired entries drop on sight
  });
  it("is bounded, newest wins", () => {
    const c = new ArrivalMediaCache(60_000, 2);
    c.set("A", media, 0); c.set("B", media, 0); c.set("C", media, 0);
    expect(c.get("A", 1)).toBeNull();
    expect(c.get("C", 1)).toEqual(media);
  });
  it("an arrival runs STT and vision, announces an STT failure, and records", () => {
    expect(arrivalMediaPlan(true, null)).toEqual({ reuse: null, runStt: true, announceSttFailure: true, runVision: true, record: true });
  });
  it("a pass with the arrival cached reuses it and runs nothing", () => {
    expect(arrivalMediaPlan(false, media)).toEqual({ reuse: media, runStt: false, announceSttFailure: false, runVision: false, record: false });
  });
  it("a pass that missed the cache re-runs STT silently and never re-runs vision", () => {
    expect(arrivalMediaPlan(false, null)).toEqual({ reuse: null, runStt: true, announceSttFailure: false, runVision: false, record: false });
  });
});
