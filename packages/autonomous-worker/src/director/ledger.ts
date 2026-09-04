// director/ledger.ts -- the durable half: conversation_threads + thread_ledger via the existing
// /mind/conversations endpoints. Land only on a companion's [LANDS:]; fade carries a reason code.
import { convoActiveFor, convoOpenFor, convoTurnFor, convoLandFor, convoFadeFor } from "../halseth-client.js";
import type { ConversationState, LedgerTurn } from "./types.js";

export interface Ledger {
  ensureThread(s: ConversationState, first: LedgerTurn): Promise<string | null>;
  appendTurn(threadId: string, t: LedgerTurn): Promise<void>;
  land(threadId: string, resolution: string, by: string): Promise<boolean>;
  fade(threadId: string, reason: string): Promise<boolean>;
}

export function createHalsethLedger(): Ledger {
  return {
    async ensureThread(s, first) {
      try {
        const active = await convoActiveFor(s.channelId);
        if (active) return active.thread.id;
      } catch (e) { console.warn("[director/ledger] convoActive failed, opening fresh:", e); }
      const opened = await convoOpenFor({ channel_id: s.channelId, seed_text: first.gist, seed_author: first.author, seed_message_id: first.messageId });
      return opened?.id ?? null;
    },
    async appendTurn(threadId, t) { await convoTurnFor(threadId, { author: t.author, gist: t.gist, message_id: t.messageId }); },
    land: (id, resolution, by) => convoLandFor(id, resolution, by),
    fade: (id, reason) => convoFadeFor(id, reason),
  };
}
