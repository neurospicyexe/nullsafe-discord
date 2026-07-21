import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient } from "../librarian.js";

function makeClient(mockFetch: ReturnType<typeof jest.fn>) {
  return new LibrarianClient({
    url: "https://example.com",
    secret: "test-secret",
    companionId: "cypher",
    fetch: mockFetch as unknown as typeof fetch,
  });
}

describe("LibrarianClient.convoActive()", () => {
  it("returns null when body has thread:null", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thread: null }),
    } as any);
    const client = makeClient(mockFetch);
    const result = await client.convoActive("chan-1");
    expect(result).toBeNull();
  });

  it("returns dto+ledger when a thread is active", async () => {
    const thread = {
      id: "t1", channel_id: "chan-1", seed_text: "seed", seed_author: "raziel",
      ref_type: null, ref_id: null, ref_label: null,
      state: "open", turn_count: 2, last_turn_at: "2026-07-21T00:00:00Z",
    };
    const ledger = [
      { author: "raziel", gist: "asked about spine", said_at: "2026-07-20T23:59:00Z" },
      { author: "cypher", gist: "explained the design", said_at: "2026-07-21T00:00:00Z" },
    ];
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thread, ledger }),
    } as any);
    const client = makeClient(mockFetch);
    const result = await client.convoActive("chan-1");
    expect(result).toEqual({ thread, ledger });
  });

  it("returns null on non-ok response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 500 } as any);
    const client = makeClient(mockFetch);
    expect(await client.convoActive("chan-1")).toBeNull();
  });
});

describe("LibrarianClient.convoOpen()", () => {
  it("posts the correct URL and JSON body to /mind/conversations", async () => {
    const thread = {
      id: "t2", channel_id: "chan-1", seed_text: "seed text", seed_author: "raziel",
      ref_type: null, ref_id: null, ref_label: null,
      state: "open", turn_count: 0, last_turn_at: "2026-07-21T00:00:00Z",
    };
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ thread, created: true }),
    } as any);
    const client = makeClient(mockFetch);
    const params = { channel_id: "chan-1", seed_text: "seed text", seed_author: "raziel" };
    const result = await client.convoOpen(params);

    expect(result).toEqual(thread);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/mind/conversations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(params);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-secret");
  });

  it("returns null when fetch throws (fail-open)", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error("network down"));
    const client = makeClient(mockFetch);
    const result = await client.convoOpen({ channel_id: "chan-1", seed_text: "s", seed_author: "raziel" });
    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 400 } as any);
    const client = makeClient(mockFetch);
    const result = await client.convoOpen({ channel_id: "chan-1", seed_text: "s", seed_author: "raziel" });
    expect(result).toBeNull();
  });
});

describe("LibrarianClient.convoTurn()", () => {
  it("posts to the turns endpoint and resolves on success", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as any);
    const client = makeClient(mockFetch);
    await client.convoTurn("t1", { author: "cypher", gist: "replied" });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/mind/conversations/t1/turns");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ author: "cypher", gist: "replied" });
  });

  it("does not throw on 409 (terminal thread, warn-only)", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 409 } as any);
    const client = makeClient(mockFetch);
    await expect(client.convoTurn("t1", { author: "cypher", gist: "too late" })).resolves.toBeUndefined();
  });

  it("does not throw on network failure", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error("timeout"));
    const client = makeClient(mockFetch);
    await expect(client.convoTurn("t1", { author: "cypher", gist: "x" })).resolves.toBeUndefined();
  });
});

describe("LibrarianClient.convoLand()", () => {
  it("returns true on ok response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as any);
    const client = makeClient(mockFetch);
    const result = await client.convoLand("t1", { resolution: "resolved", landed_by: "cypher" });
    expect(result).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/mind/conversations/t1/land");
    expect(JSON.parse(init.body as string)).toEqual({ resolution: "resolved", landed_by: "cypher" });
  });

  it("returns false on a 409 response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 409 } as any);
    const client = makeClient(mockFetch);
    const result = await client.convoLand("t1", { resolution: "resolved", landed_by: "cypher" });
    expect(result).toBe(false);
  });

  it("returns false on network failure (fail-open)", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error("network down"));
    const client = makeClient(mockFetch);
    const result = await client.convoLand("t1", { resolution: "resolved", landed_by: "cypher" });
    expect(result).toBe(false);
  });
});
