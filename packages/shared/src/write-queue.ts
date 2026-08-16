// packages/shared/src/write-queue.ts
//
// In-memory retry buffer for fire-and-forget writes to Halseth.
// Catches transient failures and retries on a timer.
// Ring buffer evicts oldest entries when full (bounded memory).
//
// Observability: every failure and every dropped (permanently lost) write is logged. A failing
// write path must never look identical to a healthy one. Logs are tagged with the queue `name`
// (the companion id) so they're attributable per bot.

/**
 * Rejection handler for a fire-and-forget write that is NOT routed through WriteQueue.
 * Logs the failure, attributed to the companion, instead of swallowing it silently.
 *
 * IMPORTANT: raw `librarian.ask(...)` does NOT reject when an executor rejects the payload --
 * it resolves with an HTTP 200 `{ error }`/`{ witness }` envelope, so a bare `.catch` is
 * blind to silent rejects. The ask-based WRITE wrappers (addCompanionNote, witnessLog,
 * synthesizeSession, live-thread ops, ...) inspect the envelope via `assertWriteAck` and THROW
 * on declines (2026-07-05), so WriteQueue retry works for them. For any remaining raw ask()
 * write, pipe the result through `assertWriteAck` or use `librarianWriteChecked` (autonomous-core).
 *
 * Use: `librarian.stmWrite(...).catch(onWriteError(COMPANION_ID, "stm write"))`
 */
export function onWriteError(tag: string, label: string): (e: unknown) => void {
  return (e) => console.warn(`[${tag}] write failed (fire-and-forget): ${label} -- ${e instanceof Error ? e.message : String(e)}`);
}

export interface QueuedWrite {
  label: string;
  fn: () => Promise<void>;
  queuedAt: number;
  /** Per-entry retry TTL. Absent = MAX_AGE_MS. See enqueue/fireAndForget opts. */
  maxAgeMs?: number;
}

export interface WriteOpts {
  /**
   * How long this write may sit buffered before it is dropped as stale (coherence review,
   * WriteQueue loss modes). Two classes exist and they must not share a TTL:
   * - STATE-shaped writes (settings:model, drives, pulse) keep the short default -- replaying an
   *   OLD value after a NEWER one succeeded would revert live state, so late is worse than lost.
   * - APPEND-shaped, idempotent writes (journal:speech has external_id for exactly this; notes;
   *   thread upserts) pass APPEND_MAX_AGE_MS -- a journal entry 40 minutes late is still the
   *   entry; for appends, lost is worse than late.
   */
  maxAgeMs?: number;
}

export const MAX_BUFFER = 300;
const RETRY_INTERVAL_MS = 30_000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes; don't retry stale STATE writes
/** TTL for append-shaped idempotent writes -- late beats lost. */
export const APPEND_MAX_AGE_MS = 60 * 60 * 1000;

export class WriteQueue {
  private buffer: QueuedWrite[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  /** @param name log prefix for attribution (pass the companion id). */
  constructor(private readonly name: string = "write-queue") {}

  /** Start the retry timer. Call once at bot startup. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), RETRY_INTERVAL_MS);
  }

  /** Stop the retry timer. Call on bot shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of queued writes waiting for retry. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Execute a write. If it fails, log and buffer it for retry.
   * Never throws; callers can fire-and-forget safely.
   */
  async enqueue(label: string, fn: () => Promise<void>, opts?: WriteOpts): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.bufferFailure(label, fn, e, opts);
    }
  }

  /**
   * Fire-and-forget variant. Returns immediately, runs the write async.
   * On failure, logs and buffers for retry. Never blocks, never throws.
   */
  fireAndForget(label: string, fn: () => Promise<void>, opts?: WriteOpts): void {
    fn().catch((e) => this.bufferFailure(label, fn, e, opts));
  }

  /** Log the failure (so it's never silent) and buffer the write for retry. */
  private bufferFailure(label: string, fn: () => Promise<void>, err: unknown, opts?: WriteOpts): void {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[${this.name}] write failed, buffering for retry: ${label} -- ${reason}`);
    this.addToBuffer({ label, fn, queuedAt: Date.now(), maxAgeMs: opts?.maxAgeMs });
  }

  private addToBuffer(entry: QueuedWrite): void {
    if (this.buffer.length >= MAX_BUFFER) {
      const dropped = this.buffer.shift();
      if (dropped) {
        console.error(`[${this.name}] write queue full (${MAX_BUFFER}) -- dropping unsaved write, DATA LOSS: ${dropped.label}`);
      }
    }
    this.buffer.push(entry);
  }

  /** Attempt to drain buffered writes. Called by the retry timer. */
  private async drain(): Promise<void> {
    if (this.draining || this.buffer.length === 0) return;
    this.draining = true;

    const now = Date.now();
    // Drop stale writes -- but loudly: a continuity write aging out is permanent data loss.
    const fresh: QueuedWrite[] = [];
    for (const entry of this.buffer) {
      const ttl = entry.maxAgeMs ?? MAX_AGE_MS;
      if (now - entry.queuedAt < ttl) {
        fresh.push(entry);
      } else {
        console.error(`[${this.name}] write aged out after ${Math.round(ttl / 60000)}min unsaved, DATA LOSS: ${entry.label}`);
      }
    }
    this.buffer = fresh;

    const remaining: QueuedWrite[] = [];
    for (const entry of this.buffer) {
      try {
        await entry.fn();
      } catch {
        remaining.push(entry);
        // First failure in drain cycle: Halseth likely still down.
        // Push all remaining items back without attempting them.
        const idx = this.buffer.indexOf(entry);
        remaining.push(...this.buffer.slice(idx + 1));
        break;
      }
    }

    if (remaining.length > 0) {
      console.warn(`[${this.name}] retry drain incomplete -- ${remaining.length} write(s) still buffered`);
    }
    this.buffer = remaining;
    this.draining = false;
  }
}
