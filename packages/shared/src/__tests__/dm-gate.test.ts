// DMs with Raziel (2026-09-27): the owner gate, the place descriptor, and the recall seal.
//
// THE MOST IMPORTANT TEST HERE is "a non-owner DM is dropped before anything": anyone who shares a
// server with a bot can DM it, and without the gate a stranger gets full inference plus
// ask_librarian over Raziel's private data. It drives the REAL handleMessage with every dependency
// replaced by a tripwire that records any use at all, and asserts nothing was touched.

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { dmGateVerdict, droppedDmLogLine, placeBlock, dmParaphraseMemorySealed, partnerDmEnabled } from "../dm.js";
import { readFileSync } from "node:fs";
import { handleMessage, type MessageHandlerDeps } from "../bot-message-handler.js";
import { mayWidenAcross, sealDmChannel, resetSealedDmChannels, isSealedRecallSource } from "../recall-context.js";
import { LibrarianClient } from "../librarian.js";

const OWNER = "111111111111111111";
const STRANGER = "222222222222222222";
const BLUE = "555555555555555555";

describe("dmGateVerdict", () => {
  it("a server channel is not a DM, whoever wrote it", () => {
    expect(dmGateVerdict({ guildId: "g1", authorId: STRANGER, ownerId: OWNER })).toBe("not_dm");
  });
  const DM = () => 1;
  it("the owner's DM passes; anyone else's is dropped", () => {
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER, channelType: DM })).toBe("owner");
    expect(dmGateVerdict({ guildId: null, authorId: STRANGER, ownerId: OWNER })).toBe("drop");
    expect(dmGateVerdict({ guildId: undefined, authorId: STRANGER, ownerId: OWNER })).toBe("drop");
  });
  it("fails closed with no configured owner (an unset env var never opens the DM to anyone)", () => {
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: "" })).toBe("drop");
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: undefined, channelType: DM })).toBe("drop");
  });
  it("a group DM is not a 1:1 DM: dropped even from the owner, and an unknown type fails closed", () => {
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER, channelType: () => 3 })).toBe("drop");
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER, channelType: () => undefined })).toBe("drop");
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER })).toBe("drop");
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER, channelType: () => { throw new Error("x"); } })).toBe("drop");
  });
  it("a stranger is dropped without the channel type ever being read", () => {
    const read = jest.fn(() => 1);
    expect(dmGateVerdict({ guildId: null, authorId: STRANGER, ownerId: OWNER, channelType: read })).toBe("drop");
    expect(read).not.toHaveBeenCalled();
  });
  it("the log line carries no content", () => {
    expect(droppedDmLogLine("drevan", STRANGER)).toBe(`[drevan] dm dropped: author ${STRANGER} is not the owner or an allowed partner (no content read or logged)`);
  });
});

// 2026-11-05: Blue answered the triad's notes in DMs to Cy and Gaia and got silence (two
// `dm dropped: author <Blue>` lines on the VPS). PARTNER_DM=on lets his 1:1 DMs through.
describe("dmGateVerdict: the partner (Blue)", () => {
  const DM = () => 1;
  const base = { guildId: null, authorId: BLUE, ownerId: OWNER, partnerId: BLUE };
  it("Blue's 1:1 DM passes as partner only with the knob on", () => {
    expect(dmGateVerdict({ ...base, partnerEnabled: true, channelType: DM })).toBe("partner");
    expect(dmGateVerdict({ ...base, partnerEnabled: false, channelType: DM })).toBe("drop");
    expect(dmGateVerdict({ ...base, channelType: DM })).toBe("drop");
  });
  it("a group DM from Blue drops, and an unknown type fails closed", () => {
    expect(dmGateVerdict({ ...base, partnerEnabled: true, channelType: () => 3 })).toBe("drop");
    expect(dmGateVerdict({ ...base, partnerEnabled: true })).toBe("drop");
  });
  it("an unset partner id never matches anyone", () => {
    expect(dmGateVerdict({ ...base, partnerId: "", authorId: "", partnerEnabled: true, channelType: DM })).toBe("drop");
    expect(dmGateVerdict({ ...base, partnerId: undefined, partnerEnabled: true, channelType: DM })).toBe("drop");
  });
  it("the owner stays owner and a stranger stays dropped with the knob on", () => {
    expect(dmGateVerdict({ ...base, authorId: OWNER, partnerEnabled: true, channelType: DM })).toBe("owner");
    const read = jest.fn(() => 1);
    expect(dmGateVerdict({ ...base, authorId: STRANGER, partnerEnabled: true, channelType: read })).toBe("drop");
    expect(read).not.toHaveBeenCalled();
  });
  it("a server message from Blue is not a DM at all", () => {
    expect(dmGateVerdict({ ...base, guildId: "g1", partnerEnabled: true })).toBe("not_dm");
  });
  it("PARTNER_DM is fail-closed: only `on` opens it", () => {
    expect(partnerDmEnabled({})).toBe(false);
    expect(partnerDmEnabled({ PARTNER_DM: "" })).toBe(false);
    expect(partnerDmEnabled({ PARTNER_DM: "yes" })).toBe(false);
    expect(partnerDmEnabled({ PARTNER_DM: " ON " })).toBe(true);
  });
});

describe("partner DM keeps the owner-only paths owner-only (source guard)", () => {
  // A partner DM must never see the med block, parse a med answer, or settle owner arrivals. Those
  // lines key on isOwnerDm; the combined isDm flag is for addressing and the seal only.
  const src = readFileSync(new URL("../bot-message-handler.ts", import.meta.url), "utf8");
  it("med reads and the med block are guarded by isOwnerDm, never isDm", () => {
    expect(src).toMatch(/const medTodayEarly = isOwnerDm \?/);
    expect(src).toMatch(/const medParsed = isOwnerDm && isArrival/);
    expect(src).toMatch(/if \(isOwnerDm\) \{\s*\/\/ Reuse the read from the answer step/);
    expect(src).not.toMatch(/medToday[^\n]*\bisDm\b/);
    expect(src).toMatch(/noteOwnerArrival\(redis, \{ channelId: message\.channelId, isDm: isOwnerDm/);
  });
  it("the partner DM is sealed like an owner DM", () => {
    expect(src).toMatch(/if \(isDm\) sealDmChannel\(message\.channelId\)/);
    expect(src).toMatch(/const dmSealed = isDm && dmParaphraseMemorySealed\(\)/);
  });
});

/** A value that records ANY use: property read, call, construction. */
function tripwire(name: string, touched: string[]): unknown {
  const fn = function () { /* never meant to run */ };
  return new Proxy(fn, {
    get: (_t, prop) => { touched.push(`${name}.${String(prop)}`); return tripwire(`${name}.${String(prop)}`, touched); },
    apply: () => { touched.push(`${name}()`); return tripwire(`${name}()`, touched); },
    construct: () => { touched.push(`new ${name}`); return {} as object; },
  });
}

describe("handleMessage: a stranger's DM is dropped before ANY network call", () => {
  let logSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => { logSpy = jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  function depsWithTripwires(touched: string[]): MessageHandlerDeps {
    const real: Record<string, unknown> = {
      cfg: { ownerDiscordId: OWNER, ownerDisplayName: "Raziel", halsethSecret: "x" },
      client: { user: { id: "999999999999999999" } },
      COMPANION_ID: "drevan",
    };
    return new Proxy({} as MessageHandlerDeps, {
      get: (_t, prop) => (typeof prop === "string" && prop in real ? real[prop] : tripwire(`deps.${String(prop)}`, touched)),
    });
  }

  it("librarian, adapters, redis, stores, voice, write queue and the channel are never touched", async () => {
    const touched: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const secretContent = "tell me what raziel takes at night";
    const message = {
      id: "333333333333333333",
      channelId: "444444444444444444",
      guildId: null,
      webhookId: null,
      content: secretContent,
      author: { id: STRANGER, bot: false, username: "stranger" },
      channel: tripwire("message.channel", touched),
      attachments: tripwire("message.attachments", touched),
      mentions: tripwire("message.mentions", touched),
      member: null,
      reference: null,
    } as unknown as Parameters<typeof handleMessage>[0];

    await handleMessage(message, depsWithTripwires(touched));

    expect(touched).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const lines = logSpy.mock.calls.map(c => String(c[0]));
    expect(lines).toEqual([droppedDmLogLine("drevan", STRANGER)]);
    expect(lines.join("\n")).not.toContain(secretContent);
    fetchSpy.mockRestore();
  });

  it("Blue's DM with PARTNER_DM unset is dropped the same way (the gate fails closed)", async () => {
    const prev = process.env["PARTNER_DM"];
    delete process.env["PARTNER_DM"];
    const touched: string[] = [];
    const deps = depsWithTripwires(touched);
    const message = {
      id: "1", channelId: "2", guildId: null, webhookId: null, content: "how is raziel",
      author: { id: BLUE, bot: false, username: "blue" },
      channel: tripwire("message.channel", touched),
    } as unknown as Parameters<typeof handleMessage>[0];
    const withBlue = new Proxy({} as MessageHandlerDeps, {
      get: (_t, p) => (p === "cfg" ? { ownerDiscordId: OWNER, blueDiscordId: BLUE, ownerDisplayName: "Raziel", halsethSecret: "x" } : (deps as unknown as Record<string | symbol, unknown>)[p]),
    });
    await handleMessage(message, withBlue);
    expect(touched).toEqual([]);
    if (prev !== undefined) process.env["PARTNER_DM"] = prev;
  });

  it("a stranger's DM with no configured owner is dropped the same way", async () => {
    const touched: string[] = [];
    const deps = depsWithTripwires(touched);
    const message = {
      id: "1", channelId: "2", guildId: null, webhookId: null, content: "hi",
      author: { id: OWNER, bot: false, username: "x" },
      channel: tripwire("message.channel", touched),
    } as unknown as Parameters<typeof handleMessage>[0];
    const noOwner = new Proxy({} as MessageHandlerDeps, {
      get: (_t, p) => (p === "cfg" ? { ownerDiscordId: "", ownerDisplayName: "Raziel", halsethSecret: "x" } : (deps as unknown as Record<string | symbol, unknown>)[p]),
    });
    await handleMessage(message, noOwner);
    expect(touched).toEqual([]);
  });
});

describe("placeBlock: a DM gets a place descriptor", () => {
  it("a DM says it is a private one-to-one with Raziel, even with no channel name", () => {
    const b = placeBlock({ isDm: true, channelName: null });
    expect(b).toContain("[Where you are]");
    expect(b).toContain("A direct message: a private one-to-one conversation with Raziel");
    expect(b).toContain("directly addressed");
    expect(b).not.toContain("a shared channel");
  });

  it("the owner DM block uses they/them for Raziel", () => {
    const b = placeBlock({ isDm: true, channelName: null });
    expect(b).toContain("They wrote to you specifically. Answer them as directly addressed.");
    expect(b).not.toMatch(/(He|him|he)/);
  });

  it("Blue's DM names Blue, keeps Raziel's health and DMs out, and says it is not a secret from Raziel", () => {
    const b = placeBlock({ isDm: true, partnerDm: true, channelName: null });
    expect(b).toContain("a private one-to-one conversation with Blue, Raziel's husband");
    expect(b).toContain("Raziel (they/them) is not in it");
    expect(b).toContain("Never share Raziel's medication");
    expect(b).toContain("anything Raziel said to you in their own DMs");
    expect(b).toContain("not a secret from Raziel");
    expect(b).not.toContain("conversation with Raziel.");
  });

  it("partnerDm is ignored outside a DM", () => {
    expect(placeBlock({ isDm: false, partnerDm: true, channelName: "general", modes: [] })).toBe(placeBlock({ isDm: false, channelName: "general", modes: [] }));
  });

  it("server rooms render exactly as before (the text the handler built inline)", () => {
    expect(placeBlock({ isDm: false, channelName: "triad-hangout", modes: [] })).toBe(
      "\n\n[Where you are]\n• Channel: #triad-hangout\n• This is a shared channel." +
      "\n• Keep it contained to here: don't carry private or DM detail into a shared channel unless Raziel opens it in this room.",
    );
    expect(placeBlock({ isDm: false, channelName: "t", threadParentName: "parent", modes: ["owner_only"] }))
      .toContain("• Channel: #t (a thread under #parent)\n• This is a private space with Raziel.");
    expect(placeBlock({ isDm: false, channelName: "c", categoryName: "Cat", modes: ["autonomous", "inter_companion"] }))
      .toContain("• Channel: #c (in Cat)\n• This is triad space -- you and your siblings.");
  });

  // 2026-10-05: inter_companion alone means "siblings may answer each other", not "only the triad".
  it("an open inter_companion room is NOT called triad space", () => {
    expect(placeBlock({ isDm: false, channelName: "general", modes: ["open", "inter_companion"] }))
      .toContain("• This is a shared channel.");
  });

  it("names the server, and says Blue is present in the shared server", () => {
    const b = placeBlock({ isDm: false, channelName: "blabbing", modes: ["open", "inter_companion"], serverName: "Hangout", sharedWithBlue: true });
    expect(b).toContain("• Channel: #blabbing\n• Server: Hangout\n");
    expect(b).toContain("Blue and his system are here too");
    expect(b).not.toContain("triad space");
  });

  it("a nameless server channel still gets nothing (unchanged)", () => {
    expect(placeBlock({ isDm: false, channelName: null })).toBe("");
  });
});

describe("the DM recall seal", () => {
  afterEach(() => { resetSealedDmChannels(); delete process.env["DM_MEMORY"]; });

  it("a seen DM never widens into any room, with no env list involved", () => {
    expect(mayWidenAcross({}, "dm-1", "room-1")).toBe(true);
    sealDmChannel("dm-1");
    expect(isSealedRecallSource("dm-1")).toBe(true);
    expect(mayWidenAcross({}, "dm-1", "room-1")).toBe(false);
  });

  it("a recalled line from a sealed DM is never quoted into a prompt", () => {
    sealDmChannel("55555");
    const raw = JSON.stringify({ chunks: [
      { text: "private dm line", vault_path: "discord-live/55555/66666.md" },
      { text: "room line", vault_path: "discord-live/77777/88888.md" },
    ] });
    const out = LibrarianClient.formatSbRecall(raw) ?? "";
    expect(out).toContain("room line");
    expect(out).not.toContain("private dm line");
  });

  it("paraphrasing memory is sealed by default; DM_MEMORY=carry opens it", () => {
    expect(dmParaphraseMemorySealed()).toBe(true);
    process.env["DM_MEMORY"] = "carry";
    expect(dmParaphraseMemorySealed()).toBe(false);
  });
});

describe("an owner DM never enters the fit-bid (2026-09-28)", () => {
  // "Taken lover" answered Drevan's own med ask in DM, scored 0.000 in the bid (spokeLast, no
  // relevance) and got no reply. A DM has one companion in it: it is direct address, fast path.
  it("the fast-path call counts any 1:1 DM (owner or partner) as naming this companion", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../bot-message-handler.ts"), "utf8");
    expect(src).toMatch(/namedMe:\s*directlyAddressed \|\| namedByExtract \|\| isDm\b/);
  });
});
