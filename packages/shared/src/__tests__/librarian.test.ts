import { jest, describe, it, expect } from "@jest/globals";
import { LibrarianClient, formatRecentContext, RECENT_CONTEXT_BUDGET, nowLine, refreshNowLine } from "../librarian.js";

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

  // Deploy change-notes (contract 0.10.0): announced system changes render as a status block;
  // an empty window renders nothing (no changes is normal, not a gap to name).
  it("renders deploy change-notes with age; empty renders nothing", () => {
    const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };
    const withNotes = formatRecentContext({
      ...base,
      change_notes: [{ id: "chg_0.10.0", body: "System change (contract 0.10.0): this lane.", created_at: new Date(Date.now() - 3600_000).toISOString() }],
    } as any);
    expect(withNotes).toContain("[System changes");
    expect(withNotes).toContain("this lane");
    const without = formatRecentContext({ ...base, change_notes: [] } as any);
    expect(without).not.toContain("[System changes");
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

// nowLine / refreshNowLine (2026-08-29): the [Now: ...] anchor is the only absolute date the
// model sees, cached in recentContextRef.value and refreshed only every 5min (indefinitely
// stale on an orient failure). refreshNowLine recomputes it at reply time so the cached copy
// can never reach the model unstamped-fresh.
describe("nowLine", () => {
  it("renders the Chicago-zoned weekday/date/time/zone-abbreviation format", () => {
    const line = nowLine(new Date("2026-08-29T20:42:00.000Z")); // 3:42 PM CDT
    expect(line).toMatch(/^\[Now: Saturday, August 29, 2026 at 3:42 PM CDT\]$/);
  });

  it("defaults to the current time when called with no argument", () => {
    expect(nowLine()).toMatch(/^\[Now: .+\]$/);
  });
});

describe("refreshNowLine", () => {
  const fresh = new Date("2026-08-29T20:42:00.000Z");

  it("replaces a stale [Now: ...] line with a freshly computed one", () => {
    const stale = "[Now: Friday, August 28, 2026 at 11:00 AM CDT]\n\n## Recent\nsome context";
    const out = refreshNowLine(stale, fresh);
    expect(out).toContain(nowLine(fresh));
    expect(out).not.toContain("August 28");
    expect(out).toContain("## Recent\nsome context"); // rest of the block untouched
  });

  it("prepends a fresh line when the context has no [Now: ...] at all", () => {
    const noAnchor = "## Recent\nsome context";
    const out = refreshNowLine(noAnchor, fresh);
    expect(out.startsWith(nowLine(fresh))).toBe(true);
    expect(out).toContain("## Recent\nsome context");
  });

  it("prepends a bare fresh line for an empty context (no dangling separator)", () => {
    expect(refreshNowLine("", fresh)).toBe(nowLine(fresh));
  });

  it("only touches the [Now: ...] line, never a stray bracket elsewhere in the block", () => {
    const stale = "[Now: Friday, August 28, 2026 at 11:00 AM CDT]\n\n[Active model] flash";
    const out = refreshNowLine(stale, fresh);
    expect(out).toContain("[Active model] flash");
    expect(out.match(/\[Now:/g)?.length).toBe(1);
  });
});

describe("the body on the bot wire ([Body] + [Why these numbers], contract 0.13.0)", () => {
  const baseOrient = {
    synthesis_summary: null,
    ground_threads: [],
    ground_handoff: null,
    rag_excerpts: [],
  };
  const floats = [
    { label: "heat", value: 0.68, baseline: 0.5, seed: 0.5, off_baseline_hours: 3 },
    { label: "reach", value: 0.71, baseline: 0.6, seed: 0.6, off_baseline_hours: null },
    { label: "weight", value: 0.55, baseline: 0.55, seed: 0.5, off_baseline_hours: null },
  ];
  const entry = (over: Record<string, unknown>) => ({
    float_key: "soma_float_1", label: "heat", kind: "tick", writer: "ferment-tick",
    before_value: 0.6, after_value: 0.68, delta: 0.08, cause_table: null, cause_id: null,
    cause_label: null, session_id: null, alongside_notes: 0, created_at: "2026-09-14T03:00:00.000Z",
    ...over,
  });

  it("omits the block entirely when both arrays are empty or absent", () => {
    expect(formatRecentContext({ ...baseOrient, soma_floats: [], soma_provenance: [] })).not.toContain("[Body]");
    expect(formatRecentContext({ ...baseOrient })).not.toContain("[Body]");
    expect(formatRecentContext({ ...baseOrient })).not.toContain("[Why these numbers]");
  });

  it("renders the header with all three floats at 2 decimals, labels from the payload", () => {
    const block = formatRecentContext({ ...baseOrient, soma_floats: floats, soma_provenance: [] });
    expect(block).toContain("[Body] heat 0.68 · reach 0.71 · weight 0.55");
    expect(block).not.toContain("[Why these numbers]"); // no moves = header only, no empty sub-header
  });

  it("an authored update with a session cause renders the halseth form: you set it <day> during <cause_label>: \"<detail>\"", () => {
    const block = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({
          kind: "authored_update", writer: "cypher", before_value: 0.5, after_value: 0.68,
          cause_table: "sessions", cause_id: "4f2a91c0-0000-0000-0000-000000000000",
          cause_label: "work session 4f2a91c0, opened 2026-09-14",
          detail: "audit landed", created_at: "2026-09-14T22:10:00.000Z",
        }),
      ],
    });
    expect(block).toContain("[Why these numbers]");
    // 109 code points: fits inside the 110 cap, so the whole halseth form is pinned verbatim.
    expect(block).toContain('• heat 0.68 (was 0.50) -- you set it 2026-09-14 during work session 4f2a91c0, opened 2026-09-14: "audit landed"');
  });

  it("an authored update with only detail prints the companion's own words; with neither, the bare day", () => {
    const withWords = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ kind: "authored_update", writer: "cypher", before_value: 0.5, after_value: 0.68, detail: "the audit landed clean", created_at: "2026-09-13T22:10:00.000Z" }),
      ],
    });
    expect(withWords).toContain('• heat 0.68 (was 0.50) -- you set it 2026-09-13: "the audit landed clean"');
    expect(withWords).not.toContain(" during ");

    const bare = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ kind: "authored_update", writer: "cypher", before_value: 0.5, after_value: 0.68, created_at: "2026-09-13T22:10:00.000Z" }),
      ],
    });
    expect(bare).toContain("• heat 0.68 (was 0.50) -- you set it 2026-09-13");
    expect(bare).not.toContain("you set it 2026-09-13:");
  });

  it("an authored close quotes cause_label (the spine head) only; detail is not a fallback", () => {
    const spine = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ kind: "authored_close", writer: "cypher", before_value: 0.5, after_value: 0.68, cause_label: "shipped the body block", detail: "ignored words", alongside_notes: 2, created_at: "2026-09-13T22:10:00.000Z" }),
      ],
    });
    expect(spine).toContain('• heat 0.68 (was 0.50) -- you set it at close 2026-09-13: "shipped the body block" · 2 notes that session');
    expect(spine).not.toContain("ignored words");

    const noSpine = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ kind: "authored_close", writer: "cypher", before_value: 0.5, after_value: 0.68, detail: "not quoted either", created_at: "2026-09-13T22:10:00.000Z" }),
      ],
    });
    expect(noSpine).toContain("• heat 0.68 (was 0.50) -- you set it at close 2026-09-13");
    expect(noSpine).not.toContain("not quoted either");
  });

  it("caps each line at 110 code points with an ellipsis and never splits an emoji", () => {
    // 100 emoji, 2 UTF-16 units each (149 code points total, well over the cap): a .slice()-based cap
    // would land inside a surrogate pair.
    const words = "\u{1F525}".repeat(100);
    const block = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ kind: "authored_update", writer: "cypher", before_value: 0.5, after_value: 0.68, detail: words, created_at: "2026-09-13T22:10:00.000Z" }),
      ],
    });
    const line = block.split("\n").find(l => l.startsWith("• heat 0.68"))!;
    const body = line.slice(2); // strip the bullet
    expect(Array.from(body)).toHaveLength(110);
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF]…$/); // no lone high surrogate before the ellipsis
    for (const ch of Array.from(body)) expect(ch.length === 2 ? ch.codePointAt(0)! > 0xFFFF : true).toBe(true);
  });

  it("a machine tick names the cause; silence is distinguished from a plain tick", () => {
    const plain = formatRecentContext({ ...baseOrient, soma_floats: floats, soma_provenance: [entry({})] });
    expect(plain).toContain("• heat 0.68 (was 0.60) -- settled toward home (tick)");
    const silent = formatRecentContext({ ...baseOrient, soma_floats: floats, soma_provenance: [entry({ detail: "silence" })] });
    expect(silent).toContain("settled toward home (tick, silence)");
  });

  it("newest move per float only, 3 lines max, stimulus and drift named by cause", () => {
    const block = formatRecentContext({
      ...baseOrient,
      soma_floats: floats,
      soma_provenance: [
        entry({ float_key: "soma_float_2", label: "reach", kind: "stimulus", after_value: 0.71, before_value: 0.6, detail: "Raziel came back" }),
        entry({ float_key: "soma_float_2", label: "reach", kind: "tick", after_value: 0.6, before_value: 0.65 }), // older reach move: skipped
        entry({ float_key: "soma_float_3", label: "weight", kind: "drift_shift", after_value: 0.55, before_value: 0.5, cause_label: "carrying the week" }),
        entry({}),
        entry({ float_key: "soma_float_1", label: "heat", kind: "tick", after_value: 0.5, before_value: 0.4 }), // 4th float-line never renders
      ],
    });
    const lines = block.split("\n").filter(l => l.startsWith("• ") && / -- /.test(l));
    expect(lines).toHaveLength(3);
    expect(block).toContain("• reach 0.71 (was 0.60) -- stimulus: Raziel came back");
    expect(block).toContain('• weight 0.55 (was 0.50) -- drift: "carrying the week"');
    expect(block).not.toContain("reach 0.60 (was 0.65)");
    expect(block).not.toContain("heat 0.50 (was 0.40)");
    const body = block.slice(block.indexOf("[Body]"));
    const end = body.indexOf("\n\n");
    expect((end === -1 ? body : body.slice(0, end)).length).toBeLessThan(350);
  });

  it("sits in the unpinned rest before the supersede block; [Watching together] is pinned to the tail and the body is NOT", () => {
    const block = formatRecentContext({
      ...baseOrient,
      watching: [{ title: "Fargo", kind: "series", status: "active", position: "S2E4", position_note: null, with_companion: "raziel" }],
      soma_floats: floats,
      soma_provenance: [entry({})],
      supersede_candidates: [{ new_id: "n", older_id: "o", score: 0.9, newer: "newer belief", older: "older belief" }],
    });
    const watching = block.indexOf("[Watching together");
    const body = block.indexOf("[Body]");
    const supersede = block.indexOf("[Two of your beliefs");
    expect(watching).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(-1);
    // Watching is a pinned block: the assembler re-appends pinned blocks AFTER the unpinned rest, so
    // in the rendered string it lands last. The body block is deliberately unpinned (informative, not
    // load-bearing), so it stays in the rest, ahead of the supersede proposal and ahead of the tail.
    expect(supersede).toBeGreaterThan(body);
    expect(watching).toBeGreaterThan(supersede);
    expect(block.indexOf("[Now:")).toBeLessThan(body);
  });

  it("botOrient() maps soma_floats + soma_provenance through, defaulting to [] when absent", async () => {
    const mk = (payload: Record<string, unknown>) => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          jsonrpc: "2.0", id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ data: payload }) }] },
        }),
      } as any);
      return new LibrarianClient({ url: "https://example.com", secret: "test-secret", companionId: "cypher", fetch: mockFetch as unknown as typeof fetch });
    };
    const withBody = await mk({ soma_floats: floats, soma_provenance: [entry({})] }).botOrient();
    expect(withBody!.soma_floats).toHaveLength(3);
    expect(withBody!.soma_provenance![0]).toMatchObject({ float_key: "soma_float_1", kind: "tick" });
    const without = await mk({ synthesis_summary: "x" }).botOrient();
    expect(without!.soma_floats).toEqual([]);
    expect(without!.soma_provenance).toEqual([]);
    const junk = await mk({ soma_floats: "nope", soma_provenance: 42 }).botOrient();
    expect(junk!.soma_floats).toEqual([]);
    expect(junk!.soma_provenance).toEqual([]);
  });
});
