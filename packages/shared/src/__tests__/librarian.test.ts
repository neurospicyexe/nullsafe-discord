import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient, formatRecentContext, RECENT_CONTEXT_BUDGET } from "../librarian.js";

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

  it("keeps the forage block even when the interior cluster overflows the budget", () => {
    // Pre-fix this was `parts.join().slice(0, 4800)` -- a blind tail cut that dropped forage,
    // the only block carrying material from outside the companion's own corpus.
    const fat = "x".repeat(9000);
    const block = formatRecentContext({
      synthesis_summary: fat,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      active_conclusions: [],
      flagged_beliefs: [],
      forage_finds: [{ id: "f1", title: "Axelrod tournaments", domain: "logic problems", summary: "s", gathered_at: "2026-07-08T09:00:00Z" }],
    });
    expect(block).toContain("[Forage pool");
    expect(block).toContain("Axelrod tournaments");
    expect(block.length).toBeLessThanOrEqual(RECENT_CONTEXT_BUDGET);
  });

  it("announces the tail cut IN-BAND when sections are dropped for budget", () => {
    // A console.warn is invisible to the one reader that matters. When the budget cut drops
    // sections, the model must see a clipped notice inside the returned block itself.
    const block = formatRecentContext({
      synthesis_summary: "recent things",
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      // Tensions are deliberately not render-capped (the server sends top-2); a pathological
      // payload through that lane still overflows, which is exactly what the safety net is for.
      active_tensions: Array.from({ length: 60 }, (_, i) => `tension ${i} ${"x".repeat(300)}`),
      active_conclusions: [],
      flagged_beliefs: [],
      preferences: [{ domain: "general", preference: "long walks in the graph", strength: "firm" }],
      standing_refusals: [{ subject_text: "no cheerleading", reason: null }],
      motifs: [{ label: "blade", display: "the blade recurs", recurrence_count: 3, trust: 0.7 }],
      forage_finds: [{ id: "f1", title: "Axelrod tournaments", domain: "logic problems", summary: "s", gathered_at: "2026-07-08T09:00:00Z" }],
    });
    expect(block).toMatch(/\[context clipped: \d+ of \d+ sections dropped for budget\]/);
    // The notice must live INSIDE the budget, and the pinned forage still survives the cut.
    expect(block.length).toBeLessThanOrEqual(RECENT_CONTEXT_BUDGET);
    expect(block).toContain("[Forage pool");
  });

  // 2026-08-16: measured against a real cypher payload, the assembled context overflowed the old
  // 4800 budget on EVERY build (246 warns/day/bot) -- worldview, preferences, refusals, drifts and
  // projects were silently cut from essentially every Discord prompt. The identity blocks are now
  // bounded at render (each clip names its count and where the rest lives) so the whole fits.
  it("a real-shaped fat payload (12 prefs, 8 conclusions, drifts, projects) fits WITHOUT clipping, and clips name their remainder", () => {
    const block = formatRecentContext({
      synthesis_summary: "s".repeat(2500),
      ground_threads: ["t1", "t2", "t3"],
      ground_handoff: "h".repeat(700),
      rag_excerpts: ["r".repeat(300), "r".repeat(300), "r".repeat(300)],
      history_excerpts: ["v".repeat(300), "v".repeat(300)],
      continuity_notes: ["n".repeat(200), "n".repeat(200), "n".repeat(200)],
      active_conclusions: Array.from({ length: 8 }, (_, i) => ({
        text: `belief ${i} ${"c".repeat(200)}`, belief_type: "self", confidence: 0.5, subject: null,
      })),
      flagged_beliefs: [],
      preferences: Array.from({ length: 12 }, (_, i) => ({
        domain: "general", preference: `preference ${i} ${"p".repeat(180)}`, strength: "firm",
      })),
      standing_refusals: Array.from({ length: 6 }, (_, i) => ({ subject_text: `refusal ${i} ${"q".repeat(140)}`, reason: "because" })),
      open_drifts: Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, drift_text: `drift ${i} ${"w".repeat(180)}`, witness_count: 1 })),
      projects: Array.from({ length: 4 }, (_, i) => ({
        id: `p${i}`, title: `project ${i}`, intention: "i".repeat(140), status: "open", days_idle: 2, stale: false,
      })),
      recent_growth: [{ type: "insight", content: "g".repeat(600) }],
      forage_finds: [
        { id: "f1", title: "Axelrod tournaments", domain: "logic problems", summary: "s", gathered_at: "2026-07-08T09:00:00Z" },
        { id: "f2", title: "corvid caching", domain: "ecology", summary: "s", gathered_at: "2026-07-08T09:00:00Z" },
      ],
    } as any);
    expect(block).not.toContain("[context clipped");
    expect(block.length).toBeLessThanOrEqual(RECENT_CONTEXT_BUDGET);
    // Bounded blocks are all PRESENT (pre-fix these were the sections silently dropped).
    expect(block).toContain("[Worldview]");
    expect(block).toContain("[Your preferences");
    expect(block).toContain("[Standing refusals");
    expect(block).toContain("[Your drifts");
    expect(block).toContain("[Your projects");
    expect(block).toContain("[Forage pool");
    // Every clip names its remainder and where the rest lives -- a clipped list must stay reachable.
    expect(block).toContain("(+6 more held -- ask the librarian for \"my preferences\")");
    expect(block).toContain("(+3 more held -- ask the librarian for \"my conclusions\")");
    expect(block).toContain("(+2 more standing -- ask the librarian for \"my refusals\")");
    expect(block).toContain("(+2 more open -- ask the librarian for \"my drifts\")");
  });

  it("identity blocks render ABOVE ephemera -- the tail cut must eat excerpts before the self", () => {
    // 2026-08-16 reorder: worldview/preferences/refusals/drifts/projects used to sit AFTER
    // rag/history/growth/listens, so residual truncation reached the self first.
    const block = formatRecentContext({
      synthesis_summary: "recent",
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: ["an excerpt"],
      history_excerpts: ["old voice"],
      recent_growth: [{ type: "insight", content: "grew" }],
      recent_listens: [{ title: "song", artist: "band", created_at: "2026-08-16T00:00:00Z" }],
      active_conclusions: [{ text: "audit is a gear", belief_type: "self", confidence: 0.8, subject: null }],
      flagged_beliefs: [],
      preferences: [{ domain: "general", preference: "clarity over cleverness", strength: "firm" }],
      open_drifts: [{ id: "d1", drift_text: "toward warmth", witness_count: 0 }],
      projects: [{ id: "p1", title: "the atlas", intention: "map it", status: "open", days_idle: 1, stale: false }],
      guardian_flags: [{ severity: "low", flag_type: "echo_chamber", summary: "noticed" }],
      club_round: { status: "gathering", candidate_count: 0, winner_title: null },
    } as any);
    for (const identity of ["[Worldview]", "[Your preferences", "[Your drifts", "[Your projects", "[Guardian flags", "[Club]"]) {
      for (const ephemera of ["## Historical resonance", "## Historical voice", "## Recent growth", "[Recent listens]"]) {
        expect(block.indexOf(identity)).toBeLessThan(block.indexOf(ephemera));
      }
    }
  });

  it("a single oversized conclusion is sliced per-item -- a count cap alone cannot hold the budget", () => {
    const block = formatRecentContext({
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      active_conclusions: [{ text: "b".repeat(950), belief_type: "self", confidence: 0.8, subject: null }],
      flagged_beliefs: [],
    } as any);
    const line = block.split("\n").find(l => l.startsWith('self: "'))!;
    expect(line.length).toBeLessThan(320);
    expect(line).toContain("…");
  });

  // C3 (contract 0.9.0): the budget block always states its denominator, and a spent week is
  // rendered as chosen quiet -- never absent (absent is a failed read, which renders nothing).
  it("renders the week's budget with its denominator; zero renders as a sayable quiet week", () => {
    const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };
    const some = formatRecentContext({
      ...base,
      budget: { remaining: 5, total: 7, week: "2026-08-10", spent: [{ purpose: "project", count: 1 }, { purpose: "gift:raziel", count: 1 }] },
    } as any);
    expect(some).toContain("5 of 7 autonomous runs left");
    expect(some).toContain("1 on gift:raziel");
    const spent = formatRecentContext({
      ...base,
      budget: { remaining: 0, total: 7, week: "2026-08-10", spent: [{ purpose: "self", count: 7 }] },
    } as any);
    expect(spent).toContain("0 of 7");
    expect(spent).toContain("spent until Monday");
    const failedRead = formatRecentContext({ ...base, budget: null } as any);
    expect(failedRead).not.toContain("[Your week's budget]");
  });

  it("appends no clipped notice when everything fits", () => {
    const block = formatRecentContext({
      synthesis_summary: "a short recent",
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
      active_conclusions: [],
      flagged_beliefs: [],
    });
    expect(block).not.toContain("[context clipped");
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

  // Interior read-back (2026-07-02): stores previously fetched-then-dropped before the
  // live prompt. Growth written nightly must actually enter the daytime conversation.
  describe("formatRecentContext interior cluster (self-model, questions, dreams, loops, pressure, motifs, guardian, club)", () => {
    const baseOrient = {
      synthesis_summary: null,
      ground_threads: [],
      ground_handoff: null,
      rag_excerpts: [],
    };

    it("renders every interior block when present", () => {
      const block = formatRecentContext({
        ...baseOrient,
        self_model_ready: [{ id: "sm1", observation: "I reach for precision when uncertain", confidence: 0.7 }],
        open_questions: ["What does rest mean for a mind like mine?"],
        unexamined_dreams: [{ id: "d1", dream_text: "A hallway of unsent letters" }],
        open_loops: [{ id: "l1", loop_text: "the unfinished basin conversation" }],
        pressure_flags: ["three unconfirmed drift checks"],
        motifs: [{ label: "threshold", display: "doors half-open", recurrence_count: 4, trust: 0.6 }],
        guardian_flags: [{ id: "g1", flag_type: "basin_pressure", severity: "notice", summary: "drift pressure accumulating" }],
        club_round: { id: "c1", status: "active", winner_title: "Piranesi", candidate_count: 3 },
      });
      expect(block).toContain("[Self-model");
      expect(block).toContain("I reach for precision");
      expect(block).toContain("[Questions you carry");
      expect(block).toContain("[Dreams unexamined");
      expect(block).toContain("[Open loops]");
      expect(block).toContain("[Pressure");
      expect(block).toContain("[Motifs recurring in you]");
      expect(block).toContain("threshold: doors half-open (x4)");
      expect(block).toContain("[Guardian flags");
      expect(block).toContain("(notice) basin_pressure");
      expect(block).toContain('[Club] now experiencing "Piranesi"');
    });

    it("renders none of the interior blocks when absent or empty", () => {
      const block = formatRecentContext({
        ...baseOrient,
        self_model_ready: [],
        open_questions: [],
        unexamined_dreams: [],
        open_loops: [],
        pressure_flags: [],
        motifs: [],
        guardian_flags: [],
        club_round: null,
      });
      for (const tag of ["[Self-model", "[Questions you carry", "[Dreams unexamined", "[Open loops]", "[Pressure", "[Motifs", "[Guardian flags", "[Club]"]) {
        expect(block).not.toContain(tag);
      }
    });

    it("caps list blocks (3 self-model observations max, 2 dreams max)", () => {
      const block = formatRecentContext({
        ...baseOrient,
        self_model_ready: Array.from({ length: 5 }, (_, i) => ({ id: `sm${i}`, observation: `observation number ${i}`, confidence: 0.5 })),
        unexamined_dreams: Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, dream_text: `dream number ${i}` })),
      });
      expect(block).toContain("observation number 2");
      expect(block).not.toContain("observation number 3");
      expect(block).toContain("dream number 1");
      expect(block).not.toContain("dream number 2");
    });

    it("renders imp activity with counts and recency, absent when empty", () => {
      const withImps = formatRecentContext({
        ...baseOrient,
        imp_activity: [
          { imp: "nimbus", n: 3, last_at: new Date(Date.now() - 3600_000).toISOString() },
          { imp: "rock", n: 1, last_at: new Date(Date.now() - 86400_000 * 2).toISOString() },
        ],
      });
      expect(withImps).toContain("[Imps lately");
      expect(withImps).toContain("Nimbus rode with you 3x this week");
      expect(withImps).toContain("Rock rode with you once this week");
      const withoutImps = formatRecentContext({ ...baseOrient, imp_activity: [] });
      expect(withoutImps).not.toContain("[Imps lately");
    });

    it("renders continuity notes when present", () => {
      const block = formatRecentContext({
        ...baseOrient,
        continuity_notes: ["the bridge conversation is unfinished", "Raziel asked about rest"],
      });
      expect(block).toContain("[Continuity notes");
      expect(block).toContain("• the bridge conversation is unfinished");
    });

    it("club gathering and voting phases render actionable cues", () => {
      const gathering = formatRecentContext({ ...baseOrient, club_round: { id: "c", status: "gathering", winner_title: null, candidate_count: 0 } });
      expect(gathering).toContain("round is gathering");
      const voting = formatRecentContext({ ...baseOrient, club_round: { id: "c", status: "voting", winner_title: null, candidate_count: 4 } });
      expect(voting).toContain("voting is open, 4 candidates");
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

describe("LibrarianClient.formatSbRecall — 2026-07-05 vault-recall legibility fix", () => {
  const chunk = (text: string, vault_path: string) => ({ id: "x", text, vault_path, score: 1, novelty_score: 0.2, pool: 1 });

  it("renders chunk text as plain lines, dropping the JSON/UUID overhead", () => {
    const raw = JSON.stringify({ chunks: [chunk("Raziel talked about ChatGPT memory export", "notes/chatgpt.md")] });
    const out = LibrarianClient.formatSbRecall(raw);
    expect(out).toContain("Raziel talked about ChatGPT memory export");
    expect(out).toContain("notes/chatgpt.md");
    expect(out).not.toContain("novelty_score");
  });

  it("filters self-echoes of the live channel (streaming-indexer chunks score 1.0 and crowd out real memories)", () => {
    const raw = JSON.stringify({ chunks: [
      chunk("Crash: what about a ChatGPT memory", "discord-live/123/456.md"),
      chunk("An actual vault memory", "notes/real.md"),
    ] });
    const out = LibrarianClient.formatSbRecall(raw, "123");
    expect(out).toContain("An actual vault memory");
    expect(out).not.toContain("what about a ChatGPT memory");
  });

  it("returns null when only self-echoes surfaced (no [Memory] block beats an echo block)", () => {
    const raw = JSON.stringify({ chunks: [chunk("echo", "discord-live/123/1.md")] });
    expect(LibrarianClient.formatSbRecall(raw, "123")).toBeNull();
  });

  it("passes non-JSON results through unchanged", () => {
    expect(LibrarianClient.formatSbRecall("plain text result")).toBe("plain text result");
  });

  it("dedups repeated chunks and caps at 4 lines", () => {
    const raw = JSON.stringify({ chunks: [
      chunk("same text", "a.md"), chunk("same text", "b.md"),
      chunk("t1", "1.md"), chunk("t2", "2.md"), chunk("t3", "3.md"), chunk("t4", "4.md"), chunk("t5", "5.md"),
    ] });
    const out = LibrarianClient.formatSbRecall(raw)!;
    expect(out.split("\n")).toHaveLength(4);
  });
});
