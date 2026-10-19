// turn-telemetry.ts -- ONE structured line per reply turn (P6 of Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md).
//
// 2026-10-18 incident: reconstructing one slow channel moment took four log sources and snowflake
// decoding. Now every turn that reaches the inbox's run callback (and every turn the inbox drops)
// ends in exactly one `[turn] {json}` line, same shape idiom as `[rail]` (rail-telemetry.ts):
//
//   [turn] {"c":"drevan","ch":"...","msg":"...","side":"blue","outcome":"posted","queue_ms":0,
//           "settle_ms":4000,"gathered":2,"vision_ms":1200,"vision":"wait","halseth_ms":310,
//           "inference_ms":9100,"post_ms":240,"total_ms":15200,"catchup":false,"in_tok":null,"at":"..."}
//
// IDS, COUNTS AND TIMINGS ONLY. Never message or reply text; the schema has no field that could hold it.
//
// How the stages reach the trace without threading a parameter through a 3,600-line handler: the
// bot-core turn wrapper runs the turn inside an AsyncLocalStorage context (`runWithTurn`), and the
// seams (resolveSeenImages, the Librarian fetch, the Hermes call, the send, railSuppressed) read
// `currentTurn()`. Outside a turn it is undefined and every hook is a no-op.
//
// Outcomes: posted | absorbed | superseded_a | superseded_b | skipped:<gate> | held.
//   posted        a reply went to the channel (always wins over an earlier skip mark)
//   absorbed      the inbox superseded this turn and nothing else ended it first (STM/ingest only)
//   superseded_a  check A: skipped before the model was called
//   superseded_b  check B: a finished reply was dropped (SUPERSEDE_B=on)
//   skipped:<g>   a rail/gate ended it: the rail name (echo, bid_lost, human_address, ...), or
//                 queue_overflow (inbox backstop dropped it), pass, error, other
//   held          reserved: a reply deliberately withheld (the B32 care [PASS])
// The FIRST outcome set wins, except `posted`.
//
// TURN_TELEMETRY=off/0/false/no turns the line off (the measurements still cost nothing).

import { AsyncLocalStorage } from "node:async_hooks";

const OFF = new Set(["off", "0", "false", "no"]);

/** TURN_TELEMETRY, default ON. */
export function turnTelemetryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !OFF.has((env["TURN_TELEMETRY"] ?? "").trim().toLowerCase());
}

export type VisionKind = "hit" | "miss" | "wait" | "lock-wait" | "budget" | "none";

export interface TurnTraceInit {
  companionId: string;
  channelId: string;
  messageId: string;
  /** Human side (raziel | blue) or null when unknown / not a human message. */
  side: string | null;
  /** Discord createdTimestamp of the (newest) message; null = unknown. total_ms counts from it. */
  createdAt: number | null;
  /** When the message entered this bot's inbox (fallback origin for total_ms). */
  enqueuedAt: number;
  startedAt: number;
  /** Time spent behind other turns, excluding the settle hold. */
  queueMs: number;
  /** Time actually held in the burst-settle window. */
  settleMs: number;
  /** Earlier messages of the burst this turn answers for. */
  gathered: number;
  /** This turn arrived while another was running in the channel (it is the catch-up). */
  catchup: boolean;
  enabled?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class TurnTrace {
  private outcome: string | null = null;
  private visionMs = 0;
  private visionKind: VisionKind = "none";
  private halsethMs = 0;
  private inferenceMs = 0;
  private postMs = 0;
  private inTok: number | null = null;
  private emitted = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly enabled: boolean;

  constructor(private readonly i: TurnTraceInit) {
    this.now = i.now ?? Date.now;
    this.log = i.log ?? ((l) => console.log(l));
    this.enabled = i.enabled ?? turnTelemetryEnabled();
  }

  get hasOutcome(): boolean { return this.outcome !== null; }

  setOutcome(o: string): void {
    if (o === "posted" || this.outcome === null) this.outcome = o;
  }
  setVision(ms: number, kind: VisionKind): void { this.visionMs += Math.max(0, Math.round(ms)); this.visionKind = kind; }
  addHalseth(ms: number): void { this.halsethMs += Math.max(0, Math.round(ms)); }
  setInference(ms: number): void { this.inferenceMs = Math.max(0, Math.round(ms)); }
  setPost(ms: number): void { this.postMs = Math.max(0, Math.round(ms)); }
  setInTok(n: number | null | undefined): void { if (typeof n === "number" && Number.isFinite(n)) this.inTok = Math.round(n); }

  /** Called by the wrapper when the turn function returns or throws; derives an outcome if none was set. */
  finish(o: { superseded: boolean; threw?: boolean }): void {
    if (this.outcome === null) this.outcome = o.threw ? "skipped:error" : o.superseded ? "absorbed" : "skipped:other";
    this.emit();
  }

  emit(): void {
    if (this.emitted) return;
    this.emitted = true;
    if (!this.enabled) return;
    try {
      const now = this.now();
      const origin = this.i.createdAt !== null && this.i.createdAt <= now ? this.i.createdAt : this.i.enqueuedAt;
      const payload = {
        c: this.i.companionId,
        ch: this.i.channelId,
        msg: this.i.messageId,
        side: this.i.side,
        outcome: this.outcome ?? "skipped:other",
        queue_ms: this.i.queueMs,
        settle_ms: this.i.settleMs,
        gathered: this.i.gathered,
        vision_ms: this.visionMs,
        vision: this.visionKind,
        halseth_ms: this.halsethMs,
        inference_ms: this.inferenceMs,
        post_ms: this.postMs,
        total_ms: Math.max(0, now - origin),
        catchup: this.i.catchup,
        in_tok: this.inTok,
        at: new Date(now).toISOString(),
      };
      this.log(`[turn] ${JSON.stringify(payload)}`);
    } catch { /* telemetry must never be the reason a turn fails */ }
  }
}

const store = new AsyncLocalStorage<TurnTrace>();

export function runWithTurn<T>(trace: TurnTrace, fn: () => T): T { return store.run(trace, fn); }
export function currentTurn(): TurnTrace | undefined { return store.getStore(); }

/** rail-telemetry hook: a rail that ends a turn names its outcome. `superseded` is check B. */
export function traceRailOutcome(rail: string): void {
  try { currentTurn()?.setOutcome(rail === "superseded" ? "superseded_b" : `skipped:${rail}`); } catch { /* never throws */ }
}

/** Time a Halseth/Librarian call into the ambient turn (sum of call durations; overlapping calls overlap). */
export async function timeHalseth<T>(fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const t = currentTurn();
  if (!t) return fn();
  const t0 = now();
  try { return await fn(); } finally { t.addHalseth(now() - t0); }
}

/** A turn the inbox dropped before it ran (queue backstop): one line, no stages. */
export function emitDroppedTurn(init: Omit<TurnTraceInit, "queueMs" | "settleMs" | "gathered" | "catchup" | "startedAt">, reason: string): void {
  const t = new TurnTrace({ ...init, startedAt: init.enqueuedAt, queueMs: 0, settleMs: 0, gathered: 0, catchup: false });
  t.setOutcome(`skipped:${reason}`);
  t.emit();
}
