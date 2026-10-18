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
// SIDES (2026-10-18, P3/P4 of Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md). Two humans share these
// rooms, each a plural system, so "who spoke" is the human SIDE (`InboxItem.side`: raziel | blue), not the
// PluralKit member. Only a same-side message supersedes a turn, extends its settle clock, or is gathered
// into its burst (Sora then Megan are one Blue burst; Raziel's message never cancels an answer to Blue).
// The settle hold is capped (BURST_SETTLE_MAX_MS from the head's arrival) so a stream never starves it.
// Check B (a finished reply dropped because a newer message queued mid-inference) is OFF by default
// (SUPERSEDE_B): the in-flight reply posts and the messages that arrived meanwhile get one catch-up turn.
// The probe takes a phase: "post" is check B. An unknown side behaves like the pre-side rules.
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
  /** Which HUMAN this is: Raziel's system (the owner and all of their PluralKit fronts) or Blue's
   *  (Blue and all of Blue's members). Resolved at enqueue by `resolveInboxSide`. null/absent =
   *  unknown (a roster miss, a guest, tests): behaves like the pre-side rules. */
  side?: InboxSide | null;
}

export type InboxSide = "raziel" | "blue";

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

const FALSY = new Set(["off", "0", "false", "no"]);
const TRUTHY = new Set(["on", "1", "true", "yes"]);

/** SUPERSEDE_SIDE_AWARE (P3, 2026-10-18): default ON; off/0/false/no = any human supersedes (old rule). */
export function supersedeSideAwareOn(env: Record<string, string | undefined> = process.env): boolean {
  return !FALSY.has((env["SUPERSEDE_SIDE_AWARE"] ?? "").trim().toLowerCase());
}

/** SUPERSEDE_B (P3, ruling 3 revised): default OFF. Only on/1/true/yes restores check B, the
 *  mid-inference drop of a finished reply. */
export function supersedeBOn(env: Record<string, string | undefined> = process.env): boolean {
  return TRUTHY.has((env["SUPERSEDE_B"] ?? "").trim().toLowerCase());
}

export type SettleScope = "side" | "speaker";
/** BURST_SETTLE_SCOPE (P4): `side` (default; also junk) groups by human side, `speaker` is the old per-author rule. */
export function burstSettleScope(env: Record<string, string | undefined> = process.env): SettleScope {
  return (env["BURST_SETTLE_SCOPE"] ?? "").trim().toLowerCase() === "speaker" ? "speaker" : "side";
}

export const DEFAULT_BURST_SETTLE_MAX_MS = 20000;
/** BURST_SETTLE_MAX_MS (P4): the longest the head of a burst is held, from its arrival. Default 20000;
 *  0 or negative = no cap; junk = default. */
export function burstSettleMaxMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["BURST_SETTLE_MAX_MS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_BURST_SETTLE_MAX_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BURST_SETTLE_MAX_MS;
  return n <= 0 ? 0 : Math.round(n);
}

/**
 * Which human side a message is from, synchronously (the PK roster is in memory). A raw author id
 * matches the owner / Blue; a webhook post resolves through the roster, which only holds Raziel's
 * and Blue's systems (a non-owner member is Blue's). Anything else is null: unknown behaves like
 * the pre-side rules (keyed by author), never worse than before.
 */
export function resolveInboxSide(
  m: { authorId: string; isWebhook: boolean; username: string },
  ids: { ownerDiscordId?: string | undefined; blueDiscordId?: string | undefined },
  roster: { identify(name: string | null | undefined): { isOwner: boolean } | null } | null,
): InboxSide | null {
  if (ids.ownerDiscordId && m.authorId === ids.ownerDiscordId) return "raziel";
  if (ids.blueDiscordId && m.authorId === ids.blueDiscordId) return "blue";
  if (m.isWebhook && roster) {
    const member = roster.identify(m.username);
    if (member) return member.isOwner ? "raziel" : "blue";
  }
  return null;
}

/** Which probe is asking: `pre` = before the model is called (check A and the failure path), `post`
 *  = after the reply is written, before it posts (check B). */
export type SupersedePhase = "pre" | "post";

export interface ChannelInboxOpts {
  /** P3: only a same-side human message supersedes. Default true. */
  supersedeSideAware?: boolean;
  /** P3: restore check B (drop a finished reply when a newer message is queued). Default false. */
  supersedeB?: boolean;
  /** P4: settle clock + burst gather grouping. Default "side". */
  settleScope?: SettleScope;
  /** P4: hold cap from the head's arrival, ms. 0/absent = no cap. */
  settleMaxMs?: number;
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
  run: (isSuperseded: (phase?: SupersedePhase) => boolean, ctx: TurnContext) => Promise<void>;
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
  private readonly supersedeSideAware: boolean;
  private readonly supersedeB: boolean;
  private readonly settleScope: SettleScope;
  private readonly settleMaxMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ChannelInboxOpts = {}) {
    this.isCommandShaped = opts.isCommandShaped ?? (() => false);
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.log = opts.log ?? ((m) => console.log(m));
    this.settleMs = Math.max(0, opts.settleMs ?? 0);
    this.supersedeSideAware = opts.supersedeSideAware ?? true;
    this.supersedeB = opts.supersedeB ?? false;
    this.settleScope = opts.settleScope ?? "side";
    this.settleMaxMs = Math.max(0, opts.settleMaxMs ?? 0);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>(r => setTimeout(r, ms)));
  }

  /**
   * Enqueue a message turn. `run` receives an `isSuperseded` probe it may call at any
   * point (cheap, synchronous): true once a newer human, non-command message is waiting
   * in this channel's queue -- the signal to skip/drop the conversational reply.
   */
  enqueue(item: InboxItem, run: (isSuperseded: (phase?: SupersedePhase) => boolean, ctx: TurnContext) => Promise<void>): void {
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

  /** A human conversational message: the only thing that starts or extends a settle clock. */
  private isHumanConversation(item: InboxItem): boolean {
    return item.authorIsHuman && !this.isCommandShaped(item.content);
  }

  /** Unknown side on either end is compatible (the pre-side rule); two known sides must match. */
  private static sidesCompatible(a: InboxItem, b: InboxItem): boolean {
    return !a.side || !b.side || a.side === b.side;
  }

  /**
   * Does `candidate` supersede `head`'s reply? A human conversational message, and (P3) of the SAME
   * side as the turn it would cancel: Raziel's message never cancels an answer to Blue, nor the reverse.
   * `head` omitted = the side-blind question ("is this a conversational human message").
   */
  private supersedes(candidate: InboxItem, head?: InboxItem): boolean {
    if (!this.isHumanConversation(candidate)) return false;
    if (!head || !this.supersedeSideAware) return true;
    return ChannelInbox.sidesCompatible(candidate, head);
  }

  /** Does `candidate` extend the settle clock of `head`? Side scope: same side only. Speaker scope: any human. */
  private extendsClock(candidate: InboxItem, head: InboxItem): boolean {
    if (!this.isHumanConversation(candidate)) return false;
    return this.settleScope === "side" ? ChannelInbox.sidesCompatible(candidate, head) : true;
  }

  /** Same speaker for burst gathering: by side (all of Blue's members are one speaker), else by author. */
  private sameSpeaker(a: InboxItem, b: InboxItem): boolean {
    if (this.settleScope === "side" && a.side && b.side) return a.side === b.side;
    return a.authorKey === b.authorKey;
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
      if (!head || !this.isHumanConversation(head.item)) return 0;
      // A command queued behind the head is instant: do not hold either of them for the window.
      if (q.entries.slice(1).some(e => this.isCommandEntry(e.item))) return this.settleMs;
      let newest = head.arrivedAt;
      for (const e of q.entries) if (this.extendsClock(e.item, head.item) && e.arrivedAt > newest) newest = e.arrivedAt;
      // Hold cap (BURST_SETTLE_MAX_MS): from the head's arrival, so a stream that never goes quiet for
      // settleMs still releases. The turn still reports the configured settleMs, which keeps the fit-bid
      // deadline (createdTimestamp of the NEWEST message + settleMs + window) the same on all three bots.
      const until = this.settleMaxMs > 0
        ? Math.min(newest + this.settleMs, head.arrivedAt + this.settleMaxMs)
        : newest + this.settleMs;
      const waitMs = until - this.now();
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
        const speaks = this.isHumanConversation(entry.item);
        const cutoff = this.now() - BURST_GATHER_MAX_AGE_MS;
        const burst = settleApplied > 0 && speaks
          ? q.burst.filter(b => this.sameSpeaker(b.item, entry.item) && b.arrivedAt >= cutoff).map(b => b.item)
          : [];
        const ctx: TurnContext = { settleMs: speaks ? settleApplied : 0, burst };
        // Superseded iff a newer human conversational message is already queued behind us.
        // Evaluated live at each probe call -- a message arriving MID-inference flips it.
        //
        // Phase "post" is supersede check B (a finished reply about to post). With SUPERSEDE_B off
        // (default) it answers false and records that this turn ANSWERED: the in-flight reply finishes
        // and posts, and the messages that arrived meanwhile are answered by one catch-up turn (the
        // queue's next head absorbs all but the newest; hermesDelta folds them). `answered` keeps a
        // turn that posted out of its successor's gathered burst.
        let answered = false;
        const isSuperseded = (phase?: SupersedePhase): boolean => {
          const live = q.entries.some(e => this.supersedes(e.item, entry.item));
          if (phase === "post") {
            if (live && this.supersedeB) return true;      // check B on: the finished reply is dropped
            answered = true;                               // it passes the gate and posts
            return false;
          }
          return live;
        };
        try {
          await entry.run(isSuperseded, ctx);
        } catch (err) {
          this.log(`[inbox] turn ${entry.item.id} in ${channelId} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Burst bookkeeping (settle on only): a conversational turn that a newer human message
        // superseded joins the burst its successor carries; one that answered closes the burst.
        if (this.settleMs > 0 && speaks) {
          if (!answered && isSuperseded()) {
            q.burst.push({ item: entry.item, arrivedAt: entry.arrivedAt });
            if (q.burst.length > BURST_GATHER_MAX_ITEMS) q.burst.shift();
          } else {
            // Close THIS speaker's burst only: an absorbed message of the other side (interleaved
            // Blue and Raziel) is still waiting for the turn that answers it.
            q.burst = q.burst.filter(b => !this.sameSpeaker(b.item, entry.item));
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
