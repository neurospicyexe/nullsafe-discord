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

  async addCompanionNote(note: string, channel?: string) {
    return this.ask("add companion note", JSON.stringify({ note, channel }));
  }

  async witnessLog(entry: string, channel?: string) {
    return this.ask("witness log", JSON.stringify({ entry, channel }));
  }

  async synthesizeSession(summary: string, channel?: string) {
    return this.ask("synthesize session", JSON.stringify({ summary, channel }));
  }

  async bridgePull() {
    return this.ask("check bridge events");
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
    });
    if (!res.ok) throw new Error(`stmLoad ${res.status}`);
    const json = await res.json() as { entries: Array<{ role: "user" | "assistant"; content: string; author_name: string | null }> };
    return json.entries ?? [];
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
