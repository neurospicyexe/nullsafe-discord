import { jest, describe, it, expect } from "@jest/globals";
import { resolveAttribution } from "../pluralkit.js";
import type { Attribution } from "../types.js";

const OWNER_ID = "123456789";

describe("resolveAttribution()", () => {
  it("non-webhook owner message → direct attribution", async () => {
    const msg = { webhookId: null, author: { id: OWNER_ID, bot: false }, id: "m1" };
    const result = await resolveAttribution(msg as any, OWNER_ID, undefined, mockFetch());
    expect(result).toMatchObject({
      isOwner: true, source: "direct", frontState: "unknown"
    } satisfies Partial<Attribution>);
  });

  it("PK webhook for owner → pluralkit attribution with member", async () => {
    const pkData = { sender: OWNER_ID, member: { name: "Ash" } };
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m2" };
    const result = await resolveAttribution(msg as any, OWNER_ID, undefined, mockFetch(pkData));
    expect(result).toMatchObject({
      isOwner: true, source: "pluralkit", frontMember: "Ash", frontState: "known"
    } satisfies Partial<Attribution>);
  });

  it("PK webhook for non-owner user → captures frontMember", async () => {
    const pkData = { sender: "blue123", member: { name: "BlueMember" } };
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m5" };
    const result = await resolveAttribution(msg as any, OWNER_ID, undefined, mockFetch(pkData));
    expect(result).toMatchObject({
      isOwner: false, source: "pluralkit", frontMember: "BlueMember", frontState: "known",
      discordUserId: "blue123",
    } satisfies Partial<Attribution>);
  });

  it("PK API timeout with knownSenderId → attributes to known sender", async () => {
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m3" };
    const result = await resolveAttribution(msg as any, OWNER_ID, OWNER_ID, mockFetch(null, true));
    expect(result).toMatchObject({
      isOwner: true, source: "fallback", discordUserId: OWNER_ID,
    } satisfies Partial<Attribution>);
  });

  it("PK API timeout with non-owner knownSenderId → NOT treated as owner", async () => {
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m6" };
    const result = await resolveAttribution(msg as any, OWNER_ID, "blue123", mockFetch(null, true));
    expect(result).toMatchObject({
      isOwner: false, source: "fallback", discordUserId: "blue123",
    } satisfies Partial<Attribution>);
  });

  it("PK API timeout with NO knownSenderId → unknown, not owner", async () => {
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m7" };
    const result = await resolveAttribution(msg as any, OWNER_ID, undefined, mockFetch(null, true));
    expect(result).toMatchObject({
      isOwner: false, source: "fallback", discordUserId: "unknown",
    } satisfies Partial<Attribution>);
  });

  it("non-owner user → isOwner false", async () => {
    const msg = { webhookId: null, author: { id: "other", bot: false }, id: "m4" };
    const result = await resolveAttribution(msg as any, OWNER_ID, undefined, mockFetch());
    expect(result).toMatchObject({ isOwner: false } satisfies Partial<Attribution>);
  });
});

function mockFetch(pkData?: unknown, shouldTimeout = false): typeof fetch {
  return jest.fn().mockImplementation(async () => {
    if (shouldTimeout) throw new Error("timeout");
    if (pkData === null) return { ok: false, status: 404 };
    return { ok: true, json: async () => pkData };
  }) as unknown as typeof fetch;
}
