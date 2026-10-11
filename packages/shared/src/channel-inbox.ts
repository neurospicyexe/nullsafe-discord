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
// BURST SETTLE (BURST_SETTLE_MS, 2026-10-10). Raziel types in bursts. Without a window the first
// message of a burst started its own turn (and, under hermes, its own 30-120s inference) before the
// second had even arrived, then lost the reply to supersede check B. Now a human conversational
// message waits until BURST_SETTLE_MS has passed since the NEWEST queued human message arrived; the
// earlier entries still run their absorb path (STM append, ingest) but are superseded, so only the
// newest turn answers, and it is handed the gathered burst (`TurnContext.burst`) so the reply path
// can resolve names over the whole burst. Only human conversational messages start or extend the
// clock (same predicate as `supersedes`): command-shaped messages stay instant (and a command queued
// behind a settling message cuts the window short), and Sol / companion posts never start or restart
// it. 0 disables everything above: exactly the pre-settle behavior.
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
  /** Who spoke: author id + display name. A PK webhook shares one author id across everyone it
   *  proxies, so the name is part of the key. Only the same speaker's earlier messages are gathered
   *  into a burst. Absent = all one speaker (tests). */
  authorKey?: string;
  /** User ids @mentioned in the message (the burst's mentions are read by the reply path). */
  mentionedIds?: string[];
  /** The message this one replies to, when it is a reply. */
  replyToMessageId?: string | null;
}

/** What a turn is told beyond `isSuperseded`. */
export interface TurnContext {
  /** The settle window this turn waited (0 = it did not settle: a command, a bot post, a pass, or
   *  BURST_SETTLE_MS=0). The fit bid shifts its deadline by exactly this. */
  settleMs: number;
  /** Earlier messages of the SAME speaker gathered into this turn, oldest first. Their own turns
   *  were superseded (absorbed, never answered). Empty when settle is off. */
  burst: InboxItem[];
}

export const DEFAULT_BURST_SETTLE_MS = 4000;
const BURST_GATHER_MAX_AGE_MS = 5 * 60 * 1000;
const BURST_GATHER_MAX_ITEMS = 8;

/** BURST_SETTLE_MS: default 4000; `0` (or a negative) disables; junk falls back to the default. */
export function burstSettleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["BURST_SETTLE_MS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_BURST_SETTLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BURST_SETTLE_MS;
  return n <= 0 ? 0 : Math.round(n);
}

export interface ChannelInboxOpts {
  /** Burst settle window in ms (see header). 0 / absent = no settle. bot-core passes burstSettleMs(). */
  settleMs?: number;
  /** Injectable clock and sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Command-shaped test (the bot's COMMAND_GUARD). Command messages never supersede. */
  isCommandShaped?: (content: string) => boolean;
  /** Max queued turns per channel; beyond it the OLDEST queued turn is dropped (its
   *  handler never runs). Backstop against a wedged handler starving memory. */
  maxQueue?: number;
  log?: (msg: string) => void;
}

interface QueueEntry {
  item: InboxItem;
  run: (isSuperseded: () => boolean, ctx: TurnContext) => Promise<void>;
  arrivedAt: number;
}

interface ChannelQueue {
  entries: QueueEntry[];
  running: boolean;
  /** Superseded same-burst items awaiting the turn that answers them. */
  burst: Array<{ item: InboxItem; arrivedAt: number }>;
  /** Wakes a settle sleep when something new is queued, so the window is re-evaluated. */
  wake: (() => void) | null;
}

const DEFAULT_MAX_QUEUE = 20;

export class ChannelInbox {
  private queues = new Map<string, ChannelQueue>();
  private readonly isCommandShaped: (content: string) => boolean;
  private readonly maxQueue: number;
  private readonly log: (msg: string) => void;
  private readonly settleMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ChannelInboxOpts = {}) {
    this.isCommandShaped = opts.isCommandShaped ?? (() => false);
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.log = opts.log ?? ((m) => console.log(m));
    this.settleMs = Math.max(0, opts.settleMs ?? 0);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>(r => setTimeout(r, ms)));
  }

  /**
   * Enqueue a message turn. `run` receives an `isSuperseded` probe it may call at any
   * point (cheap, synchronous): true once a newer human, non-command message is waiting
   * in this channel's queue -- the signal to skip/drop the conversational reply.
   */
  enqueue(item: InboxItem, run: (isSuperseded: () => boolean, ctx: TurnContext) => Promise<void>): void {
    let q = this.queues.get(item.channelId);
    if (!q) {
      q = { entries: [], running: false, burst: [], wake: null };
      this.queues.set(item.channelId, q);
    }
    q.entries.push({ item, run, arrivedAt: this.now() });
    q.wake?.();
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

  /** A human message that is command-shaped: instant, and it cuts a settle window short. */
  private isCommandEntry(item: InboxItem): boolean {
    return item.authorIsHuman && this.isCommandShaped(item.content);
  }

  /**
   * Hold the head entry until the channel has been quiet for settleMs, measured from the NEWEST queued
   * human conversational message. Returns the window applied (0 = the head did not settle).
   */
  private async settle(q: ChannelQueue): Promise<number> {
    if (this.settleMs <= 0) return 0;
    for (;;) {
      const head = q.entries[0];
      if (!head || !this.supersedes(head.item)) return 0;
      // A command queued behind the head is instant: do not hold either of them for the window.
      if (q.entries.slice(1).some(e => this.isCommandEntry(e.item))) return this.settleMs;
      let newest = head.arrivedAt;
      for (const e of q.entries) if (this.supersedes(e.item) && e.arrivedAt > newest) newest = e.arrivedAt;
      const waitMs = newest + this.settleMs - this.now();
      if (waitMs <= 0) return this.settleMs;
      await Promise.race([
        this.sleep(waitMs),
        new Promise<void>(r => { q.wake = r; }),
      ]);
      q.wake = null;
    }
  }

  private async drain(channelId: string, q: ChannelQueue): Promise<void> {
    q.running = true;
    try {
      while (q.entries.length > 0) {
        const settleApplied = await this.settle(q);
        const entry = q.entries.shift();
        if (!entry) continue; // the maxQueue backstop dropped the head while it was settling
        const speaks = this.supersedes(entry.item);
        const cutoff = this.now() - BURST_GATHER_MAX_AGE_MS;
        const burst = settleApplied > 0 && speaks
          ? q.burst.filter(b => b.item.authorKey === entry.item.authorKey && b.arrivedAt >= cutoff).map(b => b.item)
          : [];
        const ctx: TurnContext = { settleMs: speaks ? settleApplied : 0, burst };
        // Superseded iff a newer human conversational message is already queued behind us.
        // Evaluated live at each probe call -- a message arriving MID-inference flips it.
        const isSuperseded = () => q.entries.some(e => this.supersedes(e.item));
        try {
          await entry.run(isSuperseded, ctx);
        } catch (err) {
          this.log(`[inbox] turn ${entry.item.id} in ${channelId} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Burst bookkeeping (settle on only): a conversational turn that a newer human message
        // superseded joins the burst its successor carries; one that answered closes the burst.
        if (this.settleMs > 0 && speaks) {
          if (isSuperseded()) {
            q.burst.push({ item: entry.item, arrivedAt: entry.arrivedAt });
            if (q.burst.length > BURST_GATHER_MAX_ITEMS) q.burst.shift();
          } else {
            q.burst = [];
          }
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
