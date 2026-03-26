// packages/shared/src/write-queue.ts
//
// In-memory retry buffer for fire-and-forget writes to Halseth.
// Catches transient failures and retries on a timer.
// Ring buffer evicts oldest entries when full (bounded memory).

export interface QueuedWrite {
  label: string;
  fn: () => Promise<void>;
  queuedAt: number;
}

const MAX_BUFFER = 100;
const RETRY_INTERVAL_MS = 30_000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes; don't retry stale writes

export class WriteQueue {
  private buffer: QueuedWrite[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

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
   * Execute a write. If it fails, buffer it for retry.
   * Never throws; callers can fire-and-forget safely.
   */
  async enqueue(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      this.addToBuffer({ label, fn, queuedAt: Date.now() });
    }
  }

  /**
   * Fire-and-forget variant. Returns immediately, runs the write async.
   * On failure, buffers for retry. Never blocks, never throws.
   */
  fireAndForget(label: string, fn: () => Promise<void>): void {
    fn().catch(() => {
      this.addToBuffer({ label, fn, queuedAt: Date.now() });
    });
  }

  private addToBuffer(entry: QueuedWrite): void {
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  /** Attempt to drain buffered writes. Called by the retry timer. */
  private async drain(): Promise<void> {
    if (this.draining || this.buffer.length === 0) return;
    this.draining = true;

    const now = Date.now();
    this.buffer = this.buffer.filter(e => now - e.queuedAt < MAX_AGE_MS);

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

    this.buffer = remaining;
    this.draining = false;
  }
}
