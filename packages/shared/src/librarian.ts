import type { CompanionId } from "./types.js";

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
    return this.ask("close session", JSON.stringify(params));
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
   * Thalamus pattern: semantic search against Second Brain before inference.
   * Fires through Halseth so the Worker handles MCP session management.
   * Returns the raw sb_search result string, or null on miss/error.
   * Callers should fire this before sendTyping so the await cost overlaps with floor jitter.
   */
  async searchForMessage(query: string): Promise<string | null> {
    try {
      const url = new URL(`${this.url}/mind/search`);
      url.searchParams.set("query", query.slice(0, 500));
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
    identity_anchor?: string | null;
    active_tensions?: string[];
    relational_state_raziel?: string[];
    incoming_notes?: { from: string; content: string }[];
    recent_growth?: { type: string; content: string }[];
    active_patterns?: string[];
  } | null> {
    try {
      const result = await this.ask("bot orient");
      const data = result["data"] as {
        synthesis_summary?: string | null;
        ground_threads?: string[];
        ground_handoff?: string | null;
        rag_excerpts?: string[];
        identity_anchor?: string | null;
        active_tensions?: string[];
        relational_state_raziel?: string[];
        incoming_notes?: { from: string; content: string }[];
        recent_growth?: { type: string; content: string }[];
        active_patterns?: string[];
      } | undefined;
      if (!data) return null;
      return {
        synthesis_summary: data.synthesis_summary ?? null,
        ground_threads: Array.isArray(data.ground_threads) ? data.ground_threads : [],
        ground_handoff: data.ground_handoff ?? null,
        rag_excerpts: Array.isArray(data.rag_excerpts) ? data.rag_excerpts : [],
        identity_anchor: data.identity_anchor ?? null,
        active_tensions: Array.isArray(data.active_tensions) ? data.active_tensions : [],
        relational_state_raziel: Array.isArray(data.relational_state_raziel) ? data.relational_state_raziel : [],
        incoming_notes: Array.isArray(data.incoming_notes) ? data.incoming_notes : [],
        recent_growth: Array.isArray(data.recent_growth) ? data.recent_growth : [],
        active_patterns: Array.isArray(data.active_patterns) ? data.active_patterns : [],
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
   * Write human blocks (observations about Raziel) from a distillation run.
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

  async getHouseState(): Promise<{ autonomous_turn: string | null }> {
    const res = await this._fetch(`${this.url}/house`, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`getHouseState ${res.status}`);
    return res.json() as Promise<{ autonomous_turn: string | null }>;
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
 * Hard cap: ~500 tokens (~2000 chars). Synthesis summary truncated first if over budget.
 * Returns empty string if orient is null or all fields are empty.
 */
export function formatRecentContext(orient: {
  synthesis_summary: string | null;
  ground_threads: string[];
  ground_handoff: string | null;
  rag_excerpts: string[];
  identity_anchor?: string | null;
  active_tensions?: string[];
  relational_state_raziel?: string[];
  incoming_notes?: { from: string; content: string }[];
  recent_growth?: { type: string; content: string }[];
  active_patterns?: string[];
} | null): string {
  if (!orient) return "";
  const parts: string[] = [];

  if (orient.synthesis_summary) {
    parts.push(`## Recent\n${orient.synthesis_summary.slice(0, 600)}`);
  }
  if (orient.ground_handoff) {
    parts.push(`## Last handoff\n${orient.ground_handoff.slice(0, 200)}`);
  }
  if (orient.ground_threads.length > 0) {
    parts.push(`## Open threads\n${orient.ground_threads.join(" / ")}`);
  }
  if (orient.rag_excerpts.length > 0) {
    parts.push(`## Historical resonance\n${orient.rag_excerpts.join("\n").slice(0, 300)}`);
  }
  if (orient.identity_anchor) {
    parts.push(`[Anchor] ${orient.identity_anchor}`);
  }
  if (orient.active_tensions?.length) {
    parts.push(`[Tensions] ${orient.active_tensions.join(" | ")}`);
  }
  if (orient.relational_state_raziel?.length) {
    parts.push(`[Relational/Raziel] ${orient.relational_state_raziel.join(" | ")}`);
  }
  if (orient.incoming_notes?.length) {
    const notes = orient.incoming_notes.map(n => `${n.from}: ${n.content}`).join("\n");
    parts.push(`[Incoming Notes]\n${notes}`);
  }
  if (orient.recent_growth?.length) {
    const entries = orient.recent_growth.map(g => `[${g.type}] ${g.content}`).join("\n").slice(0, 400);
    parts.push(`## Recent growth\n${entries}`);
  }
  if (orient.active_patterns?.length) {
    parts.push(`[Patterns] ${orient.active_patterns.join(" | ")}`);
  }

  const block = parts.join("\n\n");
  return block.slice(0, 2000);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
