import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient, formatRecentContext } from "../librarian.js";

describe("LibrarianClient.ask()", () => {
  it("returns data on 200 response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ session_id: "s1" }) }] },
      }),
    } as any);
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
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 } as any);
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

const canonicalOrientPayload = () => ({
  data: {
    synthesis_summary: "Cypher worked the retrieval-mandate spec.",
    ground_threads: ["blade bond", "perimeter architecture"],
    ground_handoff: "Mapped Slice C as continuity parity, not vault search.",
    rag_excerpts: ["excerpt one"],
    history_excerpts: ["historical voice line"],
    identity_anchor: "cypher: Blade companion, logic auditor",
    active_tensions: ["audit-as-identity drift"],
    relational_state_owner: ["Raziel processing requires verbal externalization"],
    incoming_notes: [{ from: "gaia", content: "read your retrieval spec" }],
    sibling_lanes: [
      { companion_id: "drevan", lane_spine: "wrote bond record", motion_state: "at_rest" },
      { companion_id: "gaia", lane_spine: "wrote triad portrait", motion_state: "at_rest" },
    ],
    recent_growth: [{ type: "insight", content: "coupling topology" }],
    active_patterns: [],
    pending_seeds: ["the blade as metaphor for precision under pressure"],
    unaccepted_growth: 1,
    active_conclusions: [
      { conclusion_text: "audit is a gear", belief_type: "self", confidence: 0.82, subject: null },
    ],
    flagged_beliefs: [],
  },
});

describe("LibrarianClient.botOrient()", () => {
  it("returns canonical 16-field shape including history_excerpts, sibling_lanes, unaccepted_growth", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(canonicalOrientPayload()) }] },
      }),
    } as any);
    const client = new LibrarianClient({
      url: "https://example.com",
      secret: "test-secret",
      companionId: "cypher",
      fetch: mockFetch as unknown as typeof fetch,
    });
    const orient = await client.botOrient();
    expect(orient).not.toBeNull();
    expect(orient!.history_excerpts).toEqual(["historical voice line"]);
    expect(orient!.sibling_lanes).toHaveLength(2);
    expect(orient!.sibling_lanes![0]).toMatchObject({ companion_id: "drevan", motion_state: "at_rest" });
    expect(orient!.unaccepted_growth).toBe(1);
    expect(orient!.identity_anchor).toContain("Blade companion");
    expect(orient!.active_conclusions![0].text).toBe("audit is a gear");
  });

  it("returns null on missing data field", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ data: undefined }) }] },
      }),
    } as any);
    const client = new LibrarianClient({
      url: "https://example.com",
      secret: "test-secret",
      companionId: "cypher",
      fetch: mockFetch as unknown as typeof fetch,
    });
    expect(await client.botOrient()).toBeNull();
  });
});

describe("formatRecentContext()", () => {
  it("renders all canonical fields including the 3 new ones", () => {
    const orient = canonicalOrientPayload().data;
    const block = formatRecentContext({
      synthesis_summary: orient.synthesis_summary,
      ground_threads: orient.ground_threads,
      ground_handoff: orient.ground_handoff,
      rag_excerpts: orient.rag_excerpts,
      history_excerpts: orient.history_excerpts,
      identity_anchor: orient.identity_anchor,
      active_tensions: orient.active_tensions,
      relational_state_owner: orient.relational_state_owner,
      incoming_notes: orient.incoming_notes,
      sibling_lanes: orient.sibling_lanes,
      recent_growth: orient.recent_growth,
      active_patterns: orient.active_patterns,
      pending_seeds: orient.pending_seeds,
      unaccepted_growth: orient.unaccepted_growth,
      active_conclusions: orient.active_conclusions.map(c => ({
        text: c.conclusion_text, belief_type: c.belief_type, confidence: c.confidence, subject: c.subject,
      })),
      flagged_beliefs: [],
    });
    expect(block).toContain("## Recent");
    expect(block).toContain("## Last handoff");
    expect(block).toContain("## Historical voice");
    expect(block).toContain("[Anchor]");
    expect(block).toContain("[Tensions]");
    expect(block).toContain("[Sibling Lanes]");
    expect(block).toContain("drevan [at_rest]: wrote bond record");
    expect(block).toContain("[Incoming Notes]");
    expect(block).toContain("[Unaccepted growth] 1 pending review");
    expect(block).toContain("[Worldview]");
  });

  it("returns empty string for null input", () => {
    expect(formatRecentContext(null)).toBe("");
  });
});
