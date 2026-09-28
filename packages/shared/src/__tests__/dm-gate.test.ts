// DMs with Raziel (2026-09-27): the owner gate, the place descriptor, and the recall seal.
//
// THE MOST IMPORTANT TEST HERE is "a non-owner DM is dropped before anything": anyone who shares a
// server with a bot can DM it, and without the gate a stranger gets full inference plus
// ask_librarian over Raziel's private data. It drives the REAL handleMessage with every dependency
// replaced by a tripwire that records any use at all, and asserts nothing was touched.

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { dmGateVerdict, droppedDmLogLine, placeBlock, dmParaphraseMemorySealed } from "../dm.js";
import { handleMessage, type MessageHandlerDeps } from "../bot-message-handler.js";
import { mayWidenAcross, sealDmChannel, resetSealedDmChannels, isSealedRecallSource } from "../recall-context.js";
import { LibrarianClient } from "../librarian.js";

const OWNER = "111111111111111111";
const STRANGER = "222222222222222222";

describe("dmGateVerdict", () => {
  it("a server channel is not a DM, whoever wrote it", () => {
    expect(dmGateVerdict({ guildId: "g1", authorId: STRANGER, ownerId: OWNER })).toBe("not_dm");
  });
  it("the owner's DM passes; anyone else's is dropped", () => {
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: OWNER })).toBe("owner");
    expect(dmGateVerdict({ guildId: null, authorId: STRANGER, ownerId: OWNER })).toBe("drop");
    expect(dmGateVerdict({ guildId: undefined, authorId: STRANGER, ownerId: OWNER })).toBe("drop");
  });
  it("fails closed with no configured owner (an unset env var never opens the DM to anyone)", () => {
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: "" })).toBe("drop");
    expect(dmGateVerdict({ guildId: null, authorId: OWNER, ownerId: undefined })).toBe("drop");
  });
  it("the log line carries no content", () => {
    expect(droppedDmLogLine("drevan", STRANGER)).toBe(`[drevan] dm dropped: author ${STRANGER} is not the owner (no content read or logged)`);
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

  it("server rooms render exactly as before (the text the handler built inline)", () => {
    expect(placeBlock({ isDm: false, channelName: "triad-hangout", modes: [] })).toBe(
      "\n\n[Where you are]\n• Channel: #triad-hangout\n• This is a shared channel." +
      "\n• Keep it contained to here: don't carry private or DM detail into a shared channel unless Raziel opens it in this room.",
    );
    expect(placeBlock({ isDm: false, channelName: "t", threadParentName: "parent", modes: ["owner_only"] }))
      .toContain("• Channel: #t (a thread under #parent)\n• This is a private space with Raziel.");
    expect(placeBlock({ isDm: false, channelName: "c", categoryName: "Cat", modes: ["inter_companion"] }))
      .toContain("• Channel: #c (in Cat)\n• This is triad space -- you and your siblings.");
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
