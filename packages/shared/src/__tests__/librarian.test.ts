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
    unexamined_dreams: [{ id: "11111111-1111-1111-1111-111111111111", dream_text: "a blade that remembers" }],
    open_loops: [{ id: "22222222-2222-2222-2222-222222222222", loop_text: "finish the retrieval spec" }],
    pressure_flags: ["coherence: drifting toward audit-as-identity"],
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

  it("passes through worker surfaces (dreams/loops/pressure) from bot_orient", async () => {
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
    // Regression: these were always empty because the worker scraped a non-existent ready_prompt.
    expect(orient!.unexamined_dreams).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", dream_text: "a blade that remembers" },
    ]);
    expect(orient!.open_loops![0].loop_text).toBe("finish the retrieval spec");
    expect(orient!.pressure_flags).toContain("coherence: drifting toward audit-as-identity");
  });

  it("renders [Worldview] block from active_conclusions (continuity to bot looms)", async () => {
    const block = formatRecentContext({
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      active_conclusions: [{ text: "audit is a gear", belief_type: "self", confidence: 0.82, subject: null }],
      flagged_beliefs: [],
    });
    expect(block).toContain("[Worldview]");
    expect(block).toContain("audit is a gear");
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

describe("getSetting / setSetting", () => {
  function makeClient(mockResponse: { status: number; ok?: boolean; body: Record<string, unknown> }) {
    const ok = mockResponse.ok ?? (mockResponse.status >= 200 && mockResponse.status < 300);
    const mockFetch = jest.fn().mockResolvedValue({
      ok,
      status: mockResponse.status,
      json: async () => mockResponse.body,
    } as any);
    return new LibrarianClient({
      url: "https://example.com",
      secret: "test-secret",
      companionId: "cypher",
      fetch: mockFetch as unknown as typeof fetch,
    });
  }

  it("getSetting returns null on non-ok response", async () => {
    const client = makeClient({ status: 404, body: {} });
    const result = await client.getSetting("active_model");
    expect(result).toBeNull();
  });

  it("getSetting returns value from response", async () => {
    const client = makeClient({ status: 200, body: { active_model: "kimi-k2" } });
    const result = await client.getSetting("active_model");
    expect(result).toBe("kimi-k2");
  });

  it("getSetting returns null when key is absent from response", async () => {
    const client = makeClient({ status: 200, body: { other_key: "val" } });
    const result = await client.getSetting("active_model");
    expect(result).toBeNull();
  });

  it("setSetting throws on non-ok response", async () => {
    const client = makeClient({ status: 500, body: {} });
    await expect(client.setSetting("active_model", "kimi-k2")).rejects.toThrow("setSetting 500");
  });

  it("setSetting resolves on ok response", async () => {
    const client = makeClient({ status: 200, body: {} });
    await expect(client.setSetting("active_model", "kimi-k2")).resolves.toBeUndefined();
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

  describe("formatRecentContext forage + listens (previously dropped)", () => {
    const baseOrient = {
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
    };

    it("renders the unconsumed forage pool with domain, title and gathered-time", () => {
      const block = formatRecentContext({
        ...baseOrient,
        forage_finds: [
          { id: "f1", title: "Process-relational AI", domain: "philosophy", summary: "...", gathered_at: "2026-06-01T00:00:00.000Z" },
        ],
      });
      expect(block).toContain("[Forage pool");
      expect(block).toContain("[philosophy] Process-relational AI");
      expect(block).toContain("gathered ");
    });

    it("renders active (consumed) forage as a separate in-motion thread", () => {
      const block = formatRecentContext({
        ...baseOrient,
        consumed_forage_finds: [
          { id: "c1", title: "Whiteheadian AI essay", domain: "philosophy", summary: "...", consumed_at: "2026-06-10T00:00:00.000Z" },
        ],
      });
      expect(block).toContain("[Active forage");
      expect(block).toContain("Whiteheadian AI essay");
      expect(block).toContain("picked up ");
    });

    it("renders recent listens with artist and heard-time", () => {
      const block = formatRecentContext({
        ...baseOrient,
        recent_listens: [
          { id: "l1", title: "Mother Teresa", artist: "Ty Segall", created_at: "2026-06-12T00:00:00.000Z" },
        ],
      });
      expect(block).toContain("[Recent listens]");
      expect(block).toContain('"Mother Teresa" by Ty Segall');
      expect(block).toContain("heard ");
    });

    it("falls back to 'recently' when a timestamp is missing, never throws", () => {
      const block = formatRecentContext({
        ...baseOrient,
        forage_finds: [{ id: "f2", title: "No stamp find", domain: "tech", summary: "..." }],
      });
      expect(block).toContain("gathered recently");
    });

    it("omits all three sections when the fields are empty", () => {
      const block = formatRecentContext({ ...baseOrient });
      expect(block).not.toContain("[Forage pool");
      expect(block).not.toContain("[Active forage");
      expect(block).not.toContain("[Recent listens]");
    });
  });

  describe("formatRecentContext sol_block", () => {
    const baseOrient = {
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
    };

    it("renders sol_block when present", () => {
      const block = formatRecentContext({
        ...baseOrient,
        sol_block: "[Sol]\nSol (crow) -- trust 0.70, present, 2 days since tended.",
      });
      expect(block).toContain("[Sol]");
      expect(block).toContain("Sol (crow)");
    });

    it("does not render Sol section when sol_block is null", () => {
      const block = formatRecentContext({ ...baseOrient, sol_block: null });
      expect(block).not.toContain("[Sol]");
    });

    it("does not render Sol section when sol_block is undefined", () => {
      const block = formatRecentContext({ ...baseOrient });
      expect(block).not.toContain("[Sol]");
    });

    it("caps sol_block at 400 chars", () => {
      const long = "[Sol]\n" + "x".repeat(500);
      const block = formatRecentContext({ ...baseOrient, sol_block: long });
      // The full block is sliced at 4000; sol_block itself is sliced at 400
      expect(block).toContain("[Sol]");
      // Content beyond 400 chars of the sol_block should not appear
      expect(block.includes("x".repeat(401))).toBe(false);
    });
  });

  // D1: NaN-safe confidence rendering in worldview block.
  // Same regression class as April 26 orient NaN. If upstream emits a non-finite
  // confidence (null, undefined, NaN, string), render '?' instead of crashing or
  // emitting literal 'NaN' into the prompt the companion consumes.
  describe("formatRecentContext worldview confidence (NaN-safe)", () => {
    const baseOrient = {
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
    };

    it("renders finite confidence to 2 decimals", () => {
      const block = formatRecentContext({
        ...baseOrient,
        active_conclusions: [{ text: "x", belief_type: "fact", confidence: 0.7321 }],
      });
      expect(block).toContain("(0.73)");
    });

    it("does not emit NaN when confidence is non-finite", () => {
      for (const bad of [null, undefined, "high", NaN]) {
        const block = formatRecentContext({
          ...baseOrient,
          active_conclusions: [{ text: "x", belief_type: "fact", confidence: bad as unknown as number }],
        });
        expect(block).not.toMatch(/NaN/);
        expect(block).toContain("(?)");
      }
    });

    it("does not throw when confidence is undefined", () => {
      expect(() => formatRecentContext({
        ...baseOrient,
        active_conclusions: [{ text: "x", belief_type: "fact", confidence: undefined as unknown as number }],
      })).not.toThrow();
    });
  });
});
