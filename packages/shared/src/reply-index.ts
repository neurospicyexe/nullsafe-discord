/**
 * Which message did this reply answer, and which chunks are it? (2026-09-26 review, retract.)
 *
 * WHY THIS EXISTS
 * `<prefix>: retract` has to archive two keys the reply itself does not carry:
 *   - `judge:<trigger id>`: the memory judge keys its journal row and promoted wm note on the
 *     message that TRIGGERED the turn (writeback-gate.ts, `messageId: message.id`). The first cut
 *     read it off the reply's Discord reference, but computeReplyRef only sets a reference for
 *     companion-triggered turns or active spines, so a plain reply to Raziel carried none: the
 *     judge note survived every retract while the ack said "retracted." And an entitled follow-up
 *     references Raziel's ORIGIN message while the judge ran on the sibling reply that released
 *     it, so even a present reference could be the wrong key.
 *   - the head chunk: sendLong splits a long reply, and journalSpeech + liveIngest key on
 *     `sent[0].id`. Retracting chunk 2 looked for `discord:<chunk 2>` and found nothing.
 * So the handler records, at send time, every chunk id -> { head, chunks, trigger, full text }.
 *
 * WHERE IT LIVES
 * In memory (bounded, newest wins) and, when Redis is configured, in Redis with a TTL, so a pm2
 * reload does not forget which message a reply answered. Head key carries the record; chunk keys
 * point at the head, so a long reply's text is stored once. Every store call is fire-and-forget
 * and never throws: a reply is never slower or missing because this index could not be written.
 * When both miss (Redis absent, or an older reply), retract-command.ts reconstructs from Discord.
 */

export interface ReplyRecord {
  /** First chunk: what journalSpeech (`discord:<id>`) and liveIngest were keyed on. */
  headId: string;
  chunkIds: string[];
  /** The message that triggered the turn: what the judge keyed `judge:<id>` on. */
  triggerMessageId: string;
  channelId: string;
  /** The FULL reply as generated, not one chunk: the STM window holds it whole. */
  content: string;
  at: number;
}

/** The slice of ioredis this needs. */
export interface ReplyIndexStore {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export const REPLY_INDEX_TTL_S = 30 * 24 * 3600; // matches the 30-day restore window of a release

export class ReplyIndex {
  private byChunk = new Map<string, ReplyRecord>();

  constructor(
    private companionId: string,
    private store: ReplyIndexStore | null = null,
    private cap = 1000,
  ) {}

  private key(id: string): string {
    return `ns:reply:${this.companionId}:${id}`;
  }

  record(r: Omit<ReplyRecord, "at"> & { at?: number }): void {
    if (!r.chunkIds.length) return;
    const rec: ReplyRecord = { ...r, at: r.at ?? Date.now() };
    for (const id of rec.chunkIds) {
      this.byChunk.delete(id); // re-insert so eviction order is recency
      this.byChunk.set(id, rec);
    }
    while (this.byChunk.size > this.cap) {
      const oldest = this.byChunk.keys().next().value;
      if (oldest === undefined) break;
      this.byChunk.delete(oldest);
    }
    if (!this.store) return;
    const store = this.store;
    const put = (k: string, v: string) => {
      try { store.set(k, v, "EX", REPLY_INDEX_TTL_S).catch(() => undefined); } catch { /* never on the reply path */ }
    };
    put(this.key(rec.headId), JSON.stringify(rec));
    for (const id of rec.chunkIds) if (id !== rec.headId) put(this.key(id), JSON.stringify({ headId: rec.headId }));
  }

  /** The record for any chunk of a reply, or null. Memory first, then the store. Never throws. */
  async resolve(messageId: string): Promise<ReplyRecord | null> {
    const hit = this.byChunk.get(messageId);
    if (hit) return hit;
    if (!this.store) return null;
    const read = async (id: string): Promise<Record<string, unknown> | null> => {
      try {
        const raw = await this.store!.get(this.key(id));
        const v = raw ? JSON.parse(raw) as unknown : null;
        return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
      } catch {
        return null;
      }
    };
    let v = await read(messageId);
    if (v && typeof v["headId"] === "string" && !("triggerMessageId" in v) && v["headId"] !== messageId) {
      v = await read(v["headId"]);
    }
    if (!v) return null;
    const ok = typeof v["headId"] === "string" && typeof v["triggerMessageId"] === "string"
      && Array.isArray(v["chunkIds"]) && typeof v["content"] === "string";
    return ok ? v as unknown as ReplyRecord : null;
  }
}
