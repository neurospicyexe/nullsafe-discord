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

export const STM_BUFFER_SIZE = 50;

export class StmStore {
  private memory = new Map<string, ChatMessage[]>();
  // Channels we've attempted a DB load for (prevents redundant loads on restart)
  private loaded = new Set<string>();

  constructor(
    private companionId: string,
    private writeFn: (channelId: string, entry: ChatMessage) => Promise<void>,
    private loadFn:  (channelId: string) => Promise<ChatMessage[]>,
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
   * Appends a message to memory and fire-and-forgets a DB write.
   * Buffer is trimmed to STM_BUFFER_SIZE to prevent unbounded growth.
   */
  append(channelId: string, message: ChatMessage): void {
    const history = this.memory.get(channelId) ?? [];
    history.push(message);
    if (history.length > STM_BUFFER_SIZE) history.shift();
    this.memory.set(channelId, history);
    this.loaded.add(channelId);

    // Fire-and-forget -- never block the message handler on DB write
    this.writeFn(channelId, message).catch(() => {});
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
