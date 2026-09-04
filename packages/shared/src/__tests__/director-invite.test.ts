import { jest, describe, test, expect } from "@jest/globals";
import { isPass, handleDirectorInvite, startDirectorListener, commonsMessageFor, shouldDeferToDirector } from "../director-invite.js";
import { CHANNEL } from "../events.js";
import type { AutonomousContext } from "../autonomous-core.js";
import type { DirectorInvitePayload } from "../events.js";

function ctxWith(reply: string | null): { ctx: AutonomousContext; sent: string[]; published: Array<[string, string]> } {
  const sent: string[] = []; const published: Array<[string, string]> = [];
  const channel = {
    isTextBased: () => true,
    send: jest.fn(async (c: string) => { sent.push(c); return { id: "sent1" }; }),
    messages: { fetch: jest.fn(async () => new Map()) },
  };
  const ctx = {
    companionId: "cypher", cooldownMs: 0, floorLockMs: 1000, heartbeatChannelId: undefined, interCompanionChannelId: "c1",
    interestKeywords: [], defaultInterTarget: "gaia", halsethSecret: "s",
    prompts: { directorInvite: () => "prompt" } as never,
    librarian: { writeWmNote: jest.fn(async () => {}) } as never,
    inference: { generate: jest.fn(async () => reply) } as never,
    client: { channels: { fetch: jest.fn(async () => channel) }, user: { id: "me" } } as never,
    configCache: {} as never, bootCtx: { systemPrompt: "sys" } as never, sessionWindows: {} as never,
    redis: { publish: jest.fn(async (ch: string, m: string) => { published.push([ch, m]); return 1; }) } as never,
    cooldown: new Map(), messageBuffer: [], cycleGuard: { reset() {} } as never,
  } as unknown as AutonomousContext;
  return { ctx, sent, published };
}
const invite = (o: Partial<DirectorInvitePayload> = {}): DirectorInvitePayload => ({
  inviteId: "i1", channelId: "c1", threadId: "t1", companionId: "cypher", reason: "open", stateBlock: "topic: x", offer: [],
  expiresAt: new Date(Date.now() + 60_000).toISOString(), ...o,
});

describe("director invite handling", () => {
  test("isPass accepts the sentinel forms", () => {
    expect(isPass("[PASS]")).toBe(true); expect(isPass("PASS")).toBe(true); expect(isPass("[PASS] nothing to add")).toBe(true);
    expect(isPass("Passing thought: the tide")).toBe(false);
  });
  test("a pass publishes a passed result and sends nothing", async () => {
    const { ctx, sent, published } = ctxWith("[PASS]");
    await handleDirectorInvite(ctx, invite());
    expect(sent).toHaveLength(0);
    expect(published[0]![0]).toBe(CHANNEL.directorResult);
    expect(JSON.parse(published[0]![1]).outcome).toBe("passed");
  });
  test("a reply is sent, [LANDS:] is stripped and reported, used offers are named", async () => {
    const { ctx, sent, published } = ctxWith("The crows do remember. [LANDS: memory is a kind of loyalty]");
    await handleDirectorInvite(ctx, invite({ offer: [{ kind: "forage", id: "f1", table: "forage_finds", owner: "cypher", title: "crows remember faces", body: "", created_at: "x", heat: null, consumed_by: [] }] }));
    expect(sent[0]).toBe("The crows do remember.");
    const res = JSON.parse(published[0]![1]);
    expect(res.outcome).toBe("spoke"); expect(res.landed).toBe("memory is a kind of loyalty"); expect(res.usedOfferIds).toEqual(["f1"]);
  });
  test("an expired invite is dropped and reported expired", async () => {
    const { ctx, sent, published } = ctxWith("late");
    await handleDirectorInvite(ctx, invite({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(sent).toHaveLength(0);
    expect(JSON.parse(published[0]![1]).outcome).toBe("expired");
  });
  test("empty generation reports empty", async () => {
    const { ctx, published } = ctxWith(null);
    await handleDirectorInvite(ctx, invite());
    expect(JSON.parse(published[0]![1]).outcome).toBe("empty");
  });
});

describe("startDirectorListener: serializes invites so a bot never runs two concurrently", () => {
  test("two invites dispatched back-to-back resolve in order, each result carrying its own inviteId and messageId", async () => {
    let sendCount = 0;
    const sent: string[] = [];
    const channel = {
      isTextBased: () => true,
      send: jest.fn(async (c: string) => { sent.push(c); return { id: `sent${++sendCount}` }; }),
      messages: { fetch: jest.fn(async () => new Map()) },
    };
    const published: Array<[string, string]> = [];
    let messageListener: ((ch: string, msg: string) => void) | null = null;
    const subscriber = {
      subscribe: jest.fn(async () => {}),
      unsubscribe: jest.fn(async () => {}),
      on: jest.fn((event: string, cb: (ch: string, msg: string) => void) => { if (event === "message") messageListener = cb; }),
      off: jest.fn(() => {}),
      quit: jest.fn(async () => {}),
    };
    const ctx = {
      companionId: "cypher", cooldownMs: 0, floorLockMs: 1000, heartbeatChannelId: undefined, interCompanionChannelId: "c1",
      interestKeywords: [], defaultInterTarget: "gaia", halsethSecret: "s",
      prompts: { directorInvite: () => "prompt" } as never,
      librarian: { writeWmNote: jest.fn(async () => {}) } as never,
      inference: { generate: jest.fn(async () => "a genuinely fresh reply each time, no markers") } as never,
      client: { channels: { fetch: jest.fn(async () => channel) }, user: { id: "me" } } as never,
      configCache: {} as never, bootCtx: { systemPrompt: "sys" } as never, sessionWindows: {} as never,
      redis: {
        publish: jest.fn(async (ch: string, m: string) => { published.push([ch, m]); return 1; }),
        duplicate: () => subscriber,
      } as never,
      cooldown: new Map(), messageBuffer: [], cycleGuard: { reset() {} } as never,
    } as unknown as AutonomousContext;

    const stop = startDirectorListener(ctx);
    expect(messageListener).not.toBeNull();

    const inviteA = invite({ inviteId: "a" });
    const inviteB = invite({ inviteId: "b" });
    const channelName = CHANNEL.directorInvite("cypher");
    messageListener!(channelName, JSON.stringify(inviteA));
    messageListener!(channelName, JSON.stringify(inviteB));

    // The chain runs on microtasks/promises internal to the module; give it room to drain.
    await new Promise((r) => setTimeout(r, 20));

    expect(published).toHaveLength(2);
    const resA = JSON.parse(published[0]![1]);
    const resB = JSON.parse(published[1]![1]);
    expect(resA.inviteId).toBe("a");
    expect(resA.messageId).toBe("sent1");
    expect(resB.inviteId).toBe("b");
    expect(resB.messageId).toBe("sent2");
    stop();
  });
});

describe("commonsMessageFor: pure translation from a raw message into the commons payload", () => {
  const base = {
    channelId: "c1", messageId: "m1", authorId: "u1", replyToMessageId: null,
    content: "hello", createdTimestamp: 1000, publishedBy: "cypher" as const,
  };
  test("authorKind is companion and companionId is set when isCompanionBot", () => {
    const p = commonsMessageFor({ ...base, isCompanionBot: true, webhookId: null, senderCompanion: "gaia" });
    expect(p.authorKind).toBe("companion");
    expect(p.companionId).toBe("gaia");
  });
  test("authorKind is proxy when a webhookId is present and the sender is not a companion bot", () => {
    const p = commonsMessageFor({ ...base, isCompanionBot: false, webhookId: "wh1", senderCompanion: undefined });
    expect(p.authorKind).toBe("proxy");
    expect(p.companionId).toBeUndefined();
  });
  test("authorKind is human otherwise", () => {
    const p = commonsMessageFor({ ...base, isCompanionBot: false, webhookId: null, senderCompanion: undefined });
    expect(p.authorKind).toBe("human");
    expect(p.companionId).toBeUndefined();
  });
  test("companionId is never set for a non-companion sender even if one was somehow passed", () => {
    const p = commonsMessageFor({ ...base, isCompanionBot: false, webhookId: undefined, senderCompanion: "drevan" });
    expect(p.companionId).toBeUndefined();
  });
});

describe("shouldDeferToDirector: true only for a companion turn while fully live", () => {
  test("companion + live: defer", () => {
    expect(shouldDeferToDirector({ isCompanionBot: true, mode: "live" })).toBe(true);
  });
  test("companion + shadow: does not defer", () => {
    expect(shouldDeferToDirector({ isCompanionBot: true, mode: "shadow" })).toBe(false);
  });
  test("companion + off: does not defer", () => {
    expect(shouldDeferToDirector({ isCompanionBot: true, mode: "off" })).toBe(false);
  });
  test("human + live: never defers", () => {
    expect(shouldDeferToDirector({ isCompanionBot: false, mode: "live" })).toBe(false);
  });
  test("human + shadow: never defers", () => {
    expect(shouldDeferToDirector({ isCompanionBot: false, mode: "shadow" })).toBe(false);
  });
  test("human + off: never defers", () => {
    expect(shouldDeferToDirector({ isCompanionBot: false, mode: "off" })).toBe(false);
  });
});
