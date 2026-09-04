import { jest, describe, test, expect } from "@jest/globals";
import { isPass, handleDirectorInvite } from "../director-invite.js";
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
