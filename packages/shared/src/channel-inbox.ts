// channel-inbox.ts -- per-channel conversation queue (2026-07-06).
//
// Root cause it fixes: bot-core fired `void handleMessage(...)` per messageCreate, so every
// message ran fully concurrently. Under hermes a turn takes 30-120s of inference; three quick
// messages from Raziel meant three overlapping runs, each replying to the channel state at
// its OWN start time -- replies landed answering something two messages old, sometimes out
// of order. The "delayed catch-up" feel was structural, not a model problem.
//
// The inbox inverts it: one worker per channel, strictly FIFO. While a turn is running (or
// queued behind others), newer messages wait in the queue -- and a queued HUMAN message
// SUPERSEDES the conversational reply of every turn ahead of it. A superseded turn still
// runs its cheap absorb path (STM append, ingest, commands), it just skips or drops the
// expensive reply -- the newest message's turn answers with everything in context. Net:
// a rapid burst produces ONE reply to the full burst, and a reply never posts after the
// conversation has visibly moved on.
//
// Command-shaped messages (per COMMAND_GUARD) never supersede: they are deterministic
// side-band actions ("cy: log ..."), and dropping the conversational reply ahead of them
// would silently eat a real answer.
//
// Cross-channel behavior is unchanged: queues are independent per channel.

export interface InboxItem {
  /** Discord snowflake -- used only for logging. */
  id: string;
  channelId: string;
  /** Raw human (author.bot === false) or a webhook post (PluralKit proxy of a human).
   *  Companion bots post as bot users without webhooks, so they never count. */
  authorIsHuman: boolean;
  content: string;
}

export interface ChannelInboxOpts {
  /** Command-shaped test (the bot's COMMAND_GUARD). Command messages never supersede. */
  isCommandShaped?: (content: string) => boolean;
  /** Max queued turns per channel; beyond it the OLDEST queued turn is dropped (its
   *  handler never runs). Backstop against a wedged handler starving memory. */
  maxQueue?: number;
  log?: (msg: string) => void;
}

interface QueueEntry {
  item: InboxItem;
  run: (isSuperseded: () => boolean) => Promise<void>;
}

interface ChannelQueue {
  entries: QueueEntry[];
  running: boolean;
}

const DEFAULT_MAX_QUEUE = 20;

export class ChannelInbox {
  private queues = new Map<string, ChannelQueue>();
  private readonly isCommandShaped: (content: string) => boolean;
  private readonly maxQueue: number;
  private readonly log: (msg: string) => void;

  constructor(opts: ChannelInboxOpts = {}) {
    this.isCommandShaped = opts.isCommandShaped ?? (() => false);
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /**
   * Enqueue a message turn. `run` receives an `isSuperseded` probe it may call at any
   * point (cheap, synchronous): true once a newer human, non-command message is waiting
   * in this channel's queue -- the signal to skip/drop the conversational reply.
   */
  enqueue(item: InboxItem, run: (isSuperseded: () => boolean) => Promise<void>): void {
    let q = this.queues.get(item.channelId);
    if (!q) {
      q = { entries: [], running: false };
      this.queues.set(item.channelId, q);
    }
    q.entries.push({ item, run });
    if (q.entries.length > this.maxQueue) {
      const dropped = q.entries.shift();
      this.log(`[inbox] channel ${item.channelId} queue over ${this.maxQueue}, dropped turn ${dropped?.item.id}`);
    }
    if (!q.running) void this.drain(item.channelId, q);
  }

  /** Number of turns waiting (not yet started) in a channel. Exposed for tests. */
  pendingCount(channelId: string): number {
    return this.queues.get(channelId)?.entries.length ?? 0;
  }

  private supersedes(item: InboxItem): boolean {
    return item.authorIsHuman && !this.isCommandShaped(item.content);
  }

  private async drain(channelId: string, q: ChannelQueue): Promise<void> {
    q.running = true;
    try {
      while (q.entries.length > 0) {
        const entry = q.entries.shift()!;
        // Superseded iff a newer human conversational message is already queued behind us.
        // Evaluated live at each probe call -- a message arriving MID-inference flips it.
        const isSuperseded = () => q.entries.some(e => this.supersedes(e.item));
        try {
          await entry.run(isSuperseded);
        } catch (err) {
          this.log(`[inbox] turn ${entry.item.id} in ${channelId} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      q.running = false;
      // A message enqueued between the while-exit and this line restarts the worker itself
      // only if it saw running=true; re-check so nothing strands.
      if (q.entries.length > 0) void this.drain(channelId, q);
    }
  }
}
