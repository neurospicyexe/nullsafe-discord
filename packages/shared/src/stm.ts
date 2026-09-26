// packages/shared/src/stm.ts
//
// STM (short-term memory) store for Discord bot conversation persistence.
//
// Context window budget (documented here, enforced by slice in each bot):
//   Fixed overhead:  ~1,500 tokens
//   LTM retrieval:   up to 200,000 tokens
//   STM:             ~50,000 tokens (~250 messages at ~200 tokens each)
//   Output buffer:   ~8,000 tokens
//
// STM_BUFFER_SIZE is how many messages we store in memory + DB.
// Each bot trims to its own CONTEXT_WINDOW_SIZE when calling inference.
// Keeping the buffer larger than CONTEXT_WINDOW_SIZE means restarts recover
// more context than a single inference window -- useful for reconnecting.

import type { ChatMessage } from "./types.js";
import type { WriteQueue } from "./write-queue.js";
import { APPEND_MAX_AGE_MS } from "./write-queue.js";

export const STM_BUFFER_SIZE = 100;

export class StmStore {
  private memory = new Map<string, ChatMessage[]>();
  // Channels we've attempted a DB load for (prevents redundant loads on restart)
  private loaded = new Set<string>();
  /** Message ids already recorded inbound, so appendInboundOnce can collapse duplicate calls.
   *  Insertion-ordered and evicted oldest-first; see appendInboundOnce for why it is bounded. */
  private seenInbound = new Set<string>();

  constructor(
    private companionId: string,
    private writeFn: (channelId: string, entry: ChatMessage) => Promise<void>,
    private loadFn:  (channelId: string) => Promise<ChatMessage[]>,
    private writeQueue?: WriteQueue,
  ) {}

  /** True if we've attempted a load for this channel (loaded or empty) */
  isLoaded(channelId: string): boolean {
    return this.loaded.has(channelId);
  }

  /** Returns current in-memory history for a channel */
  get(channelId: string): ChatMessage[] {
    return this.memory.get(channelId) ?? [];
  }

  /**
   * Ensures the channel's history is loaded from DB before first use.
   * Call once per channel on first incoming message.
   * If DB is empty and discordFallback is provided, uses that instead.
   * Fails silently -- worst case the bot starts with empty context.
   */
  async ensureLoaded(
    channelId: string,
    discordFallback?: () => Promise<ChatMessage[]>,
  ): Promise<void> {
    if (this.loaded.has(channelId)) return;
    this.loaded.add(channelId);

    try {
      const entries = await this.loadFn(channelId);
      if (entries.length > 0) {
        this.memory.set(channelId, entries);
        return;
      }
    } catch { /* fail-silent -- DB unavailable is acceptable */ }

    if (discordFallback) {
      try {
        const entries = await discordFallback();
        if (entries.length > 0) this.memory.set(channelId, entries);
      } catch { /* fail-silent */ }
    }
  }

  /**
   * Append an INBOUND message exactly once, keyed on its Discord message id.
   *
   * WHY (2026-07-30): the inbound append used to sit BELOW every response gate in the message
   * handler (line ~899, gates return at 817/833/875/878/880). So a bot that declined to answer never
   * recorded the message at all -- its short-term memory had holes exactly where it stayed quiet, and
   * it only remembered the parts of the conversation it had participated in.
   *
   * That is the same defect the Hermes multi-agent issue (#14853) hit from the other side: with
   * require_mention on, "the agent only sees the single @mention message -- zero context about what
   * other agents said." Their fix was to inject channel history at prompt time. Ours is to stop
   * throwing it away at read time, which is strictly better -- the record is speaker-labeled and
   * persisted rather than re-fetched and re-derived per reply.
   *
   * It is also the PRECONDITION for fit-based speaker selection. A companion cannot judge "is this
   * for me" from a view containing only its own turns; asking it to was why a name had to be said
   * out loud on every message.
   *
   * Idempotent by message id so the early call and any later call collapse to one row -- the command
   * paths (search, listen) append the same message on their own branches, and making this safe by
   * construction beats auditing every branch for double-appends now and forever.
   */
  appendInboundOnce(channelId: string, messageId: string, message: ChatMessage): void {
    if (this.seenInbound.has(messageId)) return;
    this.seenInbound.add(messageId);
    // Bounded: a Set that only grows is a leak in a long-lived process. 2x the buffer is ample --
    // a message older than that is already off the end of the window it protects.
    if (this.seenInbound.size > STM_BUFFER_SIZE * 2) {
      const first = this.seenInbound.values().next();
      if (!first.done) this.seenInbound.delete(first.value);
    }
    this.append(channelId, message);
  }

  /**
   * Appends a message to memory and fire-and-forgets a DB write.
   * Buffer is trimmed to STM_BUFFER_SIZE to prevent unbounded growth.
   */
  append(channelId: string, message: ChatMessage): void {
    const history = this.memory.get(channelId) ?? [];
    history.push(message);
    if (history.length > STM_BUFFER_SIZE) history.shift();
    this.memory.set(channelId, history);
    this.loaded.add(channelId);

    // Fire-and-forget with retry buffer if WriteQueue is available
    if (this.writeQueue) {
      this.writeQueue.fireAndForget(
        `stm:${channelId}`,
        () => this.writeFn(channelId, message),
        // Append-shaped: a chat turn 40 minutes late still belongs in the transcript.
        { maxAgeMs: APPEND_MAX_AGE_MS },
      );
    } else {
      this.writeFn(channelId, message).catch((e) => {
        console.warn(`[stm] direct write failed (no retry queue): ${channelId} -- ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  /**
   * Drop this bot's own `assistant` entries that carry a retracted reply, in memory only.
   *
   * WHY (2026-09-26, rotate-on-retract): `<prefix>: retract` archived the journal rows, the wm
   * note and the vault doc, and the mistake still echoed back on the next turn -- this window is
   * what hermesDelta re-sends to the gateway, so a retracted reply stayed in the model's context
   * until the 19:00 CDT rotation. Matching is containment in BOTH directions: a long reply lands
   * in Discord as several chunks, so the retracted message may be a fragment of the stored entry
   * or the entry may be a fragment of it. Under 20 chars is refused outright -- a chunk that short
   * ("ok.") would match half the window.
   *
   * Deliberately no DB write: Halseth drops its own stm_entries rows inside POST /admin/retract
   * (owner + channel scoped), so the persisted window and this one converge without a second
   * round trip. User turns are never touched, even when they quote the retracted words.
   *
   * Returns the number of entries removed.
   */
  retract(channelId: string, text: string): number {
    const needle = text.trim();
    if (needle.length < 20) return 0;
    const history = this.memory.get(channelId);
    if (!history?.length) return 0;
    const kept = history.filter(entry => {
      if (entry.role !== "assistant") return true;
      return !(entry.content.includes(needle) || needle.includes(entry.content));
    });
    const dropped = history.length - kept.length;
    if (dropped > 0) this.memory.set(channelId, kept);
    return dropped;
  }

  /**
   * Clears in-memory history for a channel (called after synthesis on timeout).
   * DB entries remain for potential restart recovery until pruned on next write.
   */
  clear(channelId: string): void {
    this.memory.delete(channelId);
    // Keep `loaded` mark -- prevents spurious DB load after intentional clear
  }
}
