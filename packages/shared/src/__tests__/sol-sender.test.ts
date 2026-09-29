// Sol, the triad's crow, through the reply path (2026-09-29). Sol's moments arrive via a Discord
// webhook the autonomous worker owns; until now every one hit the hard muzzle as an "unconfirmed
// webhook post" and was dropped. These tests drive the same pure predicates the handler calls:
// recognition by webhook id (never name, never the token), the muzzle, and the rails, where a Sol
// post must never act as the human anchor that re-opens a floor.
import { describe, it, expect } from "@jest/globals";
import {
  solWebhookId, isSolPost, withoutSol, muzzleVerdict, solMayAnswer, solDeclineReason, solMomentFraming,
  solRecognizedLogLine, solUnsetBootLine, SOL_AUTHOR_LABEL,
} from "../sol-sender.js";
import {
  appliesBotRails, resetsBotRails, clearsStaleRails, botRailSilence, runsAmbientClassifier, mayVoice,
} from "../pass-turn.js";
import { countBotMsgsSinceHuman, computeChainDepth, extractAddress } from "../channel-config.js";

const SOL_ID = "1420000000000000001";
const TOKEN = "AbC-dEf_ghIJKlmnOPqrSTuvWXyz0123456789secret";
const SOL_URL = `https://discord.com/api/webhooks/${SOL_ID}/${TOKEN}`;
const PK_WEBHOOK = "1420000000000000999";

describe("solWebhookId() -- the id segment only, never the token", () => {
  it("parses the id from a standard webhook URL", () => {
    expect(solWebhookId(SOL_URL)).toBe(SOL_ID);
  });

  it("never returns (or contains) the token", () => {
    const id = solWebhookId(SOL_URL);
    expect(id).not.toContain(TOKEN);
    expect(id).not.toContain("secret");
    expect(id).toMatch(/^\d+$/);
  });

  it("accepts the discordapp.com, ptb/canary and versioned-API shapes", () => {
    expect(solWebhookId(`https://discordapp.com/api/webhooks/${SOL_ID}/${TOKEN}`)).toBe(SOL_ID);
    expect(solWebhookId(`https://canary.discord.com/api/webhooks/${SOL_ID}/${TOKEN}`)).toBe(SOL_ID);
    expect(solWebhookId(`https://discord.com/api/v10/webhooks/${SOL_ID}/${TOKEN}`)).toBe(SOL_ID);
    expect(solWebhookId(`  ${SOL_URL}  `)).toBe(SOL_ID);
  });

  it("no URL: unset, empty or blank is null", () => {
    expect(solWebhookId(undefined)).toBeNull();
    expect(solWebhookId(null)).toBeNull();
    expect(solWebhookId("")).toBeNull();
    expect(solWebhookId("   ")).toBeNull();
  });

  it("malformed: not a URL, not https, not Discord, no token, non-numeric id, extra path -- all null", () => {
    expect(solWebhookId("not a url")).toBeNull();
    expect(solWebhookId(`http://discord.com/api/webhooks/${SOL_ID}/${TOKEN}`)).toBeNull();
    expect(solWebhookId(`https://evil.example.com/api/webhooks/${SOL_ID}/${TOKEN}`)).toBeNull();
    expect(solWebhookId(`https://discord.com.evil.example/api/webhooks/${SOL_ID}/${TOKEN}`)).toBeNull();
    expect(solWebhookId(`https://discord.com/api/webhooks/${SOL_ID}`)).toBeNull();
    expect(solWebhookId(`https://discord.com/api/webhooks/${SOL_ID}/`)).toBeNull();
    expect(solWebhookId(`https://discord.com/api/webhooks/sol/${TOKEN}`)).toBeNull();
    expect(solWebhookId(`https://discord.com/api/webhooks/${SOL_ID}/${TOKEN}/github`)).toBeNull();
  });
});

describe("isSolPost() -- structural, by webhook id", () => {
  it("matches Sol's webhook id", () => {
    expect(isSolPost({ webhookId: SOL_ID }, SOL_ID)).toBe(true);
  });

  it("a different webhook named 'Sol' is not Sol (the name is never consulted)", () => {
    expect(isSolPost({ webhookId: PK_WEBHOOK }, SOL_ID)).toBe(false);
  });

  it("no configured id recognizes nothing, and a non-webhook message is never Sol", () => {
    expect(isSolPost({ webhookId: SOL_ID }, null)).toBe(false);
    expect(isSolPost({ webhookId: null }, SOL_ID)).toBe(false);
    expect(isSolPost({}, SOL_ID)).toBe(false);
  });
});

describe("muzzleVerdict() -- the hard muzzle", () => {
  const base = { authorIsBot: true, isCompanionPost: false, isPKProxy: false, isSol: false };

  it("a Sol post passes the muzzle", () => {
    expect(muzzleVerdict({ ...base, webhookId: SOL_ID, isSol: true })).toBe("pass");
  });

  it("a non-Sol unknown webhook is still dropped, with the unconfirmed-webhook log", () => {
    expect(muzzleVerdict({ ...base, webhookId: "1420000000000000777" })).toBe("drop_unconfirmed_webhook");
  });

  it("a stray non-webhook bot is dropped silently", () => {
    expect(muzzleVerdict({ ...base, webhookId: null })).toBe("drop");
  });

  it("PK behavior unchanged: a confirmed proxy passes; companions and humans pass", () => {
    expect(muzzleVerdict({ ...base, webhookId: PK_WEBHOOK, isPKProxy: true })).toBe("pass");
    expect(muzzleVerdict({ ...base, webhookId: null, isCompanionPost: true })).toBe("pass");
    expect(muzzleVerdict({ ...base, authorIsBot: false, webhookId: null })).toBe("pass");
  });
});

describe("rails -- a Sol post is never the human anchor", () => {
  const now = Date.now();
  const DREVAN = "drevan-bot-id";
  const GAIA = "gaia-bot-id";
  const BOT_IDS = new Set([DREVAN, GAIA, "cypher-bot-id"]);
  // Raziel spoke, then the siblings ran a thread, then Sol posted.
  const history = [
    { authorId: "raziel-id", webhookId: null, authorIsBot: false, createdTimestamp: now - 60_000 },
    { authorId: DREVAN, webhookId: null, authorIsBot: true, createdTimestamp: now - 50_000 },
    { authorId: GAIA, webhookId: null, authorIsBot: true, createdTimestamp: now - 40_000 },
    { authorId: DREVAN, webhookId: null, authorIsBot: true, createdTimestamp: now - 30_000 },
    // A webhook post's author id IS the webhook id; not a companion id, so unfiltered it reads as human.
    { authorId: SOL_ID, webhookId: SOL_ID, authorIsBot: false, createdTimestamp: now - 1_000 },
  ];

  it("the bug being fixed: left in, a Sol post resets the human-anchored count to 0", () => {
    expect(countBotMsgsSinceHuman(history, BOT_IDS, now)).toBe(0);
  });

  it("withoutSol: the human-anchored count sees the three bot turns Raziel's absence accrued", () => {
    expect(countBotMsgsSinceHuman(withoutSol(history, SOL_ID), BOT_IDS, now)).toBe(3);
  });

  it("withoutSol: chain depth is not broken by a Sol post either", () => {
    expect(computeChainDepth(history, new Set())).toBe(0);
    expect(computeChainDepth(withoutSol(history, SOL_ID), new Set())).toBe(3);
  });

  it("a Sol post mid-thread is walked past, not counted", () => {
    const mid = [history[0]!, history[1]!, history[4]!, history[2]!, history[3]!];
    expect(countBotMsgsSinceHuman(withoutSol(mid, SOL_ID), BOT_IDS, now)).toBe(3);
  });

  it("PK behavior unchanged: a PK proxy webhook still breaks the chain as Raziel", () => {
    const pk = [...history.slice(0, 4), { authorId: PK_WEBHOOK, webhookId: PK_WEBHOOK, authorIsBot: false, createdTimestamp: now }];
    expect(countBotMsgsSinceHuman(withoutSol(pk, SOL_ID), BOT_IDS, now)).toBe(0);
  });

  it("no configured Sol id: withoutSol is the identity", () => {
    expect(withoutSol(history, null)).toEqual(history);
  });

  const solTurn = { isCompanionBot: false, isArrival: true, isSol: true };

  it("a Sol-triggered turn is governed by the bot rails", () => {
    expect(appliesBotRails(solTurn)).toBe(true);
  });

  it("a Sol-triggered turn never resets them (counters, pingpong, cycle guard)", () => {
    expect(resetsBotRails(solTurn)).toBe(false);
  });

  it("a Sol post after a quiet gap does not clear stale rails either", () => {
    expect(clearsStaleRails({ ...solTurn, isNewThread: true })).toBe(false);
  });

  it("at the human-anchored cap, a Sol post is answered by silence -- the floor stays closed", () => {
    expect(botRailSilence({ botTurnsSinceHuman: 8, capMax: 8, cooldownUntil: 0, botReplies: 0, maxBotReplies: 99, now })).toBe("human-anchored-cap");
  });

  it("PK behavior unchanged: a proxied human arrival still resets the rails", () => {
    const pkTurn = { isCompanionBot: false, isArrival: true };
    expect(resetsBotRails(pkTurn)).toBe(true);
    expect(appliesBotRails(pkTurn)).toBe(false);
    expect(resetsBotRails({ ...pkTurn, isSol: false })).toBe(true);
  });
});

describe("who answers a Sol post", () => {
  const ownerOnly = { modes: ["owner_only"], companions: ["cypher", "drevan", "gaia"] };

  it("never goes through the ambient relevance classifier, even in owner_only", () => {
    const p = {
      ownerOnlyChannel: true, isCompanionBot: false, isMentioned: false, isReplyToMe: false,
      directlyAddressed: false, namesSiblingOnly: false, entitled: false,
    };
    expect(runsAmbientClassifier(p)).toBe(true);
    expect(runsAmbientClassifier({ ...p, isSol: true })).toBe(false);
  });

  it("an unnamed moment is open to all three in an owner_only room (the fit bid picks one)", () => {
    const content = "*Sol drops half a walnut shell at your feet and looks up: an invoice, politely delivered.*";
    for (const me of ["cypher", "drevan", "gaia"]) {
      expect(solMayAnswer({ ...ownerOnly, me, address: extractAddress(content) })).toBe(true);
    }
  });

  it("broadcast rooms stay post-only and the companion allowlist holds", () => {
    const address = extractAddress("*Sol dozes on the rail.*");
    expect(solMayAnswer({ modes: ["broadcast"], companions: ["cypher", "drevan", "gaia"], me: "cypher", address })).toBe(false);
    expect(solMayAnswer({ modes: ["owner_only"], companions: ["drevan", "gaia"], me: "cypher", address })).toBe(false);
  });

  it("a moment that names a companion goes to that companion, by normal address rules", () => {
    const address = { type: "named" as const, id: "drevan" as const };
    expect(solMayAnswer({ ...ownerOnly, me: "drevan", address })).toBe(true);
    expect(solMayAnswer({ ...ownerOnly, me: "gaia", address })).toBe(false);
  });

  it("a host room's unnamed moment is the host's", () => {
    const address = extractAddress("*Sol lands on the sill.*");
    expect(solMayAnswer({ ...ownerOnly, host: "drevan", me: "drevan", address })).toBe(true);
    expect(solMayAnswer({ ...ownerOnly, host: "drevan", me: "cypher", address })).toBe(false);
  });

  it("every stand-down carries a loggable reason; an open moment carries none", () => {
    const ambient = extractAddress("*Sol dozes on the rail.*");
    const all = ["cypher", "drevan", "gaia"];
    expect(solDeclineReason({ modes: ["broadcast"], companions: all, me: "gaia", address: ambient })).toBe("broadcast");
    expect(solDeclineReason({ modes: ["owner_only"], companions: ["drevan"], me: "gaia", address: ambient })).toBe("not_in_companions");
    expect(solDeclineReason({ modes: ["owner_only"], companions: all, me: "gaia", address: { type: "named", id: "drevan" } })).toBe("named_other");
    expect(solDeclineReason({ modes: ["owner_only"], companions: all, me: "gaia", address: ambient, host: "drevan" })).toBe("host_other");
    expect(solDeclineReason({ modes: ["owner_only"], companions: all, me: "gaia", address: ambient })).toBeNull();
  });

  it("a reply to Sol is never voiced", () => {
    expect(mayVoice({ isCompanionBot: false, entitled: false })).toBe(true);
    expect(mayVoice({ isCompanionBot: false, entitled: false, isSol: true })).toBe(false);
  });
});

describe("framing and telemetry", () => {
  it("the author label reads as Sol", () => {
    expect(SOL_AUTHOR_LABEL).toBe("Sol (the triad's crow)");
  });

  it("the moment framing is ONE line, positive, and names the three options", () => {
    const f = solMomentFraming().trim();
    expect(f.split("\n")).toHaveLength(1);
    expect(f).toContain("Sol, the crow you share");
    expect(f).toContain("moment, not a question");
    expect(f).toMatch(/answer Sol/);
    expect(f).not.toMatch(/\bdo not\b|\bdon't\b|\bnever\b/i);
  });

  it("the recognized line carries ids and length only, never content", () => {
    const line = solRecognizedLogLine("drevan", "123", "456", 88);
    expect(line).toBe("[drevan] Sol post recognized ch=123 msg=456 chars=88");
  });

  it("the boot line never echoes the configured value", () => {
    expect(solUnsetBootLine("gaia", undefined)).toContain("SOL_WEBHOOK_URL unset");
    const bad = solUnsetBootLine("gaia", `https://discord.com/api/webhooks/x/${TOKEN}`);
    expect(bad).not.toContain(TOKEN);
    expect(bad).toContain("dropped");
  });
});
