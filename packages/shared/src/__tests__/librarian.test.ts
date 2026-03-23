import { LibrarianClient } from "../librarian.js";

describe("LibrarianClient.ask()", () => {
  it("returns data on 200 response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ session_id: "s1" }) }] },
      }),
    });
    const client = new LibrarianClient({
      url: "https://example.com",
      secret: "test-secret",
      companionId: "cypher",
      fetch: mockFetch as unknown as typeof fetch,
    });
    const result = await client.ask("open my session");
    expect(result).toMatchObject({ session_id: "s1" });
  });

  it("throws after retry on 5xx", async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const client = new LibrarianClient({
      url: "https://example.com",
      secret: "test-secret",
      companionId: "drevan",
      fetch: mockFetch as unknown as typeof fetch,
    });
    await expect(client.ask("open my session")).rejects.toThrow("Librarian 503");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
