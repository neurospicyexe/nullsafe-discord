import { jest, describe, it, expect } from "@jest/globals";
import { resolveAttribution } from "../pluralkit.js";
import type { Attribution } from "../types.js";

const RAZIEL_ID = "123456789";

describe("resolveAttribution()", () => {
  it("non-webhook Raziel message → direct attribution", async () => {
    const msg = { webhookId: null, author: { id: RAZIEL_ID, bot: false }, id: "m1" };
    const result = await resolveAttribution(msg as any, RAZIEL_ID, mockFetch());
    expect(result).toMatchObject({
      isRaziel: true, source: "direct", frontState: "unknown"
    } satisfies Partial<Attribution>);
  });

  it("PK webhook for Raziel → pluralkit attribution with member", async () => {
    const pkData = { sender: RAZIEL_ID, member: { name: "Ash" } };
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m2" };
    const result = await resolveAttribution(msg as any, RAZIEL_ID, mockFetch(pkData));
    expect(result).toMatchObject({
      isRaziel: true, source: "pluralkit", frontMember: "Ash", frontState: "known"
    } satisfies Partial<Attribution>);
  });

  it("PK API timeout → fallback as Raziel direct, frontState unknown", async () => {
    const msg = { webhookId: "wh1", author: { id: "wh1", bot: true }, id: "m3" };
    const result = await resolveAttribution(msg as any, RAZIEL_ID, mockFetch(null, true));
    expect(result).toMatchObject({
      isRaziel: true, source: "fallback", frontState: "unknown"
    } satisfies Partial<Attribution>);
  });

  it("non-Raziel user → isRaziel false", async () => {
    const msg = { webhookId: null, author: { id: "other", bot: false }, id: "m4" };
    const result = await resolveAttribution(msg as any, RAZIEL_ID, mockFetch());
    expect(result).toMatchObject({ isRaziel: false } satisfies Partial<Attribution>);
  });
});

function mockFetch(pkData?: unknown, shouldTimeout = false): typeof fetch {
  return jest.fn().mockImplementation(async () => {
    if (shouldTimeout) throw new Error("timeout");
    if (pkData === null) return { ok: false, status: 404 };
    return { ok: true, json: async () => pkData };
  }) as unknown as typeof fetch;
}
