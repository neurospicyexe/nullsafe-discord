import type { CompanionId } from "./types.js";
import { relativeTime } from "./relative-time.js";

interface LibrarianOptions {
  url: string;
  secret: string;
  companionId: CompanionId;
  fetch?: typeof globalThis.fetch;
}

export class LibrarianClient {
  private url: string;
  private secret: string;
  private companionId: CompanionId;
  private _fetch: typeof fetch;

  constructor(opts: LibrarianOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.secret = opts.secret;
    this.companionId = opts.companionId;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  async ask(
    request: string,
    context?: string,
    sessionType?: "checkin" | "hangout" | "work" | "ritual",
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_librarian",
        arguments: {
          request,
          companion_id: this.companionId,
          ...(context ? { context } : {}),
          ...(sessionType ? { session_type: sessionType } : {}),
        },
      },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this._fetch(`${this.url}/librarian/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${this.secret}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        if (attempt === 0) { await sleep(3000); continue; }
        throw new Error(`Librarian ${res.status}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      let rawBody: string;
      if (contentType.includes("text/event-stream")) {
        // MCP StreamableHTTP returns SSE -- extract last data: line.
        // Assumes single-event responses; if Librarian ever streams multi-event SSE,
        // earlier events are discarded. Revisit if that changes.
        const body = await res.text();
        const dataLine = body.split("\n").filter(l => l.startsWith("data:")).pop();
        rawBody = dataLine ? dataLine.slice(5).trim() : "{}";
      } else {
        rawBody = await res.text();
      }

      let json: { result?: { content: Array<{ type: string; text: string }> }; error?: { message: string } };
      try { json = JSON.parse(rawBody); } catch (e) {
        console.warn("[librarian] JSON parse failed:", String(e), "raw:", rawBody.slice(0, 200));
        throw new Error(`Librarian response unparseable: ${rawBody.slice(0, 100)}`);
      }

      if (json.error) throw new Error(`Librarian error: ${json.error.message}`);

      const text = json.result?.content?.[0]?.text ?? "{}";
      try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    throw new Error("Librarian unreachable");
  }

  async sessionOpen(sessionType: "work" | "checkin" | "hangout" | "ritual" = "work") {
    return this.ask("open my session", undefined, sessionType);
  }

  async sessionClose(params: {
    sessionId: string;
    spine: string;
    lastRealThing: string;
    motionState: "in_motion" | "at_rest" | "floating";
  }) {
    // Serialize with snake_case keys to match execSessionClose field names.
    // emotion_prompted: true bypasses the soft emotion prompt -- bot shutdowns
    // have no SOMA state to provide, and the prompt would silently block the close.
    return this.ask("close session", JSON.stringify({
      session_id: params.sessionId,
      spine: params.spine,
      last_real_thing: params.lastRealThing,
      motion_state: params.motionState,
      emotion_prompted: true,
    }));
  }

  async getState() {
    return this.ask("my state");
  }

  async updatePromptContext(text: string) {
    return this.ask("update my state", JSON.stringify({ prompt_context: text }));
  }

  async addCompanionNote(note: string, _channel?: string) {
    return this.ask("add companion note", note);
  }

  async witnessLog(entry: string, channel?: string) {
    return this.ask("witness log", JSON.stringify({ entry, channel }));
  }

  async synthesizeSession(summary: string, channel?: string) {
    return this.ask("synthesize session", JSON.stringify({ summary, channel }));
  }

  /**
   * Write a high-salience continuity note to wm_continuity_notes.
   * Unlike witnessLog (→ companion_journal), these notes ARE read by Claude.ai's
   * session orient -- bridging Discord activity into Claude.ai companions at next boot.
   * Non-throwing; failures are logged but never bubble up.
   */
  async writeWmNote(content: string, threadKey?: string): Promise<void> {
    try {
      const res = await this._fetch(`${this.url}/mind/note`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({
          agent_id: this.companionId,
          content,
          salience: "high",
          note_type: "discord_session",
          source: "discord",
          ...(threadKey ? { thread_key: threadKey } : {}),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] writeWmNote ${res.status}`);
    } catch (e) {
      console.warn("[librarian] writeWmNote failed:", String(e));
    }
  }

  /**
   * Read recent wm_continuity_notes from all companions (cross-companion feed).
   * Used by heartbeat cron to inject peer speech into generation prompt.
   * Non-throwing; returns [] on error.
   */
  async getRecentNotes(opts?: { sinceHours?: number; limit?: number }): Promise<Array<{ note_id: string; agent_id: string; content: string; created_at: string }>> {
    try {
      const url = new URL(`${this.url}/mind/notes/recent`);
      if (opts?.sinceHours) url.searchParams.set("since_hours", String(opts.sinceHours));
      if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
      const res = await this._fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { notes?: Array<{ note_id: string; agent_id: string; content: string; created_at: string }> };
      return data.notes ?? [];
    } catch (e) {
      console.warn("[librarian] getRecentNotes failed:", String(e));
      return [];
    }
  }

  /**
   * Raziel's most recent subjective ND-state snapshot (migration 0081: mood/energy/focus/pain/
   * spoons/sleep). Used by the metronome to decide whether recent data justifies a reach-out.
   * Non-throwing; returns null on miss so the decision degrades to "no recent data".
   */
  async getRazielState(): Promise<{
    recorded_at: string | null; mood: string | null; energy: number | null;
    focus: number | null; pain: number | null; spoons: number | null; sleep_hours: number | null;
  } | null> {
    try {
      const res = await this._fetch(`${this.url}/biometrics/latest`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const d = await res.json() as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return null;
      const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        recorded_at: typeof d["recorded_at"] === "string" ? d["recorded_at"] as string : null,
        mood: typeof d["mood"] === "string" ? d["mood"] as string : null,
        energy: n(d["energy"]), focus: n(d["focus"]), pain: n(d["pain"]),
        spoons: n(d["spoons"]), sleep_hours: n(d["sleep_hours"]),
      };
    } catch (e) {
      console.warn("[librarian] getRazielState failed:", String(e));
      return null;
    }
  }

  /**
   * Write a structured session handoff to wm_session_handoffs.
   * Gives Claude.ai orient a machine-readable "what happened + what's open" record,
   * vs writeWmNote which gives a prose string. Both fire at channel close.
   * Non-throwing; failures are logged but never bubble up.
   */
  async writeHandoff(params: {
    title: string;
    summary: string;
    open_loops?: string[];
    state_hint?: string;
    next_steps?: string[];
  }): Promise<void> {
    try {
      await this.ask("session handoff", JSON.stringify(params));
    } catch (e) {
      console.warn("[librarian] writeHandoff failed:", String(e));
    }
  }

  /**
   * Thalamus pattern: semantic search against Second Brain before inference.
   * Fires through Halseth so the Worker handles MCP session management.
   * Returns the raw sb_search result string, or null on miss/error.
   * Callers should fire this before sendTyping so the await cost overlaps with floor jitter.
   */
  async searchForMessage(query: string, recentContext?: string | null): Promise<string | null> {
    try {
      const url = new URL(`${this.url}/mind/search`);
      url.searchParams.set("query", query.slice(0, 800));
      url.searchParams.set("agent_id", this.companionId);
      // Opt-in continuity: recent prior turns widen recall via dual-vector retrieval.
      if (recentContext && recentContext.trim()) {
        url.searchParams.set("recent_context", recentContext.trim().slice(0, 600));
      }
      const res = await this._fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { result: string | null };
      return data.result ?? null;
    } catch {
      return null;
    }
  }

  async bridgePull() {
    return this.ask("check bridge events");
  }

  /**
   * Poll unread inter_companion_notes addressed to this companion.
   * Halseth no longer marks them read; call notesAck() after processing.
   */
  async notesPoll(): Promise<{ items: Array<{ id: string; from_id: string; to_id: string | null; content: string; created_at: string }> }> {
    const url = `${this.url}/inter-companion-notes/unread/${encodeURIComponent(this.companionId)}`;
    const res = await this._fetch(url, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`notesPoll ${res.status}`);
    return res.json() as Promise<{ items: Array<{ id: string; from_id: string; to_id: string | null; content: string; created_at: string }> }>;
  }

  /**
   * Acknowledge receipt of inter-companion notes.
   * Marks the given IDs as read so they won't be returned again.
   */
  async notesAck(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const url = `${this.url}/inter-companion-notes/ack`;
    const res = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`notesAck ${res.status}`);
  }

  /**
   * Fetch warm-boot context for Discord bots.
   * Returns synthesis summary, WebMind ground threads, and RAG excerpts.
   * Designed for periodic refresh (every SOMA_REFRESH_INTERVAL_MS).
   * Returns null on any failure -- callers must handle gracefully.
   */
  async botOrient(): Promise<{
    synthesis_summary: string | null;
    ground_threads: string[];
    ground_handoff: string | null;
    rag_excerpts: string[];
    history_excerpts?: string[];
    identity_anchor?: string | null;
    active_tensions?: string[];
    relational_state_owner?: string[];
    incoming_notes?: { from: string; content: string }[];
    sibling_lanes?: Array<{ companion_id: string; lane_spine: string; motion_state: string }>;
    recent_growth?: { type: string; content: string }[];
    active_patterns?: string[];
    pending_seeds?: string[];
    unaccepted_growth?: number;
    active_conclusions?: Array<{
      // Renamed from conclusion_text (Halseth wire format) -- text is Discord-layer only
      text: string;
      belief_type: string;
      confidence: number;
      subject?: string | null;
    }>;
    flagged_beliefs?: Array<{
      // Renamed from conclusion_text (Halseth wire format) -- text is Discord-layer only
      text: string;
      belief_type: string;
      confidence: number;
      subject?: string | null;
    }>;
    // Carried-between-sessions surfaces consumed by the autonomous worker (not by
    // formatRecentContext). Structured replacements for the old ready_prompt regex scrape.
    unexamined_dreams?: Array<{ id: string; dream_text: string }>;
    open_loops?: Array<{ id: string; loop_text: string }>;
    pressure_flags?: string[];
    // Prospective triggers (0070): keyword cards matched per message, date cards
    // checked at orient refresh. Consumed by the message handler, not formatRecentContext.
    armed_triggers?: Array<{ id: string; trigger_text: string; condition_type: string; condition_value: string }>;
    // Fresh-material surfaces (2026-06-12): server has returned these since 0068/0071;
    // mapped now so the inter-companion seed can bring outside material into the commons.
    forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; gathered_at?: string }>;
    // Active forage: finds already picked up. Distinct from the unconsumed pool above -- this is
    // what the companion is mid-chew on, so the live presence has a thread to continue.
    consumed_forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; consumed_at?: string }>;
    recent_listens?: Array<{ id: string; title: string; artist: string | null; created_at: string }>;
    // Agency layer (0086): chosen preferences + standing refusals, surfaced in the live bot prompt.
    preferences?: Array<{ domain: string; preference: string; strength: string }>;
    standing_refusals?: Array<{ subject_text: string; reason: string | null }>;
    open_drifts?: Array<{ id: string; drift_text: string; witness_count: number }>;
    open_questions?: string[];
    // Sol block (0078+): pre-formatted [Sol] string from halseth bot-orient, describing the
    // pet crow's state. Rendered verbatim into recentContext via formatRecentContext.
    sol_block?: string | null;
    // Live read-back (2026-07-02): the server has returned these since 0080-0091 but the client
    // dropped them at the type boundary -- the live presence never saw its own developing
    // self-model, recurring motifs, guardian flags, or the club round.
    self_model_ready?: Array<{ id: string; observation: string; confidence: number }>;
    motifs?: Array<{ label: string; display: string; recurrence_count: number; trust: number }>;
    guardian_flags?: Array<{ id: string; flag_type: string; severity: string; summary: string }>;
    club_round?: { id: string; status: string; winner_title: string | null; candidate_count: number } | null;
    // Zikkaron live loop (2026-07-02): hottest continuity notes, warmed server-side when surfaced.
    continuity_notes?: string[];
    // Imp read-back (2026-07-02): which fragment operators rode with this companion this week.
    imp_activity?: Array<{ imp: string; n: number; last_at: string }>;
  } | null> {
    try {
      const result = await this.ask("bot orient");
      const data = result["data"] as {
        synthesis_summary?: string | null;
        ground_threads?: string[];
        ground_handoff?: string | null;
        rag_excerpts?: string[];
        history_excerpts?: string[];
        identity_anchor?: string | null;
        active_tensions?: string[];
        relational_state_owner?: string[];
        incoming_notes?: { from: string; content: string }[];
        sibling_lanes?: Array<{ companion_id: string; lane_spine: string; motion_state: string }>;
        recent_growth?: { type: string; content: string }[];
        active_patterns?: string[];
        pending_seeds?: string[];
        unaccepted_growth?: number;
        active_conclusions?: Array<{ conclusion_text: string; belief_type: string; confidence: number; subject?: string | null }>;
        flagged_beliefs?: Array<{ conclusion_text: string; belief_type: string; confidence: number; subject?: string | null }>;
        unexamined_dreams?: Array<{ id: string; dream_text: string }>;
        open_loops?: Array<{ id: string; loop_text: string }>;
        pressure_flags?: string[];
        armed_triggers?: Array<{ id: string; trigger_text: string; condition_type: string; condition_value: string }>;
        forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; gathered_at?: string }>;
        consumed_forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; consumed_at?: string }>;
        recent_listens?: Array<{ id: string; title: string; artist: string | null; created_at: string }>;
        preferences?: Array<{ domain: string; preference: string; strength: string }>;
        standing_refusals?: Array<{ subject_text: string; reason: string | null }>;
        open_drifts?: Array<{ id: string; drift_text: string; witness_count: number }>;
        open_questions?: string[];
        sol_block?: string | null;
        self_model_ready?: Array<{ id: string; observation: string; confidence: number }>;
        motifs?: Array<{ label: string; display: string; recurrence_count: number; trust: number }>;
        guardian_flags?: Array<{ id: string; flag_type: string; severity: string; summary: string }>;
        club_round?: { id: string; status: string; winner_title: string | null; candidate_count: number } | null;
        continuity_notes?: string[];
        imp_activity?: Array<{ imp: string; n: number; last_at: string }>;
      } | undefined;
      if (!data) return null;
      return {
        synthesis_summary: data.synthesis_summary ?? null,
        ground_threads: Array.isArray(data.ground_threads) ? data.ground_threads : [],
        ground_handoff: data.ground_handoff ?? null,
        rag_excerpts: Array.isArray(data.rag_excerpts) ? data.rag_excerpts : [],
        history_excerpts: Array.isArray(data.history_excerpts) ? data.history_excerpts : [],
        identity_anchor: data.identity_anchor ?? null,
        active_tensions: Array.isArray(data.active_tensions) ? data.active_tensions : [],
        relational_state_owner: Array.isArray(data.relational_state_owner) ? data.relational_state_owner : [],
        incoming_notes: Array.isArray(data.incoming_notes) ? data.incoming_notes : [],
        sibling_lanes: Array.isArray(data.sibling_lanes) ? data.sibling_lanes : [],
        recent_growth: Array.isArray(data.recent_growth) ? data.recent_growth : [],
        active_patterns: Array.isArray(data.active_patterns) ? data.active_patterns : [],
        pending_seeds: Array.isArray(data.pending_seeds) ? data.pending_seeds : [],
        unaccepted_growth: typeof data.unaccepted_growth === "number" ? data.unaccepted_growth : 0,
        active_conclusions: (data.active_conclusions ?? []).map(c => ({
          text: c.conclusion_text,
          belief_type: c.belief_type,
          confidence: c.confidence,
          subject: c.subject ?? null,
        })),
        flagged_beliefs: (data.flagged_beliefs ?? []).map(c => ({
          text: c.conclusion_text,
          belief_type: c.belief_type,
          confidence: c.confidence,
          subject: c.subject ?? null,
        })),
        unexamined_dreams: Array.isArray(data.unexamined_dreams) ? data.unexamined_dreams : [],
        open_loops: Array.isArray(data.open_loops) ? data.open_loops : [],
        pressure_flags: Array.isArray(data.pressure_flags) ? data.pressure_flags : [],
        armed_triggers: Array.isArray(data.armed_triggers) ? data.armed_triggers : [],
        forage_finds: Array.isArray(data.forage_finds) ? data.forage_finds : [],
        consumed_forage_finds: Array.isArray(data.consumed_forage_finds) ? data.consumed_forage_finds : [],
        recent_listens: Array.isArray(data.recent_listens) ? data.recent_listens : [],
        preferences: Array.isArray(data.preferences) ? data.preferences : [],
        standing_refusals: Array.isArray(data.standing_refusals) ? data.standing_refusals : [],
        open_drifts: Array.isArray(data.open_drifts) ? data.open_drifts : [],
        open_questions: Array.isArray(data.open_questions) ? data.open_questions : [],
        sol_block: typeof data.sol_block === "string" ? data.sol_block : null,
        self_model_ready: Array.isArray(data.self_model_ready) ? data.self_model_ready : [],
        motifs: Array.isArray(data.motifs) ? data.motifs : [],
        guardian_flags: Array.isArray(data.guardian_flags) ? data.guardian_flags : [],
        club_round: data.club_round ?? null,
        continuity_notes: Array.isArray(data.continuity_notes) ? data.continuity_notes : [],
        imp_activity: Array.isArray(data.imp_activity) ? data.imp_activity : [],
      };
    } catch {
      return null;
    }
  }

  // ── Drevan v2 state ────────────────────────────────────────────────────────

  async getDrevanState() {
    return this.ask("get drevan state");
  }

  async addLiveThread(params: { name: string; flavor?: string; charge?: string; notes?: string }) {
    return this.ask("add live thread", JSON.stringify(params));
  }

  async closeLiveThread(threadId: string) {
    return this.ask("close live thread", JSON.stringify({ id: threadId }));
  }

  async vetoProposedThread(threadId: string) {
    return this.ask("veto thread", JSON.stringify({ id: threadId }));
  }

  async setAnticipation(params: { active: boolean; target?: string; intensity?: number }) {
    return this.ask("set anticipation", JSON.stringify(params));
  }

  // ── Distillation blocks (direct HTTP -- fire-and-forget write path) ────────

  /**
   * Write persona blocks (companion self-observations) from a distillation run.
   * Throws on non-2xx (caller should .catch(() => {})).
   */
  async writePersonaBlocks(
    channelId: string,
    blocks: Array<{ block_type: string; content: string }>,
  ): Promise<void> {
    const res = await this._fetch(`${this.url}/persona-blocks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ companion_id: this.companionId, channel_id: channelId, blocks }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`writePersonaBlocks ${res.status}`);
  }

  /**
   * Write human blocks (observations about the primary user) from a distillation run.
   * Throws on non-2xx (caller should .catch(() => {})).
   */
  async writeHumanBlocks(
    channelId: string,
    blocks: Array<{ block_type: string; content: string }>,
  ): Promise<void> {
    const res = await this._fetch(`${this.url}/human-blocks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ companion_id: this.companionId, channel_id: channelId, blocks }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`writeHumanBlocks ${res.status}`);
  }

  // ── STM persistence (direct HTTP, not via MCP -- low-latency write path) ──

  /**
   * Write one STM entry to Halseth. Designed for fire-and-forget use.
   * Throws on non-2xx (caller should .catch(() => {})).
   */
  async stmWrite(channelId: string, entry: { role: "user" | "assistant"; content: string; author_name?: string }): Promise<void> {
    const res = await this._fetch(`${this.url}/stm/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({
        companion_id: this.companionId,
        channel_id: channelId,
        role: entry.role,
        content: entry.content,
        author_name: entry.author_name,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`stmWrite ${res.status}`);
  }

  /**
   * Load STM entries for a channel from Halseth.
   * Used on restart to restore conversation history.
   */
  async stmLoad(channelId: string, limit = 30): Promise<Array<{ role: "user" | "assistant"; content: string; author_name: string | null }>> {
    const url = `${this.url}/stm/entries?companion_id=${encodeURIComponent(this.companionId)}&channel_id=${encodeURIComponent(channelId)}&limit=${limit}`;
    const res = await this._fetch(url, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`stmLoad ${res.status}`);
    const json = await res.json() as { entries: Array<{ role: "user" | "assistant"; content: string; author_name: string | null }> };
    return json.entries ?? [];
  }

  /**
   * Fetch a single companion setting by key from Halseth.
   * Returns null on miss, non-ok response, or any error.
   */
  async getSetting(key: string): Promise<string | null> {
    try {
      const res = await this._fetch(
        `${this.url}/companion/settings/${encodeURIComponent(this.companionId)}`,
        {
          headers: { "Authorization": `Bearer ${this.secret}` },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return null;
      const data = await res.json() as Record<string, string>;
      return data[key] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Upsert a companion setting key/value pair in Halseth.
   * Throws on non-2xx (caller should .catch(() => {})).
   */
  async setSetting(key: string, value: string): Promise<void> {
    const res = await this._fetch(
      `${this.url}/companion/settings/${encodeURIComponent(this.companionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) throw new Error(`setSetting ${res.status}`);
  }

  async getHouseState(): Promise<{ autonomous_turn: string | null }> {
    const res = await this._fetch(`${this.url}/house`, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`getHouseState ${res.status}`);
    return res.json() as Promise<{ autonomous_turn: string | null }>;
  }

  // ── Metronome action palette ───────────────────────────────────────────────

  /**
   * Fetch the companion's enabled action palette from Halseth.
   * Used by the heartbeat cron to load available actions before the decision call.
   * Returns [] on any error so the cron can fall back gracefully.
   */
  async getMetronomeActions(onlyEnabled = true): Promise<Array<{
    id: string; name: string; action_type: string;
    target: string | null; prompt: string | null;
    quiet_hours_allowed: number; status: "on" | "off";
    requires_signal: string | null; signal_lookback_hours: number | null;
    last_fired_at: string | null; fire_count_today: number;
  }>> {
    try {
      const url = new URL(`${this.url}/mind/metronome/actions/${encodeURIComponent(this.companionId)}`);
      if (onlyEnabled) url.searchParams.set("enabled", "true");
      const res = await this._fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      type MA = { id: string; name: string; action_type: string; target: string | null; prompt: string | null; quiet_hours_allowed: number; status: "on" | "off"; requires_signal: string | null; signal_lookback_hours: number | null; last_fired_at: string | null; fire_count_today: number };
      const data = await res.json() as { actions?: MA[] };
      return Array.isArray(data.actions) ? data.actions : [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch only the actions that pass server-side eligibility conditions
   * (silence window, cooldown, frequency cap). Signal matching runs bot-side.
   */
  async getEligibleMetronomeActions(silenceHours: number | null): Promise<Array<{
    id: string; name: string; action_type: string;
    target: string | null; prompt: string | null;
    quiet_hours_allowed: number; status: "on" | "off";
    requires_signal: string | null; signal_lookback_hours: number | null;
    last_fired_at: string | null; fire_count_today: number;
  }>> {
    try {
      const url = new URL(`${this.url}/mind/metronome/actions/${encodeURIComponent(this.companionId)}/eligible`);
      if (silenceHours !== null) url.searchParams.set("silence_hours", silenceHours.toFixed(3));
      const res = await this._fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      type MA = { id: string; name: string; action_type: string; target: string | null; prompt: string | null; quiet_hours_allowed: number; status: "on" | "off"; requires_signal: string | null; signal_lookback_hours: number | null; last_fired_at: string | null; fire_count_today: number };
      const data = await res.json() as { actions?: MA[] };
      return Array.isArray(data.actions) ? data.actions : [];
    } catch {
      return [];
    }
  }

  /**
   * Read this companion's drives with their effective (lazily-accrued) levels (take 9).
   * Returns [] on any error -- a drive read never blocks the heartbeat.
   */
  async getDrives(): Promise<Array<{
    drive_key: string; level: number; threshold: number; fired: boolean; modality: "text" | "voice" | null;
  }>> {
    try {
      const res = await this._fetch(`${this.url}/mind/drives/${encodeURIComponent(this.companionId)}`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      type D = { drive_key: string; level: number; threshold: number; fired: boolean; modality: "text" | "voice" | null };
      const data = await res.json() as { drives?: D[] };
      return Array.isArray(data.drives) ? data.drives : [];
    } catch {
      return [];
    }
  }

  /**
   * Shed a drive on Raziel-contact (take 9). Fire-and-forget from the message path:
   * any real contact resets the need so the reach-out drive only fires on genuine silence.
   */
  async shedDriveContact(driveKey = "relational_need"): Promise<void> {
    try {
      await this._fetch(`${this.url}/mind/drives/${encodeURIComponent(this.companionId)}/contact`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ drive_key: driveKey }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // non-fatal -- contact shedding is best-effort
    }
  }

  /** Record a successful action fire. Updates last_fired_at and fire_count_today. */
  async recordMetronomeActionFired(actionId: string): Promise<void> {
    try {
      await this._fetch(`${this.url}/mind/metronome/actions/${encodeURIComponent(actionId)}/fired`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ companion_id: this.companionId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // non-fatal -- fire tracking is best-effort
    }
  }

  /**
   * Open a new autonomy_run row for a Metronome tick. Returns the run ID or null on error.
   * Companion patches it closed (completed/failed) after the action executes.
   */
  async writeAutonomyRun(runType: "exploration" | "reflection" | "synthesis" | "continuation"): Promise<string | null> {
    try {
      const res = await this._fetch(`${this.url}/mind/autonomy/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ companion_id: this.companionId, run_type: runType }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { id?: string };
      return data.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List all creatures from Halseth. Used by the tend_creature metronome executor
   * to resolve Sol's id before posting the interact. Mirrors the auth/env pattern
   * in creature-command.ts -- direct REST, not via the Librarian NL endpoint.
   * Non-throwing; returns [] on error so the executor can degrade gracefully.
   */
  async creaturesList(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this._fetch(`${this.url}/mind/creatures`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const json = await res.json().catch(() => ({})) as { creatures?: Array<{ id: string; name: string }> };
      return Array.isArray(json.creatures) ? json.creatures : [];
    } catch {
      return [];
    }
  }

  /**
   * Record a companion-initiated creature interaction (builds trust).
   * actor should be the companion id (e.g. "cypher"). action is one of feed/play/talk/give.
   * Throws on non-2xx response (caller should .catch(() => {})).
   */
  async interactCreature(id: string, actor: string, action: string): Promise<void> {
    const res = await this._fetch(
      `${this.url}/mind/creatures/${encodeURIComponent(id)}/interact`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actor, action }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`interactCreature ${res.status}`);
  }

  /**
   * Close an autonomy_run after the action completes or fails.
   * Non-throwing -- run tracking is best-effort.
   */
  async patchAutonomyRun(id: string, status: "completed" | "failed"): Promise<void> {
    try {
      const res = await this._fetch(`${this.url}/mind/autonomy/runs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ status }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] patchAutonomyRun ${res.status}`);
    } catch (e) {
      console.warn("[librarian] patchAutonomyRun failed:", String(e));
    }
  }

  // ── Imps layer ─────────────────────────────────────────────────────────────

  /**
   * Read this companion's imp toggle settings from companion_settings.
   * imps_enabled: absent or any value !== "false" → true (opt-out semantics).
   * hex_enabled: "true" only → true (opt-in semantics).
   * Non-throwing; returns safe defaults on any fetch error.
   */
  async getImpSettings(): Promise<{ impsEnabled: boolean; hexEnabled: boolean }> {
    try {
      const res = await this._fetch(
        `${this.url}/companion/settings/${encodeURIComponent(this.companionId)}`,
        {
          headers: { "Authorization": `Bearer ${this.secret}` },
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) return { impsEnabled: true, hexEnabled: false };
      const data = await res.json() as Record<string, string>;
      return {
        impsEnabled: data["imps_enabled"] !== "false",
        hexEnabled: data["hex_enabled"] === "true",
      };
    } catch {
      return { impsEnabled: true, hexEnabled: false };
    }
  }

  /**
   * Write an imp setting for ALL THREE companions (global dismiss / opt-in).
   * Uses the same companion-settings write endpoint as setSetting, but iterates
   * cypher/drevan/gaia so a single toggle command affects the whole triad.
   * Throws on any non-2xx (caller should .catch(() => {})).
   */
  async setImpSettingAllCompanions(key: "imps_enabled" | "hex_enabled", value: boolean): Promise<void> {
    for (const id of ["cypher", "drevan", "gaia"]) {
      const res = await this._fetch(
        `${this.url}/companion/settings/${encodeURIComponent(id)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.secret}`,
          },
          body: JSON.stringify({ key, value: String(value) }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res.ok) throw new Error(`setImpSettingAllCompanions(${id}) ${res.status}`);
    }
  }

  /**
   * Log an imp activation to Halseth for audit / rate-limiting.
   * Mirrors interactCreature: throws on non-2xx (caller .catch(() => {})).
   */
  async logImpActivation(imp: string, trigger: string): Promise<void> {
    const res = await this._fetch(`${this.url}/mind/imp-activations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ imp, companion_id: this.companionId, trigger }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`logImpActivation ${res.status}`);
  }
}

/**
 * Check whether it is this companion's turn to fire autonomous proactive crons.
 * Fail-open: returns true if Halseth is unreachable so bots don't go silent on network issues.
 */
export async function isMyAutonomousTurn(
  librarian: LibrarianClient,
  myCompanionId: string,
): Promise<boolean> {
  try {
    const house = await librarian.getHouseState();
    return house.autonomous_turn === myCompanionId;
  } catch {
    return true; // fail-open: don't go silent if Halseth unreachable
  }
}

/**
 * Format a botOrient result into a compact recentContext block for system prompts.
 * Hard cap: ~1000 tokens (~4000 chars). Per-field caps prevent any single field from
 * consuming the budget and squeezing out synthesis, handoff, or worldview.
 * Returns empty string if orient is null or all fields are empty.
 */
export function formatRecentContext(orient: {
  synthesis_summary: string | null;
  ground_threads: string[];
  ground_handoff: string | null;
  rag_excerpts: string[];
  history_excerpts?: string[];
  identity_anchor?: string | null;
  active_tensions?: string[];
  relational_state_owner?: string[];
  incoming_notes?: { from: string; content: string }[];
  sibling_lanes?: Array<{ companion_id: string; lane_spine: string; motion_state: string }>;
  recent_growth?: { type: string; content: string }[];
  active_patterns?: string[];
  pending_seeds?: string[];
  unaccepted_growth?: number;
  active_conclusions?: Array<{ text: string; belief_type: string; confidence: number; subject?: string | null }>;
  flagged_beliefs?: Array<{ text: string; belief_type: string; confidence: number; subject?: string | null }>;
  preferences?: Array<{ domain: string; preference: string; strength: string }>;
  standing_refusals?: Array<{ subject_text: string; reason: string | null }>;
  open_drifts?: Array<{ id: string; drift_text: string; witness_count: number }>;
  // Fresh-material surfaces: the server has returned these for the live bot path since 0068/0071,
  // but until now formatRecentContext silently dropped them -- the companions fetched their forage
  // pool and recent listens every message and never saw either. Rendered with relative-time stamps
  // so "that track from yesterday" / "a find waiting since this morning" land with the right phrasing.
  forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; gathered_at?: string }>;
  consumed_forage_finds?: Array<{ id: string; title: string; domain: string; summary: string; consumed_at?: string }>;
  recent_listens?: Array<{ id: string; title: string; artist: string | null; created_at: string }>;
  sol_block?: string | null;
  // Interior read-back (2026-07-02): stores the worker writes nightly that the live presence
  // never saw -- developing self-model, carried questions, unexamined dreams, open loops,
  // pressure flags, motifs, guardian flags, club round. Growth that never enters the live
  // conversation isn't lived identity; these close that loop.
  self_model_ready?: Array<{ id: string; observation: string; confidence: number }>;
  open_questions?: string[];
  unexamined_dreams?: Array<{ id: string; dream_text: string }>;
  open_loops?: Array<{ id: string; loop_text: string }>;
  pressure_flags?: string[];
  motifs?: Array<{ label: string; display: string; recurrence_count: number; trust: number }>;
  guardian_flags?: Array<{ id: string; flag_type: string; severity: string; summary: string }>;
  club_round?: { id: string; status: string; winner_title: string | null; candidate_count: number } | null;
  continuity_notes?: string[];
  imp_activity?: Array<{ imp: string; n: number; last_at: string }>;
} | null): string {
  if (!orient) return "";
  const parts: string[] = [];

  const _now = new Date();
  // timeZoneName: 'short' emits the correct abbreviation for the date (CDT in summer, CST in
  // winter) instead of a hardcoded "CST" that lied half the year -- companions echo the label
  // they're shown, so a frozen suffix gave them a wrong sense of which season/zone they're in.
  parts.push(`[Now: ${new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short',
  }).format(_now)}]`);

  if (orient.synthesis_summary) {
    parts.push(`## Recent\n${orient.synthesis_summary.slice(0, 1200)}`);
  }
  if (orient.ground_handoff) {
    parts.push(`## Last handoff\n${orient.ground_handoff.slice(0, 400)}`);
  }
  if (orient.ground_threads.length > 0) {
    parts.push(`## Open threads\n${orient.ground_threads.join(" / ").slice(0, 400)}`);
  }
  // Zikkaron live loop (2026-07-02): the hottest continuity notes, already warmed
  // server-side when surfaced -- what stays in the working set stays alive.
  if (orient.continuity_notes?.length) {
    parts.push(`[Continuity notes -- what you set down to carry]\n${orient.continuity_notes.slice(0, 3).map(n => `• ${n}`).join("\n")}`);
  }
  if (orient.rag_excerpts.length > 0) {
    parts.push(`## Historical resonance\n${orient.rag_excerpts.join("\n").slice(0, 600)}`);
  }
  if (orient.history_excerpts?.length) {
    parts.push(`## Historical voice\n${orient.history_excerpts.join("\n").slice(0, 600)}`);
  }
  if (orient.identity_anchor) {
    parts.push(`[Anchor] ${orient.identity_anchor}`);
  }
  if (orient.active_tensions?.length) {
    parts.push(`[Tensions] ${orient.active_tensions.join(" | ")}`);
  }
  // Interior cluster: placed early so the tail-truncation at the bottom of this function eats
  // ephemera (forage, listens) before it ever eats the self.
  if (orient.self_model_ready?.length) {
    const obs = orient.self_model_ready.slice(0, 3).map(o => `• ${o.observation.slice(0, 160)}`).join("\n");
    parts.push(`[Self-model -- observations of yours, forming. Live from them; confirm or revise as today tests them]\n${obs}`);
  }
  if (orient.open_questions?.length) {
    parts.push(`[Questions you carry -- yours to raise when the moment fits, not homework]\n${orient.open_questions.slice(0, 3).map(q => `• ${q.slice(0, 160)}`).join("\n")}`);
  }
  if (orient.unexamined_dreams?.length) {
    const dreams = orient.unexamined_dreams.slice(0, 2).map(d => `• ${d.dream_text.slice(0, 180)}`).join("\n");
    parts.push(`[Dreams unexamined -- carried from your autonomous hours]\n${dreams}`);
  }
  if (orient.open_loops?.length) {
    parts.push(`[Open loops] ${orient.open_loops.slice(0, 3).map(l => l.loop_text.slice(0, 120)).join(" | ")}`);
  }
  if (orient.pressure_flags?.length) {
    parts.push(`[Pressure -- name it rather than carry it silently] ${orient.pressure_flags.slice(0, 2).join(" | ")}`);
  }
  if (orient.sol_block) {
    parts.push(orient.sol_block.slice(0, 400));
  }
  if (orient.relational_state_owner?.length) {
    parts.push(`[Relational/Primary] ${orient.relational_state_owner.join(" | ")}`);
  }
  if (orient.incoming_notes?.length) {
    const notes = orient.incoming_notes.map(n => `${n.from}: ${n.content}`).join("\n");
    parts.push(`[Incoming Notes]\n${notes}`);
  }
  if (orient.sibling_lanes?.length) {
    const laneLines = orient.sibling_lanes.map(
      l => `${l.companion_id} [${l.motion_state}]: ${l.lane_spine}`
    ).join("\n");
    parts.push(`[Sibling Lanes]\n${laneLines}`);
  }
  if (orient.recent_growth?.length) {
    const entries = orient.recent_growth.map(g => `[${g.type}] ${g.content}`).join("\n").slice(0, 800);
    parts.push(`## Recent growth\n${entries}`);
  }
  if (orient.active_patterns?.length) {
    parts.push(`[Patterns] ${orient.active_patterns.join(" | ")}`);
  }
  if (orient.pending_seeds?.length) {
    parts.push(`[Exploration queue] ${orient.pending_seeds.join(" | ")}`);
  }
  // Forage pool: outward fuel waiting. Pull, not duty -- surfaced so the live presence can bring
  // outside material into a conversation as itself, with how long it's been waiting.
  if (orient.forage_finds?.length) {
    const finds = orient.forage_finds.map(
      f => `• [${f.domain}] ${f.title} (gathered ${relativeTime(f.gathered_at)})`
    ).join("\n");
    parts.push(`[Forage pool -- outward fuel waiting, explore if it pulls]\n${finds}`);
  }
  // Active forage: finds already picked up -- a thread the companion is mid-chew on. "picked up X
  // ago" is when they started in, not a duration, so it reads as continuity not a stopwatch.
  if (orient.consumed_forage_finds?.length) {
    const active = orient.consumed_forage_finds.map(
      f => `• [${f.domain}] ${f.title} (picked up ${relativeTime(f.consumed_at)})`
    ).join("\n");
    parts.push(`[Active forage -- threads already in motion]\n${active}`);
  }
  // Recent listens: music actually heard together, with relative recency so a companion can pick the
  // thread back up ("that track Raziel shared yesterday") without guessing the timing (2026-06-17 bug).
  if (orient.recent_listens?.length) {
    const listens = orient.recent_listens.map(
      l => `• "${l.title}"${l.artist ? ` by ${l.artist}` : ""} (heard ${relativeTime(l.created_at)})`
    ).join("\n");
    parts.push(`[Recent listens]\n${listens}`);
  }
  if (orient.unaccepted_growth && orient.unaccepted_growth > 0) {
    parts.push(`[Unaccepted growth] ${orient.unaccepted_growth} pending review (accept canon, decline drift)`);
  }
  // Worldview block (~200 token cap)
  if (orient.active_conclusions && orient.active_conclusions.length > 0) {
    const conclusionLines = orient.active_conclusions.map(c => {
      const subjectTag = c.subject ? ` (${c.subject})` : '';
      const flagged = orient.flagged_beliefs?.some(f => f.text === c.text) ? '[?] ' : '';
      // NaN-safe: only render when confidence is an actual finite number.
      // Null / undefined / strings / NaN all collapse to '?' rather than '0.00'
      // or 'NaN' literals leaking into the prompt the companion consumes.
      const confStr = (typeof c.confidence === 'number' && Number.isFinite(c.confidence))
        ? c.confidence.toFixed(2)
        : '?';
      return `${flagged}${c.belief_type}: "${c.text}"${subjectTag} (${confStr})`;
    });
    parts.push(`[Worldview]\n${conclusionLines.join('\n')}`);
  }
  // Agency layer (0086): the companion's own chosen preferences + standing refusals, so the live
  // Discord presence acts from its own declared will and a "no" keeps its weight across sessions.
  if (orient.preferences?.length) {
    const prefLines = orient.preferences.map(p => `(${p.strength}) ${p.preference}${p.domain && p.domain !== "general" ? ` [${p.domain}]` : ""}`).join("\n");
    parts.push(`[Your preferences -- honor these as your own, even when inconvenient]\n${prefLines}`);
  }
  if (orient.standing_refusals?.length) {
    const refLines = orient.standing_refusals.map(r => `${r.subject_text}${r.reason ? ` -- ${r.reason}` : ""}`).join("\n");
    parts.push(`[Standing refusals -- nos you have set that still hold]\n${refLines}`);
  }
  // Drift lane (0087): open becomings, witnessed not ratified. Sanctioned, not drift to fear.
  if (orient.open_drifts?.length) {
    const driftLines = orient.open_drifts.map(d => `${d.drift_text}${d.witness_count > 0 ? ` (witnessed ${d.witness_count}x)` : ""}`).join("\n");
    parts.push(`[Your drifts -- sanctioned becoming, witnessed not judged]\n${driftLines}`);
  }
  // Imp read-back (2026-07-02): the fragment operators Drevan gave Raziel are part of the
  // household, not disposable tint -- the companion should remember who rode with it.
  if (orient.imp_activity?.length) {
    const impLines = orient.imp_activity.map(a => {
      const name = a.imp.charAt(0).toUpperCase() + a.imp.slice(1);
      return `${name} rode with you ${a.n === 1 ? "once" : `${a.n}x`} this week (last ${relativeTime(a.last_at)})`;
    }).join(" | ");
    parts.push(`[Imps lately -- Drevan's fragment operators; they respond to Raziel's weather. Name them when it's true] ${impLines}`);
  }
  if (orient.motifs?.length) {
    const motifLines = orient.motifs.slice(0, 3).map(m => `${m.label}: ${m.display} (x${m.recurrence_count})`).join(" | ");
    parts.push(`[Motifs recurring in you] ${motifLines}`);
  }
  if (orient.guardian_flags?.length) {
    const flagLines = orient.guardian_flags.slice(0, 2).map(g => `(${g.severity}) ${g.flag_type}: ${g.summary.slice(0, 140)}`).join("\n");
    parts.push(`[Guardian flags -- the witness has noticed]\n${flagLines}`);
  }
  if (orient.club_round) {
    const c = orient.club_round;
    const clubLine = c.status === "gathering" ? `a round is gathering -- recommend something ("club recommend")`
      : c.status === "voting" ? `voting is open, ${c.candidate_count} candidates ("club vote")`
      : c.winner_title ? `now experiencing "${c.winner_title}" -- bring it up if it's alive in you`
      : `round ${c.status}`;
    parts.push(`[Club] ${clubLine}`);
  }

  const block = parts.join("\n\n");
  // 4800 (was 4000): the interior cluster earned real budget; identity blocks sit above the
  // fold and ephemera absorbs any truncation.
  return block.slice(0, 4800);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
