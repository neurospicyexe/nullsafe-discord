import { jest, describe, it, expect } from "@jest/globals";
import { resolveAttribution, PkDedup } from "../pluralkit.js";
import type { Attribution } from "../types.js";

const OWNER_ID = "123456789";

describe("PkDedup (proxy-tag-tolerant double-post suppression)", () => {
  const CH = "chan1";

  it("autoproxy: identical original+webhook content dedups and captures sender", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig1", "hello", OWNER_ID);
    const match = d.matchWebhook(CH, "hello");
    expect(match).toEqual({ senderId: OWNER_ID });
    // original wakes after the hold and finds itself skipped
    expect(d.resolveOriginal(CH, "orig1")).toEqual({ skip: true });
  });

  it("prefix proxy tag stripped: 'cy: hello' original matches 'hello' webhook", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig2", "cy: hello", OWNER_ID);
    expect(d.matchWebhook(CH, "hello")).toEqual({ senderId: OWNER_ID });
    expect(d.resolveOriginal(CH, "orig2")).toEqual({ skip: true });
  });

  it("suffix proxy tag stripped: 'hello -c' original matches 'hello' webhook", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig3", "hello -c", OWNER_ID);
    expect(d.matchWebhook(CH, "hello")).toEqual({ senderId: OWNER_ID });
    expect(d.resolveOriginal(CH, "orig3")).toEqual({ skip: true });
  });

  it("genuinely unproxied: no webhook follows, original is NOT skipped", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig4", "just me talking", OWNER_ID);
    expect(d.resolveOriginal(CH, "orig4")).toEqual({ skip: false });
  });

  it("empty webhook content (image-only proxy) never false-matches", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig5", "anything", OWNER_ID);
    expect(d.matchWebhook(CH, "   ")).toBeNull();
    expect(d.resolveOriginal(CH, "orig5")).toEqual({ skip: false });
  });

  it("non-matching webhook content returns null", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig6", "hello", OWNER_ID);
    expect(d.matchWebhook(CH, "totally different")).toBeNull();
  });

  it("different channel does not match", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "orig7", "hello", OWNER_ID);
    expect(d.matchWebhook("otherchan", "hello")).toBeNull();
  });

  it("two pending originals: webhook matches the right one by containment", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "a", "cy: morning", "user-A");
    d.addOriginal(CH, "b", "cy: evening", "user-B");
    expect(d.matchWebhook(CH, "evening")).toEqual({ senderId: "user-B" });
    expect(d.resolveOriginal(CH, "b")).toEqual({ skip: true });
    expect(d.resolveOriginal(CH, "a")).toEqual({ skip: false });
  });

  it("short webhook does NOT match a long original that merely contains it", () => {
    // Owner's long proxied message is pending; another user proxies a short "ok".
    // Containment alone would wrongly drop the owner's message and steal its sender.
    const d = new PkDedup();
    d.addOriginal(CH, "long", "cy: ok everyone listen up for a sec", OWNER_ID);
    expect(d.matchWebhook(CH, "ok")).toBeNull();
    expect(d.resolveOriginal(CH, "long")).toEqual({ skip: false });
  });

  it("circumfix tag within budget still matches: '{hello}' original vs 'hello' webhook", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "circ", "{hello}", OWNER_ID);
    expect(d.matchWebhook(CH, "hello")).toEqual({ senderId: OWNER_ID });
  });

  it("a webhook only consumes one matching original (no double-skip)", () => {
    const d = new PkDedup();
    d.addOriginal(CH, "x", "hello", "user-A");
    d.addOriginal(CH, "y", "hello", "user-B");
    d.matchWebhook(CH, "hello"); // should mark only the newest (y)
    expect(d.resolveOriginal(CH, "y")).toEqual({ skip: true });
    expect(d.resolveOriginal(CH, "x")).toEqual({ skip: false });
  });
});

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
