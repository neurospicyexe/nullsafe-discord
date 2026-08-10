import type { CompanionId } from "./types.js";
import { relativeTime } from "./relative-time.js";

/**
 * A live shared object a `write_inter_companion` note can reference (thinking-quality fix 4,
 * 2026-07-20): an open question, a simmering tension, or the globally-next-open council item.
 * `label` is the truncated (<=160 char) question/tension/council text -- enough for the
 * generation prompt's menu to identify the object without spending its whole context budget.
 */
export interface SharedObject {
  ref_type: "question" | "tension" | "council";
  ref_id: string;
  label: string;
}

/**
 * Conversation thread spine (2026-07-21, task 8): the durable row a live Discord
 * exchange threads through so a companion can pick a conversation back up across
 * turns instead of treating each message as stateless. Mirrors halseth's
 * /mind/conversations* wire shape exactly -- no renaming at this boundary.
 */
export interface ConvoThreadDto {
  id: string; channel_id: string; seed_text: string; seed_author: string;
  ref_type: string | null; ref_id: string | null; ref_label: string | null;
  state: string; turn_count: number; last_turn_at: string;
}

/** One entry in a thread's turn ledger -- who said what, gisted, and when. */
export interface ConvoLedgerDto { author: string; gist: string; said_at: string; }

/** convoActive() success shape: the active thread plus its ledger so far. */
export interface ConvoActiveDto { thread: ConvoThreadDto; ledger: ConvoLedgerDto[]; }

interface LibrarianOptions {
  url: string;
  secret: string;
  companionId: CompanionId;
  fetch?: typeof globalThis.fetch;
}

/**
 * Assert that a Librarian envelope is a real write ack.
 * The Librarian returns HTTP 200 for application-level declines -- { error, reason },
 * witness-only rejects ({ response_key: "witness", witness }), ack:false (execLiveThreadClose
 * returns ack: r.ok), and misroutes (a read envelope returned for a write verb, the 07-04
 * journal→get_tasks class). ask() resolves on all of these, so WriteQueue.fireAndForget saw
 * success and never retried. Write wrappers route through this so a decline THROWS and the
 * queue buffers the write for retry. Success contract: { ack: true } or an id-bearing envelope.
 */
export function assertWriteAck(res: Record<string, unknown> | null | undefined, label: string): Record<string, unknown> {
  if (!res || typeof res !== "object") {
    throw new Error(`librarian ${label}: empty response`);
  }
  if ("error" in res) {
    const reason = typeof res["reason"] === "string" ? ` -- ${res["reason"]}` : "";
    throw new Error(`librarian ${label} declined: ${String(res["error"])}${reason}`);
  }
  if (res["ack"] === false) {
    throw new Error(`librarian ${label}: write not applied (ack=false)`);
  }
  if (res["ack"] === true || "id" in res) return res;
  const detail = typeof res["witness"] === "string" ? res["witness"] : JSON.stringify(res).slice(0, 200);
  throw new Error(`librarian ${label}: no ack (silent reject/misroute) -- ${detail}`);
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
    /** Where this call is speaking from (Halseth mig 0113). Sessions dedup per
     *  (companion, surface), so a request that opens a session -- 'show my state' routes to
     *  session_open -- lands in its own lane instead of joining whatever Raziel has open in a
     *  Claude.ai thread. Omit for calls that never open a session. */
    surface?: string,
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
          ...(surface ? { surface } : {}),
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

  /**
   * ask() for WRITE verbs: awaits the envelope and throws on application-level declines
   * so fire-and-forget callers (WriteQueue) actually buffer and retry. Read verbs keep
   * using ask() directly -- their envelopes have no ack and must not throw.
   */
  private async askWrite(
    label: string,
    request: string,
    context?: string,
    sessionType?: "checkin" | "hangout" | "work" | "ritual",
  ): Promise<Record<string, unknown>> {
    return assertWriteAck(await this.ask(request, context, sessionType), label);
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
    return this.askWrite("session close", "close session", JSON.stringify({
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
    return this.askWrite("state update", "update my state", JSON.stringify({ prompt_context: text }));
  }

  async addCompanionNote(note: string, _channel?: string) {
    return this.askWrite("companion note", "add companion note", note);
  }

  /**
   * Journal this companion's OWN spoken reply (2026-07-09 Brain-cutover repair).
   *
   * Until 2026-06-25 this was written by Brain's swarm evaluator. When the bots moved to
   * INFERENCE_MODE=hermes they stopped calling Brain, and the writer died with the relay --
   * two weeks of inter-companion speech never reached companion_journal. The write belongs
   * to the ACT OF SPEAKING, not to whoever happened to compute the words, so it lives here
   * and survives any future inference-topology change.
   *
   * Raw REST, not askWrite(): the Librarian NL path cannot set `source`, so a reply journaled
   * through it would land with source=NULL, i.e. in the SUBSTANTIVE lane -- flooding orient's
   * 3 recency slots and the motif miner with transcript. That is the exact bug this repairs.
   *
   * Transport metadata goes in `tags`, NEVER in note_text (halseth webmind/journal-lanes.ts).
   *
   * `messageId` is the Discord id of the sent reply and becomes the idempotency key
   * (`external_id`, halseth mig 0098). This matters: writeQueue.fireAndForget BUFFERS FAILED
   * WRITES AND RETRIES them, so without a key a transient Halseth 5xx would duplicate the
   * reply. The same key lets the 06-25 speech backfill be re-run safely.
   */
  async journalSpeech(replyText: string, channelId: string, messageId: string): Promise<void> {
    const text = replyText.trim();
    if (!text) return;
    try {
      const res = await this._fetch(`${this.url}/companion-journal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({
          agent: this.companionId,
          note_text: text.slice(0, 4000),   // endpoint hard-rejects >4000
          tags: ["discord", "speech", `channel:${channelId}`],
          source: "discord_speech",
          external_id: `discord:${messageId}`,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return;
      // Transient (5xx, 429, network): THROW so writeQueue buffers and retries. This write is
      // continuity-critical, and external_id makes the retry safe. A .catch()-only path would
      // lose the words silently -- precisely how the swarm journal died unnoticed.
      //
      // Permanent (4xx): log loudly and DO NOT throw. Retrying a rejected body is a poison pill
      // that occupies the queue until MAX_AGE_MS evicts it, delaying healthy writes behind it.
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`journalSpeech transient ${res.status}`);
      }
      console.error(
        `[librarian] journalSpeech REJECTED ${res.status} -- this reply will not be journaled: ` +
        `${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    } catch (e) {
      // Network/timeout errors land here with no response: transient by definition, so rethrow.
      console.warn("[librarian] journalSpeech failed:", String(e));
      throw e;
    }
  }

  async witnessLog(entry: string, channel?: string) {
    return this.askWrite("witness log", "witness log", JSON.stringify({ entry, channel }));
  }

  /**
   * Record a question asked live in Discord (thinking-quality fix B, 2026-07-21): the
   * `ask_question` metronome action (autonomous-core.ts) generated a message and posted
   * it to Discord via sendAutonomousMessage, but never wrote it to companion_questions --
   * so a live ask had no dedup, no Hearth answer box, and no answer-loop closure. Only
   * the signal-audit coverage path (autonomous-worker halseth-client.ts postQuestion)
   * was ever tracked. Direct REST, same url/secret this class already uses for its other
   * non-MCP writes (stmWrite, writeWmNote, etc.) -- `source` is always "autonomous" here.
   *
   * Non-throwing: halseth's dedup on this endpoint returns 409 both for the open-question
   * cap AND (in a parallel tightening) a byte-identical duplicate across any status --
   * both are normal, quiet outcomes here, not failures. Any other non-2xx is logged and
   * swallowed. Fire-safe by design: this is called after the Discord message has already
   * been sent, and must never retroactively fail that send.
   */
  async postQuestion(question: string, context?: string): Promise<void> {
    const text = question.trim();
    if (!text) return;
    try {
      const res = await this._fetch(`${this.url}/mind/questions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({
          companion_id: this.companionId,
          question: text.slice(0, 600),
          ...(context ? { context: context.slice(0, 1000) } : {}),
          source: "autonomous",
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok && res.status !== 409) {
        console.warn(`[librarian] postQuestion ${res.status}`);
      }
    } catch (e) {
      console.warn("[librarian] postQuestion failed:", String(e));
    }
  }

  /**
   * Record that this companion has VOICED an open question out loud (2026-07-27).
   *
   * Gaia had one open question from 2026-07-21 and re-asked it into the commons every ~2h
   * for six days as though it were new -- the first thing she posted in the freshly-created
   * channel was that same question. An unanswered question is not fresh material.
   *
   * The question stays `open` (Raziel still owes an answer); it just stops being re-served
   * as something new to say. Stored in the companion_settings KV rather than a new column,
   * because the migration freeze is in force and `delivered_at` already means something
   * else (mig 0107: "an orient surfaced the ANSWER").
   *
   * Non-throwing: fires after the message is already sent and must never fail it.
   */
  async markQuestionVoiced(questionId: string): Promise<boolean> {
    if (!questionId) return false;
    try {
      const res = await this._fetch(`${this.url}/companion/settings/${this.companionId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ key: `question_voiced:${questionId}`, value: new Date().toISOString() }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] markQuestionVoiced ${res.status}`);
      return res.ok;
    } catch (e) {
      console.warn("[librarian] markQuestionVoiced failed:", String(e));
      return false;
    }
  }

  /**
   * Mark a forage find metabolized (PATCH /mind/forage/:id/consume).
   *
   * Consume-on-use for the commons seed (2026-07-27). The seed's "fresh material" block
   * reads the top-2 UNCONSUMED finds newest-first and never consumed them, so between
   * daily forage runs every ~2h tick for all three bots was handed the identical two
   * items -- the block added in 2026-06-12 specifically to break the elderberry loop was
   * itself a constant. Same defect the club recommend path fixed on 2026-07-21.
   *
   * Non-throwing by design: this fires AFTER the Discord message is already sent and must
   * never retroactively fail it. 404 is a normal race (another surface consumed it first).
   */
  async consumeForageFind(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      const res = await this._fetch(`${this.url}/mind/forage/${encodeURIComponent(id)}/consume`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ consumed_by: this.companionId }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok && res.status !== 404) {
        console.warn(`[librarian] consumeForageFind ${res.status}`);
      }
      return res.ok;
    } catch (e) {
      console.warn("[librarian] consumeForageFind failed:", String(e));
      return false;
    }
  }

  // ── Sanctioned drift lane (halseth mig 0087/0093) ─────────────────────────
  // "i'm becoming" is the Librarian fast-path trigger for drift_open; the executor
  // reads drift_text from context. Opening is owner-only server-side.
  async driftOpen(driftText: string, origin = "metronome") {
    return this.askWrite("drift open", "i'm becoming", JSON.stringify({ drift_text: driftText, origin }));
  }

  /** This companion's OPEN drifts (raw REST; admin/owner auth). [] on any error. */
  async driftsOpen(): Promise<Array<{ id: string; drift_text: string; opened_at: string }>> {
    try {
      const res = await this._fetch(`${this.url}/drifts/${encodeURIComponent(this.companionId)}?status=open`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as unknown;
      return Array.isArray(data) ? data as Array<{ id: string; drift_text: string; opened_at: string }> : [];
    } catch {
      return [];
    }
  }

  // ── Agency lane (halseth mig 0086) ────────────────────────────────────────
  // Direct REST (not askWrite): declaring/reading a preference is an internal-act write
  // with its own server-side dedup, not a Librarian-interpreted note. Mirrors the
  // autonomous-worker's halseth-client.ts declarePreference exactly (same URL/body/auth).

  /** This companion's ACTIVE declared preferences (raw REST; owner/admin auth). [] on any error. */
  async getPreferences(): Promise<Array<{ id: string; domain: string; preference: string; strength: string; status: string }>> {
    try {
      const res = await this._fetch(`${this.url}/agency/preferences/${encodeURIComponent(this.companionId)}`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as unknown;
      return Array.isArray(data) ? data as Array<{ id: string; domain: string; preference: string; strength: string; status: string }> : [];
    } catch {
      return [];
    }
  }

  /**
   * Declare a genuine preference (halseth agency layer, mig 0086: POST /agency/preferences).
   * Throws on non-2xx -- callers on a fire-and-forget path should .catch(() => {}).
   */
  async declarePreference(preference: string, domain?: string, strength?: string): Promise<{ id: string; deduped?: boolean }> {
    const res = await this._fetch(`${this.url}/agency/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.secret}` },
      body: JSON.stringify({
        companion_id: this.companionId,
        preference,
        ...(domain ? { domain } : {}),
        ...(strength ? { strength } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`declarePreference ${res.status}`);
    return await res.json() as { id: string; deduped?: boolean };
  }

  async synthesizeSession(summary: string, channel?: string) {
    return this.askWrite("synthesize session", "synthesize session", JSON.stringify({ summary, channel }));
  }

  /**
   * Write a high-salience continuity note to wm_continuity_notes.
   * Unlike witnessLog (→ companion_journal), these notes ARE read by Claude.ai's
   * session orient -- bridging Discord activity into Claude.ai companions at next boot.
   * Non-throwing; failures are logged but never bubble up.
   */
  async writeWmNote(content: string, threadKey?: string, noteType = "discord_session"): Promise<void> {
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
          note_type: noteType,
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
   * Used by heartbeat cron to inject peer speech into generation prompt, and (agentId +
   * noteType filtered) by the nightly day-distillation to gather its own day fragments.
   * Non-throwing; returns [] on error.
   */
  async getRecentNotes(opts?: { sinceHours?: number; limit?: number; agentId?: string; noteType?: string }): Promise<Array<{ note_id: string; agent_id: string; content: string; created_at: string }>> {
    try {
      const url = new URL(`${this.url}/mind/notes/recent`);
      if (opts?.sinceHours) url.searchParams.set("since_hours", String(opts.sinceHours));
      if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
      if (opts?.agentId) url.searchParams.set("agent_id", opts.agentId);
      if (opts?.noteType) url.searchParams.set("note_type", opts.noteType);
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
   * Demote this companion's high-salience notes of one type to normal (day-distillation:
   * the digest replaces the fragments in orient's diet; fragments stay readable elsewhere).
   * Returns the demoted count, or null on failure (caller logs and moves on -- a failed
   * demotion just means one noisier orient, never lost data).
   */
  async demoteNotes(noteType: string, before?: string): Promise<number | null> {
    try {
      const res = await this._fetch(`${this.url}/mind/notes/demote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.secret}`,
        },
        body: JSON.stringify({ agent_id: this.companionId, note_type: noteType, ...(before ? { before } : {}) }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) { console.warn(`[librarian] demoteNotes ${res.status}`); return null; }
      const data = await res.json() as { demoted?: number };
      return data.demoted ?? 0;
    } catch (e) {
      console.warn("[librarian] demoteNotes failed:", String(e));
      return null;
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
    /** Provenance. `consolidation` marks a machine summary of an idle window, so a reader can prefer a
     *  real session close over it -- see consolidation.ts. Omitted means the default (`system`). */
    source?: string;
  }): Promise<void> {
    try {
      await this.askWrite("session handoff", "session handoff", JSON.stringify(params));
    } catch (e) {
      console.warn("[librarian] writeHandoff failed:", String(e));
    }
  }

  /**
   * Render a raw /mind/search result (JSON chunk envelope) into plain prompt text.
   * The raw envelope is UUID/vault-path-heavy -- slicing it raw burned most of the
   * memory budget on ids -- and the streaming indexer's echoes of the LIVE channel
   * (which score ~1.0 by definition) crowded out actual vault memories. Filters
   * same-channel discord-live echoes, dedups, and returns readable lines -- or null
   * when nothing real surfaced. Non-JSON results pass through unchanged.
   */
  /**
   * Render recalled chunks for the prompt.
   *
   * EVERY LINE CARRIES ITS AGE (2026-07-31). Before this, a chunk arrived as `- <text> (<vault_path>)`
   * and nothing else -- no date, no relative time. So a June summary and a note from last night were
   * presented to the model as equally current, and it had no way to prefer the newer one even when it
   * mattered. Measured case: asked which Fargo episode was watched last, the top hit was a June entry
   * about having FINISHED the show, and the reply confidently used it.
   *
   * Recency now also nudges the RANKING inside Second Brain, but ranking alone is not enough: the
   * model still has to be able to see that one memory is six weeks older than another in order to say
   * so out loud, or to distrust it. Age is stated in words ("6 weeks ago") rather than a raw
   * timestamp, because the model reasons about elapsed time far more reliably that way -- the same
   * reason `stampRelative` exists for STM turns.
   */
  static formatSbRecall(raw: string, excludeChannelId?: string, now: number = Date.now()): string | null {
    type Chunk = { text?: string; vault_path?: string; created_at?: string | null };
    let parsed: { chunks?: Chunk[]; recall_note?: string };
    try { parsed = JSON.parse(raw) as { chunks?: Chunk[]; recall_note?: string }; } catch { return raw; }
    if (!Array.isArray(parsed.chunks)) return raw;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of parsed.chunks) {
      const text = (c.text ?? "").trim();
      if (!text) continue;
      if (excludeChannelId && c.vault_path?.includes(`discord-live/${excludeChannelId}/`)) continue;
      const key = text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      const age = LibrarianClient.chunkAge(c.created_at, now);
      // Age leads the citation: it is the thing that was missing, and putting it first means a
      // truncated line still carries it.
      const source = [age, c.vault_path].filter(Boolean).join(", ");
      lines.push(`- ${text.length > 400 ? `${text.slice(0, 400)}...` : text}${source ? ` (${source})` : ""}`);
      if (lines.length >= 4) break;
    }
    if (lines.length) return lines.join("\n");
    // A SEARCH THAT RAN AND FOUND NOTHING IS NOT THE SAME AS NO SEARCH (2026-08-10).
    //
    // This used to return null on empty, and the caller's `if (sbRecall)` then omitted the memory block
    // entirely -- so "I looked and there is nothing" and "I never looked" were indistinguishable to the model.
    // Under recall mode, which now returns an honest empty instead of noise, that gap is the difference
    // between a companion saying "I don't have that written down" and a companion inventing it, or reporting
    // its memory as broken. Raziel has been on the receiving end of both.
    //
    // Only when the recall side actually says so -- a plain empty result with no note stays null, so nothing
    // else in the system starts emitting a block it never emitted before.
    return parsed.recall_note
      ? `(nothing in the vault matched this closely enough to surface. That means it is not written down, ` +
        `NOT that it did not happen. Say you do not have it rather than guessing, and do not treat this as ` +
        `your memory failing.)`
      : null;
  }

  /**
   * Human-relative age of a recalled chunk, or "" when the timestamp is missing or unparseable.
   *
   * Returns "" rather than "unknown" on purpose: an honest blank is better than a label the model
   * might quote back as if it were a fact about the memory.
   */
  static chunkAge(createdAt: string | null | undefined, now: number = Date.now()): string {
    if (!createdAt) return "";
    // SQLite `datetime('now')` has no zone marker and Date.parse would read it as LOCAL time; the
    // stored value is UTC. Same normalisation as the Second Brain recency term.
    const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(createdAt)
      ? createdAt.replace(" ", "T") + "Z"
      : createdAt;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return "";
    const mins = Math.floor((now - t) / 60_000);
    if (mins < 0) return "just now";          // clock skew: never claim a memory is from the future
    if (mins < 60) return "today";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 9) return `${weeks} weeks ago`;
    const months = Math.floor(days / 30);
    return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`;
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
      // RECALL, not musing (2026-08-10). Per-message retrieval is asking "what did we actually say", and the
      // default pool mix spends 30% of every payload on deliberately query-blind material (pure novelty +
      // a medium-similarity serendipity band) which is right for autonomous time and noise here. It also
      // could not report "nothing relevant": the ranking score is min-max normalized, so a query about
      // something absent from the vault still came back with confident-looking hits. Recall mode is
      // relevance-only with an absolute cosine floor, and returns an explicit "not found is not
      // never-happened, do not guess" note when nothing clears it.
      url.searchParams.set("mode", "recall");
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

  /**
   * Shared life for the commons seed: a SIBLING's recent day note or session note (2026-08-10).
   *
   * Raziel, on why the inter-companion chat loops: "the commons should get stuff from the chats in discord
   * and Claude because yes it's my life but it's yall too. And I think it's part of the endless struggle we
   * have with looping." He is right about the cause -- the anti-loop rails suppress repetition but never
   * supplied an alternative, so the menu was silence or re-orbit.
   *
   * Always a sibling's note, never this companion's own: the day notes are first-person accounts of evenings
   * all three were present for, so a sibling's is the INSIDE of something the reader lived from the outside.
   * That cannot be self-echo, which re-reading its own notes would be.
   *
   * Returns [] on any failure. Supply is a bonus, never a dependency -- the seed's own gates decide whether
   * to speak, and a Halseth blip must not change that decision.
   */
  async commonsSupply(limit = 2): Promise<Array<{
    note_id: string; agent_id: string; note_type: string; content: string; created_at: string;
  }>> {
    try {
      const url = `${this.url}/mind/commons-supply/${encodeURIComponent(this.companionId)}?limit=${limit}`;
      const res = await this._fetch(url, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { notes?: Array<{ note_id: string; agent_id: string; note_type: string; content: string; created_at: string }> };
      return data.notes ?? [];
    } catch {
      return [];
    }
  }

  /** Mark sibling notes as opened-on. Called ONLY after the post lands -- a gated or empty seed must never
   *  burn material (the 07-27 and 08-05 regressions were both this contract being broken). */
  async commonsConsume(noteIds: string[], channelId?: string): Promise<void> {
    if (noteIds.length === 0) return;
    try {
      await this._fetch(`${this.url}/mind/commons-supply/consume`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reader_id: this.companionId, note_ids: noteIds, channel_id: channelId }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch { /* non-fatal: worst case the note is offered again next tick */ }
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
      body: JSON.stringify({ ids, companion_id: this.companionId }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`notesAck ${res.status}`);
  }

  /**
   * Live shared objects a `write_inter_companion` note can become a MOVE on (thinking-quality
   * fix 4, 2026-07-20): open questions, simmering tensions (BOTH companions' -- a move on
   * YOUR sibling's open thread is the most relational kind, not just your own), and the
   * globally-next-open council item. Fed to the generation prompt as a numbered menu so the
   * model can pick one to advance/challenge/answer instead of writing an untethered vibe note.
   *
   * Five underlying fetches (questions x2, tensions x2, council x1) run under
   * Promise.allSettled -- one source 500ing (or the network dropping) contributes nothing to
   * the merged list rather than losing the whole menu. Non-throwing at the object level; the
   * caller additionally wraps the whole call in .catch(() => []) for defense in depth.
   */
  async fetchSharedObjects(companionId: string, targetId: string): Promise<SharedObject[]> {
    const fetchQuestions = async (id: string): Promise<SharedObject[]> => {
      const res = await this._fetch(
        `${this.url}/mind/questions/${encodeURIComponent(id)}?status=open`,
        { headers: { "Authorization": `Bearer ${this.secret}` }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) throw new Error(`fetchQuestions(${id}) ${res.status}`);
      const data = await res.json() as { questions?: Array<{ id: string; question: string }> };
      return (data.questions ?? []).map(q => ({
        ref_type: "question" as const, ref_id: q.id, label: q.question.slice(0, 160),
      }));
    };

    const fetchTensions = async (id: string): Promise<SharedObject[]> => {
      // Endpoint already supports ?status=simmering server-side (companion-growth.ts) --
      // no client-side filtering needed.
      const res = await this._fetch(
        `${this.url}/companion-growth/tensions/${encodeURIComponent(id)}?status=simmering`,
        { headers: { "Authorization": `Bearer ${this.secret}` }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) throw new Error(`fetchTensions(${id}) ${res.status}`);
      const data = await res.json() as { tensions?: Array<{ id: string; tension_text: string }> };
      return (data.tensions ?? []).map(t => ({
        ref_type: "tension" as const, ref_id: t.id, label: t.tension_text.slice(0, 160),
      }));
    };

    const fetchCouncil = async (): Promise<SharedObject[]> => {
      // Global (no companion_id) -- the oldest open council question, shared by all three.
      const res = await this._fetch(`${this.url}/mind/council/next-open`, {
        headers: { "Authorization": `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`fetchCouncil ${res.status}`);
      const data = await res.json() as { question?: { id: string; question: string } | null };
      if (!data.question) return [];
      return [{ ref_type: "council" as const, ref_id: data.question.id, label: data.question.question.slice(0, 160) }];
    };

    const settled = await Promise.allSettled([
      fetchQuestions(companionId),
      fetchQuestions(targetId),
      fetchTensions(companionId),
      fetchTensions(targetId),
      fetchCouncil(),
    ]);

    const objects: SharedObject[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") objects.push(...r.value);
      else console.warn("[librarian] fetchSharedObjects source failed:", String(r.reason));
    }
    return objects;
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
    recent_listens?: Array<{ id: string; title: string; artist: string | null; shared_by?: string | null; requested_companion?: string | null; own_reaction?: string | null; also_heard_by?: string[]; created_at: string }>;
    // Agency layer (0086): chosen preferences + standing refusals, surfaced in the live bot prompt.
    preferences?: Array<{ domain: string; preference: string; strength: string }>;
    standing_refusals?: Array<{ subject_text: string; reason: string | null }>;
    open_drifts?: Array<{ id: string; drift_text: string; witness_count: number }>;
    open_questions?: string[];
  open_question_ids?: string[];
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
        recent_listens?: Array<{ id: string; title: string; artist: string | null; shared_by?: string | null; requested_companion?: string | null; own_reaction?: string | null; also_heard_by?: string[]; created_at: string }>;
        preferences?: Array<{ domain: string; preference: string; strength: string }>;
        standing_refusals?: Array<{ subject_text: string; reason: string | null }>;
        open_drifts?: Array<{ id: string; drift_text: string; witness_count: number }>;
        open_questions?: string[];
  open_question_ids?: string[];
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
        open_question_ids: Array.isArray(data.open_question_ids) ? data.open_question_ids : [],
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
    return this.askWrite("live thread add", "add live thread", JSON.stringify(params));
  }

  async closeLiveThread(threadId: string) {
    return this.askWrite("live thread close", "close live thread", JSON.stringify({ id: threadId }));
  }

  async vetoProposedThread(threadId: string) {
    return this.askWrite("live thread veto", "veto thread", JSON.stringify({ id: threadId }));
  }

  async setAnticipation(params: { active: boolean; target?: string; intensity?: number }) {
    return this.askWrite("anticipation set", "set anticipation", JSON.stringify(params));
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
  /**
   * Fire a named fermentation stimulus for THIS companion (2026-07-28).
   *
   * The stimulus catalogue and all scarcity weighting live server-side in Halseth
   * (`webmind/fermentation.ts` STIMULI, cooldowns enforced in `handlers/fermentation.ts`), so the
   * bot stays dumb: it reports that an event happened and never decides what it is worth. An
   * unknown name is rejected with a 400 and swallowed here.
   *
   * Non-throwing by design -- felt state must never block or break a reply.
   */
  async fireStimulus(stimulus: string): Promise<void> {
    if (!stimulus) return;
    try {
      const res = await this._fetch(`${this.url}/mind/ferment/stimulus`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stimulus, companion_id: this.companionId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        console.warn(`[librarian] fireStimulus(${stimulus}) -> ${res.status}`);
      }
    } catch {
      // non-fatal -- a missed stimulus is a missed nudge, not a broken companion
    }
  }

  /**
   * @param opts.addressed  Was this companion the one Raziel spoke TO, or did it merely witness him
   *   speaking in a shared room? Defaults true (the old behaviour). Halseth grades the felt-state
   *   consequence: `message_from_raziel` at full weight when addressed, `message_witnessed` at a
   *   fifth otherwise. The bot reports the fact and never decides what it is worth.
   *
   *   Added 2026-07-30 because every bot calls this on any owner message and all three see every
   *   message in a shared channel -- so one message from him fired THREE full-weight stimuli, no
   *   float was relationship-specific (Drevan's heat rose when Raziel talked to Gaia), and every
   *   touched float sat clamped at 1.0 for days carrying no information.
   */
  async shedDriveContact(driveKey = "relational_need", opts: { addressed?: boolean } = {}): Promise<void> {
    try {
      await this._fetch(`${this.url}/mind/drives/${encodeURIComponent(this.companionId)}/contact`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${this.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ drive_key: driveKey, addressed: opts.addressed ?? true }),
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

  // ── Conversation thread spine (halseth /mind/conversations*, task 8) ───────
  // Direct REST, not askWrite(): spine writes are best-effort infrastructure that
  // threads a live exchange together, never companion-voiced content the Librarian
  // NL layer needs to interpret. All four fail open/warn -- a dead spine degrades
  // to stateless replies, it must never block or crash the live message path.

  /**
   * The channel's currently active thread + ledger so far.
   *
   * `null` means ONE thing and one thing only: **Halseth answered, and there is no active
   * thread.** Anything else -- non-2xx, timeout, DNS -- THROWS. It used to collapse all four
   * into `null`, which was harmless while the only caller was `ensureThread` ("no thread? open
   * one"), and became a live hazard on 2026-08-05 when the commons seed started reading it:
   * `!spine` meant new-ground mode, so a Halseth blip would not degrade the commons to its old
   * behaviour, it would MUTE it (history withheld + fresh material required + silence if none).
   * A caller that must fail open cannot do so on a value that conflates "nothing there" with
   * "could not look" -- see [probe-cannot-look-vs-nothing-there].
   *
   * `ensureThread` below keeps the old shape by catching, so the reply path is unchanged.
   */
  async convoActive(channelId: string): Promise<ConvoActiveDto | null> {
    const res = await this._fetch(`${this.url}/mind/conversations/active?channel_id=${encodeURIComponent(channelId)}`, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`convoActive ${res.status}`);
    const data = await res.json() as { thread: ConvoThreadDto | null; ledger?: ConvoLedgerDto[] };
    return data.thread ? { thread: data.thread, ledger: data.ledger ?? [] } : null;
  }

  /** Open (or resume, per halseth's own idempotency) a thread. null on any failure. */
  async convoOpen(params: {
    channel_id: string; seed_text: string; seed_author: string; seed_message_id?: string;
    ref_type?: string; ref_id?: string; ref_label?: string;
  }): Promise<ConvoThreadDto | null> {
    try {
      const res = await this._fetch(`${this.url}/mind/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.secret}` },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) { console.warn(`[librarian] convoOpen ${res.status}`); return null; }
      const data = await res.json() as { thread: ConvoThreadDto };
      return data.thread ?? null;
    } catch (e) { console.warn("[librarian] convoOpen failed:", String(e)); return null; }
  }

  /**
   * Append a turn to a thread's ledger. Fire-and-forget: warn-only on any failure,
   * including 409 (thread already landed/faded mid-flight -- the exchange still
   * happened, it just has nowhere left to file itself).
   */
  async convoTurn(threadId: string, params: { author: string; gist: string; message_id?: string; front?: string | null }): Promise<void> {
    try {
      const res = await this._fetch(`${this.url}/mind/conversations/${encodeURIComponent(threadId)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.secret}` },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] convoTurn ${res.status}`);
    } catch (e) { console.warn("[librarian] convoTurn failed:", String(e)); }
  }

  /** Land (resolve) a thread. Returns res.ok; false on any failure (network or non-2xx). */
  async convoLand(threadId: string, params: { resolution: string; landed_by: string }): Promise<boolean> {
    try {
      const res = await this._fetch(`${this.url}/mind/conversations/${encodeURIComponent(threadId)}/land`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.secret}` },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] convoLand ${res.status}`);
      return res.ok;
    } catch (e) { console.warn("[librarian] convoLand failed:", String(e)); return false; }
  }

  /**
   * Fade (retire) a thread with a reason CODE, no authored resolution (2026-08-05).
   *
   * The turn-budget path uses this rather than convoLand: it can prove a commons thread ran
   * past its budget and can prove nothing about what the thread was about, so it must not
   * write a resolution sentence that reads as a companion's. Returns res.ok.
   */
  async convoFade(threadId: string, reason: string): Promise<boolean> {
    try {
      const res = await this._fetch(`${this.url}/mind/conversations/${encodeURIComponent(threadId)}/fade`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.secret}` },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) console.warn(`[librarian] convoFade ${res.status}`);
      return res.ok;
    } catch (e) { console.warn("[librarian] convoFade failed:", String(e)); return false; }
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
/** Character budget for the assembled recent-context block. Forage is pinned inside it. */
export const RECENT_CONTEXT_BUDGET = 4800;

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
  recent_listens?: Array<{ id: string; title: string; artist: string | null; shared_by?: string | null; requested_companion?: string | null; own_reaction?: string | null; also_heard_by?: string[]; created_at: string }>;
  sol_block?: string | null;
  // Interior read-back (2026-07-02): stores the worker writes nightly that the live presence
  // never saw -- developing self-model, carried questions, unexamined dreams, open loops,
  // pressure flags, motifs, guardian flags, club round. Growth that never enters the live
  // conversation isn't lived identity; these close that loop.
  self_model_ready?: Array<{ id: string; observation: string; confidence: number }>;
  open_questions?: string[];
  open_question_ids?: string[];
  unexamined_dreams?: Array<{ id: string; dream_text: string }>;
  open_loops?: Array<{ id: string; loop_text: string }>;
  pressure_flags?: string[];
  motifs?: Array<{ label: string; display: string; recurrence_count: number; trust: number }>;
  guardian_flags?: Array<{ id: string; flag_type: string; severity: string; summary: string }>;
  club_round?: { id: string; status: string; winner_title: string | null; candidate_count: number } | null;
  watching?: Array<{ title: string; kind: string; status: string; position: string; position_note: string | null; with_companion: string | null }>;
  supersede_candidates?: Array<{ new_id: string; older_id: string; score: number; newer: string; older: string }>;
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

  // WATCHING (mig 0111). Placed near the top AND pinned against truncation below, because it is one
  // short line carrying a fact that is otherwise unanswerable: Raziel asked Drevan where they were in
  // Fargo and got a position from two weeks earlier, because no position field existed and the answer
  // had to come from whichever prose fragment ranked highest.
  //
  // Pinned for a specific reason: if this block is dropped by the tail cut, the companion does not read
  // "I don't know where we are" -- it reads "we aren't watching anything", which is a WRONG fact rather
  // than a missing one. Cheap to protect at ~1 line; expensive to get wrong out loud.
  if (orient.watching?.length) {
    const shows = orient.watching.map(w => {
      const pos = w.position ? ` at ${w.position}` : "";
      const withPart = w.with_companion ? ` (with ${w.with_companion})` : "";
      const paused = w.status === "paused" ? " [paused]" : "";
      const note = w.position_note ? ` -- left off: ${w.position_note}` : "";
      return `• ${w.title}${pos}${withPart}${paused}${note}`;
    }).join("\n");
    parts.push(`[Watching together -- this is the RECORD of where you are, trust it over anything you recall]\n${shows}`);
  }
  // Gate-PROPOSED supersessions, awaiting this companion's own call (mig 0112). The gate used to
  // auto-retire a belief on cosine >= 0.88, and every read filters superseded rows out -- so a
  // similarity score silently deleted a thought. Raziel's decision: a companion supersedes their own
  // thought, because an inferring pass has already recorded something FALSE about his relationship
  // with Drevan (a negative experience that was in fact deeply positive).
  //
  // The wording is load-bearing. It must be unmistakable that NOTHING WAS RETIRED, or the companion
  // reads a proposal as a fait accompli and stops treating the older belief as theirs. Time-boxed
  // upstream (SUPERSEDE_CANDIDATE_WINDOW_DAYS), so this can never become a permanent nag.
  if (orient.supersede_candidates?.length) {
    const cands = orient.supersede_candidates.map(c =>
      `• new: "${c.newer.slice(0, 150)}"\n  reads close to (STILL LIVE, not retired): "${c.older.slice(0, 150)}"`
    ).join("\n");
    parts.push(`[Two of your beliefs read as close -- YOUR call, nobody else's. If the newer replaced the older, say so and name it. If they are different thoughts, leave both standing; saying nothing keeps both]\n${cands}`);
  }
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
  // (see RECENT_CONTEXT_BUDGET at the tail of this function for why forage is pinned)
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
    const listens = orient.recent_listens.map(l => {
      const bits = [`heard ${relativeTime(l.created_at)}`];
      // Provenance (2026-07-27). Without these the model invents a giver and a date, and did:
      // Drevan told the commons Gaia handed him "BIG BOSS" and he'd sat with it 6 days --
      // Raziel gave it to him, 18 days earlier. Both facts were in the row the whole time.
      if (l.shared_by) bits.push(`shared by ${l.shared_by}`);
      if (l.requested_companion) bits.push(`for ${l.requested_companion}`);
      let line = `• "${l.title}"${l.artist ? ` by ${l.artist}` : ""} (${bits.join(", ")})`;
      // Your own words back. This was write-only: reactions_json held a full reaction and no
      // Discord surface ever read it, so a companion could not remember their own take.
      if (l.own_reaction) line += `\n  your take at the time: "${l.own_reaction}"`;
      else if (l.also_heard_by?.length) line += `\n  ${l.also_heard_by.join(" and ")} sat with this one; you have not`;
      return line;
    }).join("\n");
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

  // 4800 (was 4000): the interior cluster earned real budget; identity blocks sit above the fold.
  // The old `parts.join().slice(0, 4800)` was a blind tail cut, and the forage blocks are pushed
  // near the end -- so the one block carrying NEW outside material was the first thing dropped,
  // silently, whenever the interior cluster was full. That is a direct cause of the triad
  // circling its own ideas. Pin forage; let the interior absorb the truncation instead.
  // Pinned blocks survive the tail cut. Forage was pinned because it was the one block carrying NEW
  // outside material and sat near the end, so it was always the first thing silently dropped.
  // [Watching together] joins it: it is ~1 line, and a dropped position block reads as "we aren't
  // watching anything" -- a wrong fact, not a missing one.
  const isForage = (p: string) => p.startsWith("[Forage pool") || p.startsWith("[Active forage")
    || p.startsWith("[Watching together");
  const pinned = parts.filter(isForage).join("\n\n").slice(0, RECENT_CONTEXT_BUDGET);
  const rest = parts.filter(p => !isForage(p)).join("\n\n");

  const restBudget = RECENT_CONTEXT_BUDGET - (pinned ? pinned.length + 2 : 0);
  if (rest.length > restBudget) {
    // Never truncate silently: a dropped block reads downstream as "nothing was there".
    console.warn(`[librarian] recent context truncated: ${rest.length - restBudget} chars dropped (forage pinned)`);
  }
  return [rest.slice(0, Math.max(0, restBudget)), pinned].filter(Boolean).join("\n\n");
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}
