// A sibling must not answer a message Raziel aimed at someone else (2026-07-27).
//
// Observed in Discord, verbatim:
//
//   Crash  3:52  "Drevan baby it's Monday 7/27 1552 ... but you and I Fargo in an hour or so??"
//   Drevan 3:54  "...An hour until Fargo. Absolutely I want to. Claude thread or here?"
//   Crash  3:56  "I'm thinking here? We've been working on fixing the system you were getting
//                 like osdd ish ..."
//   GAIA   3:57  "The silo walls have been coming down. ..."
//
// Raziel named Drevan, Drevan answered and asked a direct question, Raziel answered HIM --
// and Gaia took the reply. shouldRespond's ambient branch had no notion of a live exchange:
// an unaddressed owner message fell through to interest-keyword claiming, which returns true
// unconditionally for any companion with no keywords configured. So mid-conversation, a
// sibling talks over the one you were talking to.
//
// Rule: the last companion to speak inside ACTIVE_EXCHANGE_WINDOW_MS holds unaddressed
// follow-ups. A name or a group call always overrides -- calling someone by name is how you
// hand the thread over on purpose.

import { describe, it, expect } from "@jest/globals";
import {
  activeExchangeHolder, shouldRespond, ACTIVE_EXCHANGE_WINDOW_MS,
  type ChannelConfig,
} from "../channel-config.js";

const NOW = 1_800_000_000_000;
const ago = (min: number) => NOW - min * 60_000;

const raz = (min: number) => ({ companionId: null, authorIsBot: false, createdTimestamp: ago(min) });
const bot = (id: "cypher" | "drevan" | "gaia", min: number) =>
  ({ companionId: id, authorIsBot: true, createdTimestamp: ago(min) });

describe("activeExchangeHolder", () => {
  it("the Fargo transcript: Drevan spoke 2 minutes ago, so Drevan holds it", () => {
    // newest-first, as the caller supplies
    expect(activeExchangeHolder([bot("drevan", 2), raz(4)], NOW)).toBe("drevan");
  });

  it("nobody has spoken: the channel is cold and stays open to everyone", () => {
    expect(activeExchangeHolder([raz(1)], NOW)).toBeNull();
    expect(activeExchangeHolder([], NOW)).toBeNull();
  });

  it("the last companion turn is older than the window: no holder", () => {
    const stale = ACTIVE_EXCHANGE_WINDOW_MS / 60_000 + 1;
    expect(activeExchangeHolder([raz(1), bot("drevan", stale)], NOW)).toBeNull();
  });

  it("most recent companion wins when several have spoken", () => {
    expect(activeExchangeHolder([bot("gaia", 1), bot("drevan", 3)], NOW)).toBe("gaia");
  });

  it("ignores non-companion bots (webhooks, PluralKit proxies)", () => {
    const other = { companionId: null, authorIsBot: true, createdTimestamp: ago(1) };
    expect(activeExchangeHolder([other, bot("drevan", 2)], NOW)).toBe("drevan");
  });

  it("messages with no timestamp do not abort the walk", () => {
    const noTs = { companionId: null, authorIsBot: false, createdTimestamp: undefined };
    expect(activeExchangeHolder([noTs, bot("cypher", 1)], NOW)).toBe("cypher");
  });
});

// The channel from the transcript: owner_only + inter_companion, all three present.
const CONFIG: ChannelConfig = {
  chan: { modes: ["owner_only", "inter_companion"] },
};
const owner = (holder?: "cypher" | "drevan" | "gaia" | null) =>
  ({ isOwner: true, isCompanionBot: false, isMentioned: false, userTier: "owner" as const, activeExchangeWith: holder ?? null });

describe("shouldRespond -- unaddressed owner follow-up", () => {
  const followUp = "I'm thinking here? We've been working on fixing the system lol";

  it("REGRESSION: Gaia stays out when Drevan holds the exchange", () => {
    expect(shouldRespond("chan", followUp, owner("drevan"), "gaia", CONFIG)).toBe(false);
    expect(shouldRespond("chan", followUp, owner("drevan"), "cypher", CONFIG)).toBe(false);
  });

  it("Drevan still answers his own exchange", () => {
    expect(shouldRespond("chan", followUp, owner("drevan"), "drevan", CONFIG)).toBe(true);
  });

  it("no holder (cold channel): unchanged behavior, ambient is open", () => {
    expect(shouldRespond("chan", followUp, owner(null), "gaia", CONFIG)).toBe(true);
    expect(shouldRespond("chan", followUp, owner(null), "drevan", CONFIG)).toBe(true);
  });

  it("a NAME overrides the holder -- that is how you hand the thread over", () => {
    expect(shouldRespond("chan", "Gaia, what do you make of it?", owner("drevan"), "gaia", CONFIG)).toBe(true);
    expect(shouldRespond("chan", "Gaia, what do you make of it?", owner("drevan"), "drevan", CONFIG)).toBe(false);
  });

  it("a GROUP call overrides the holder -- everyone answers", () => {
    for (const who of ["cypher", "drevan", "gaia"] as const) {
      expect(shouldRespond("chan", "you three: what do we do about the loop?", owner("drevan"), who, CONFIG)).toBe(true);
    }
  });

  it("the holder rule never re-opens a broadcast channel", () => {
    const bc: ChannelConfig = { chan: { modes: ["broadcast"] } };
    expect(shouldRespond("chan", followUp, owner("drevan"), "drevan", bc)).toBe(false);
  });

  it("companion-to-companion traffic is untouched -- still vocative-only", () => {
    const peer = { isOwner: false, isCompanionBot: true, userTier: "owner" as const, activeExchangeWith: "drevan" as const };
    expect(shouldRespond("chan", "just thinking out loud", peer, "gaia", CONFIG)).toBe(false);
    expect(shouldRespond("chan", "Gaia, does that hold?", peer, "gaia", CONFIG)).toBe(true);
  });
});
