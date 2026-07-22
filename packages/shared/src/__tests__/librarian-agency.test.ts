// Agency lane REST shape (2026-07-21, Wave 3 starvation fix): LibrarianClient.getPreferences /
// declarePreference are direct REST against halseth's /agency/preferences routes (mirrors the
// autonomous-worker's halseth-client.ts declarePreference exactly -- same URL/body/auth).

import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

describe("LibrarianClient.getPreferences", () => {
  it("GETs /agency/preferences/:companion_id and returns the array as-is", async () => {
    const fetchFn = jest.fn(async () => jsonRes([
      { id: "p1", domain: "autonomy", preference: "quiet mornings", strength: "medium", status: "active" },
    ]));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    const prefs = await client.getPreferences();
    expect(prefs).toEqual([{ id: "p1", domain: "autonomy", preference: "quiet mornings", strength: "medium", status: "active" }]);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x/agency/preferences/cypher");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s");
  });

  it("returns [] on a non-ok response", async () => {
    const fetchFn = jest.fn(async () => jsonRes({}, 401));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.getPreferences()).resolves.toEqual([]);
  });

  it("returns [] on a network error", async () => {
    const fetchFn = jest.fn(async () => { throw new Error("network down"); });
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.getPreferences()).resolves.toEqual([]);
  });

  it("returns [] when the response is not an array (defensive)", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ error: "unexpected shape" }));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.getPreferences()).resolves.toEqual([]);
  });
});

describe("LibrarianClient.declarePreference", () => {
  it("POSTs to /agency/preferences with companion_id + preference + optional domain/strength", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ id: "p2" }, 201));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "drevan", fetch: fetchFn as never });
    const r = await client.declarePreference("I want autonomous time that reaches into dark registers", "autonomy", "high");
    expect(r).toEqual({ id: "p2" });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x/agency/preferences");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s");
    expect(JSON.parse(init.body as string)).toEqual({
      companion_id: "drevan",
      preference: "I want autonomous time that reaches into dark registers",
      domain: "autonomy",
      strength: "high",
    });
  });

  it("omits domain/strength from the body when not supplied", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ id: "p3" }, 201));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "gaia", fetch: fetchFn as never });
    await client.declarePreference("a preference with no extras");
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ companion_id: "gaia", preference: "a preference with no extras" });
  });

  it("throws on a non-2xx response so callers must .catch()", async () => {
    const fetchFn = jest.fn(async () => jsonRes({ error: "bad" }, 400));
    const client = new LibrarianClient({ url: "https://x", secret: "s", companionId: "cypher", fetch: fetchFn as never });
    await expect(client.declarePreference("x")).rejects.toThrow("declarePreference 400");
  });
});
