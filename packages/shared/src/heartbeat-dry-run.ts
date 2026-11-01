// Heartbeat dry run (STATUS B56): `<prefix>: dry-run heartbeat [force]`.
//
// Runs the REAL runHeartbeat for this companion and reports what it would do, while NEVER sending,
// reserving, recording or advancing anything. A missed check leaks a real DM to Raziel, so this is
// fail-safe by construction, in three layers (any one alone is enough for the calls it covers):
//
//   1. dryRunCtx() hands the heartbeat a ctx whose librarian, redis, Discord client and owner-DM lane
//      are DENY-BY-DEFAULT proxies: an explicit allow-list of read methods passes through, every other
//      method is recorded and answered with a safe stub, and an unknown method is blocked, never passed.
//   2. Module state the ctx cannot reach (the decline cap, the origin mint, rail/tick/b32 log lines, the
//      cycle guard, the cooldown map) is guarded by explicit `ctx.dryRun` checks in autonomous-core.ts,
//      and the ctx carries copies/stubs of the mutable fields.
//   3. The two send seams (sendAutonomousMessage, speakToOwnerDm) capture-and-return at the top.
//
// Inference stays the real adapter (the compose is the point of the command). A sessionless Hermes call
// already makes a one-off api-<hash> session on every real tick, so a dry run adds the same kind of row.
//
// This module imports NO runtime code from autonomous-core (type-only), so there is no import cycle.

import type { AutonomousContext } from "./autonomous-core.js";
import type { HeartbeatOutcome, HeartbeatTickInfo } from "./rail-telemetry.js";

// ── The report ──────────────────────────────────────────────────────────────

export interface DryRunGate { name: string; passed: boolean; detail?: string; /** a failing gate that `force` stepped over */ forced?: boolean }
export interface DryRunComposed { seam: string; kind: string; text: string; note?: string }
export interface DryRunBlocked { surface: string; op: string; note?: string }

export interface DryRunReport {
  companionId: string;
  force: boolean;
  gates: DryRunGate[];
  paletteSize: number | null;
  paletteNames: string[];
  decisionRaw: string | null;
  move: string | null;
  moveReason: string | null;
  composed: DryRunComposed[];
  blocked: DryRunBlocked[];
  notes: string[];
  outcome: HeartbeatOutcome | null;
  info: HeartbeatTickInfo;
  /** Set when runHeartbeat threw; the dry run never rethrows into the handler. */
  error: string | null;
}

/** What the heartbeat body calls on ctx.dryRunSink. Every method must be safe to call and never throw. */
export interface DryRunSink {
  readonly force: boolean;
  gate(name: string, passed: boolean, detail?: string, forced?: boolean): void;
  note(text: string): void;
  palette(names: string[]): void;
  decision(raw: string | null, move: string | null, reason: string | null): void;
  compose(seam: string, kind: string, text: string, note?: string): void;
  blocked(surface: string, op: string, note?: string): void;
  finish(outcome: HeartbeatOutcome | null, info: HeartbeatTickInfo): void;
}

export function newDryRunReport(companionId: string, force: boolean): DryRunReport {
  return {
    companionId, force, gates: [], paletteSize: null, paletteNames: [], decisionRaw: null, move: null, moveReason: null,
    composed: [], blocked: [], notes: [], outcome: null, info: {}, error: null,
  };
}

export function makeSink(report: DryRunReport): DryRunSink {
  const safe = (fn: () => void) => { try { fn(); } catch { /* the sink must never be why a tick fails */ } };
  return {
    force: report.force,
    gate: (name, passed, detail, forced) => safe(() => { report.gates.push({ name, passed, ...(detail ? { detail } : {}), ...(forced ? { forced: true } : {}) }); }),
    note: (text) => safe(() => { report.notes.push(text); }),
    palette: (names) => safe(() => { report.paletteSize = names.length; report.paletteNames = names; }),
    decision: (raw, move, reason) => safe(() => { report.decisionRaw = raw; report.move = move; report.moveReason = reason; }),
    compose: (seam, kind, text, note) => safe(() => { report.composed.push({ seam, kind, text, ...(note ? { note } : {}) }); }),
    blocked: (surface, op, note) => safe(() => { report.blocked.push({ surface, op, ...(note ? { note } : {}) }); }),
    finish: (outcome, info) => safe(() => { report.outcome = outcome; report.info = info; }),
  };
}

// ── Deny-by-default proxies ─────────────────────────────────────────────────

/**
 * The Librarian methods the heartbeat path actually calls to READ (verified against autonomous-core.ts and
 * reach-dm.ts, 2026-11-01): palette, state, notes, drives, Raziel's state, shared objects for the inter-companion
 * note, orient (the ask_question held-questions guard), creatures, drifts, preferences. Anything else is a write
 * or unknown and is blocked. NOTE `ask` is deliberately NOT here: it is the generic request path and carries
 * every write (librarianWriteChecked); the read helpers that use it internally (getState) run on the real object.
 */
export const LIBRARIAN_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  "getEligibleMetronomePalette", "getState", "getRecentNotes", "getDrives", "getRazielState",
  "fetchSharedObjects", "botOrient", "creaturesList", "driftsOpen", "getPreferences",
]);

/** Safe answers for the writes the heartbeat is known to make, so callers proceed as if they succeeded. */
const LIBRARIAN_STUBS: Record<string, unknown> = {
  reachReserve: { reserved: true, id: -1 },
  reachRelease: true,
  reachDelivered: true,
  writeAutonomyRun: "dryrun:run",
  patchAutonomyRun: undefined,
  recordMetronomeActionFired: undefined,
  ask: { ack: true, id: "dryrun:ask" },
  writeWmNote: undefined,
  journalSpeech: undefined,
  convoOpen: undefined,
  interactCreature: undefined,
  declarePreference: { id: "dryrun:pref" },
  postQuestion: undefined,
  driftOpen: { id: "dryrun:drift" },
};

export const DRY_RUN_MARK = Symbol.for("nullsafe.heartbeat.dryRunProxy");

export function isDryRunProxy(x: unknown): boolean {
  try { return typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[DRY_RUN_MARK] === true; } catch { return false; }
}

export function dryRunLibrarian<T extends object>(real: T, sink: DryRunSink): T {
  return new Proxy(real, {
    get(target, prop, _recv) {
      if (prop === DRY_RUN_MARK) return true;
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      const v = (target as Record<string, unknown>)[prop];
      if (typeof v !== "function") return v; // data (url, companionId): harmless
      if (LIBRARIAN_READ_ALLOWLIST.has(prop)) return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
      return (..._args: unknown[]) => {
        const known = Object.prototype.hasOwnProperty.call(LIBRARIAN_STUBS, prop);
        sink.blocked("librarian", prop, known ? undefined : "not on the read allow-list (blocked by default)");
        const stub = known ? LIBRARIAN_STUBS[prop] : undefined;
        return Promise.resolve(stub && typeof stub === "object" ? { ...(stub as object) } : stub);
      };
    },
    has(target, prop) { return prop === DRY_RUN_MARK || Reflect.has(target, prop); },
  }) as T;
}

/** Redis commands that only read. Everything else is a write (or unknown) and is a recorded no-op. */
export const REDIS_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  "get", "mget", "exists", "ttl", "pttl", "type", "strlen",
  "hget", "hgetall", "hmget", "hexists", "hlen", "hkeys", "hvals",
  "lrange", "llen", "lindex",
  "zrange", "zrevrange", "zrangebyscore", "zrevrangebyscore", "zscore", "zcard", "zcount", "zrank", "zrevrank",
  "smembers", "sismember", "scard",
]);

/** What a blocked write answers, shaped so the caller proceeds (SET NX -> "OK" so the floor lock "succeeds"). */
function redisNoop(cmd: string, args: unknown[]): unknown {
  switch (cmd) {
    case "set": return "OK";
    case "setex": case "psetex": case "mset": case "hmset": return "OK";
    default: return 0;
  }
}

export function dryRunRedis<T extends object>(real: T, sink: DryRunSink): T {
  return new Proxy(real, {
    get(target, prop, _recv) {
      if (prop === DRY_RUN_MARK) return true;
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      const v = (target as Record<string, unknown>)[prop];
      if (typeof v !== "function") return v;
      if (REDIS_READ_ALLOWLIST.has(prop)) return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
      // `on` / `once` / `off` are listener wiring on the client object, not Redis commands: a no-op, not a "write".
      if (prop === "on" || prop === "once" || prop === "off" || prop === "removeListener") return () => target;
      return (...args: unknown[]) => {
        sink.blocked("redis", prop, typeof args[0] === "string" ? String(args[0]).slice(0, 60) : undefined);
        return Promise.resolve(redisNoop(prop, args));
      };
    },
    has(target, prop) { return prop === DRY_RUN_MARK || Reflect.has(target, prop); },
  }) as T;
}

/** A fake sent message: sinks capture the text instead of posting it. */
function fakeMessage(id: string, content: string): { id: string; content: string } { return { id, content }; }

const CHANNEL_READ_FNS = new Set(["isTextBased", "isThread", "isDMBased", "isVoiceBased", "toString"]);

function dryRunChannel(real: Record<string, unknown>, sink: DryRunSink, counter: { n: number }): unknown {
  return new Proxy(real, {
    get(target, prop, _recv) {
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      const v = target[prop];
      if (prop === "send") {
        return async (payload: unknown) => {
          const text = typeof payload === "string" ? payload : String((payload as { content?: unknown })?.content ?? "");
          counter.n++;
          sink.compose("discord channel send (captured, NOT posted)", "send", text);
          return fakeMessage(`dryrun:${counter.n}`, text);
        };
      }
      if (typeof v !== "function") return v;
      if (CHANNEL_READ_FNS.has(prop)) return (...a: unknown[]) => (v as (...x: unknown[]) => unknown).apply(target, a);
      return async (..._a: unknown[]) => { sink.blocked("discord channel", prop); return undefined; };
    },
  });
}

export function dryRunClient<T extends object>(real: T, sink: DryRunSink): T {
  const counter = { n: 0 };
  const channels = (real as { channels?: { fetch?: (id: string) => Promise<unknown> } }).channels;
  return new Proxy(real, {
    get(target, prop, _recv) {
      if (prop === DRY_RUN_MARK) return true;
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      if (prop === "channels") {
        return {
          fetch: async (id: string) => {
            const ch = await channels?.fetch?.(id);
            return ch && typeof ch === "object" ? dryRunChannel(ch as Record<string, unknown>, sink, counter) : ch;
          },
        };
      }
      const v = (target as Record<string, unknown>)[prop];
      if (typeof v !== "function") return v; // user, etc.
      return async (..._a: unknown[]) => { sink.blocked("discord client", prop); return undefined; };
    },
  }) as T;
}

type Lane = NonNullable<AutonomousContext["ownerDm"]>;

/** The owner-DM lane: resolve() stays real (it opens/seals the DM channel, no message), the target's send is
 *  captured, recentOwnTexts stays real (the verbatim check should see what he really got), onSent is a no-op. */
export function dryRunOwnerDm(real: Lane, sink: DryRunSink): Lane {
  let n = 0;
  return {
    resolve: async () => {
      const t = await real.resolve();
      if (!t) return t;
      return {
        channelId: t.channelId,
        recentOwnTexts: () => t.recentOwnTexts(),
        send: async (text: string) => {
          n++;
          sink.compose("owner DM (captured, NOT sent)", "dm", text);
          return `dryrun:dm:${n}`;
        },
      };
    },
    onSent: () => { sink.blocked("owner-dm lane", "onSent"); },
  };
}

/** A cycle guard that never counts. The real one is a stateful counter, so a dry run neither reads nor advances it. */
const NO_CYCLE_GUARD = { check: () => "ok", reset: () => {} } as unknown as AutonomousContext["cycleGuard"];

/** Build the dry-run ctx. Pure: returns the ctx plus the report the run fills in. */
export function dryRunCtx(ctx: AutonomousContext, opts: { force?: boolean } = {}): { ctx: AutonomousContext; report: DryRunReport } {
  const report = newDryRunReport(ctx.companionId, opts.force === true);
  const sink = makeSink(report);
  const real = ctx.sessionWindows;
  const dry: AutonomousContext = {
    ...ctx,
    dryRun: true,
    dryRunSink: sink,
    librarian: dryRunLibrarian(ctx.librarian, sink),
    redis: ctx.redis ? dryRunRedis(ctx.redis, sink) : null,
    client: dryRunClient(ctx.client, sink),
    ownerDm: ctx.ownerDm ? dryRunOwnerDm(ctx.ownerDm, sink) : undefined,
    registerSentId: () => { sink.blocked("handler", "registerSentId"); },
    cycleGuard: NO_CYCLE_GUARD,
    // Copies: markCooldown / pushBuffered land on these, never on the bot's live maps.
    cooldown: new Map(ctx.cooldown),
    messageBuffer: [...ctx.messageBuffer],
    // Read-only view of the session windows (isAnyActive is the one thing the heartbeat asks).
    sessionWindows: { isAnyActive: () => real.isAnyActive() } as unknown as AutonomousContext["sessionWindows"],
  };
  return { ctx: dry, report };
}

// ── The registry (the command handler finds the live ctx here) ──────────────

const registry = new Map<string, AutonomousContext>();
export function registerHeartbeatCtx(ctx: AutonomousContext): void { registry.set(ctx.companionId, ctx); }
export function getHeartbeatCtx(companionId: string): AutonomousContext | undefined { return registry.get(companionId); }

// ── Formatting ──────────────────────────────────────────────────────────────

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}... [+${s.length - n} chars]` : s);
const noDash = (s: string) => s.replace(/—/g, ";").replace(/–/g, "-");

/** One phone-readable reply. Plain text, no em dashes; long text capped (the full text is never sent anywhere). */
export function formatDryRunReport(r: DryRunReport): string {
  const out: string[] = [];
  out.push(`DRY RUN heartbeat (${r.companionId})${r.force ? " [force: time/window/activity/quiet gates skipped]" : ""}. Nothing was sent, reserved or recorded.`);
  if (r.error) out.push(`ERROR: the run threw: ${cap(r.error, 300)}`);
  const stoppedBy = r.outcome && r.outcome !== "chose_to_act" ? r.outcome : null;
  if (r.gates.length > 0) {
    out.push("Gates:");
    for (const g of r.gates) out.push(`${g.passed ? "pass" : g.forced ? "skip (force)" : "STOP"} ${g.name}${g.detail ? ` (${cap(g.detail, 140)})` : ""}`);
  }
  if (r.paletteSize !== null) out.push(`Palette: ${r.paletteSize}${r.paletteNames.length ? ` (${cap(r.paletteNames.join(", "), 300)})` : ""}`);
  if (r.move) out.push(`Move: ${r.move}${r.moveReason ? ` -- ${cap(r.moveReason, 200)}` : ""}`);
  else if (r.decisionRaw) out.push(`Decision raw: ${cap(r.decisionRaw, 300)}`);
  out.push(`Outcome: ${r.outcome ?? "none"}${r.info.reason ? ` (${cap(r.info.reason, 200)})` : ""}${stoppedBy ? " -- this is where it stopped" : ""}`);
  if (r.composed.length > 0) {
    for (const c of r.composed) out.push(`Would send via ${c.seam}${c.note ? ` [${c.note}]` : ""}:\n> ${cap(c.text, 700).replace(/\n/g, "\n> ")}`);
  } else if (r.move && r.move !== "nothing") {
    out.push("Composed line: none (the move produced nothing sendable, or it writes only to Halseth, which is blocked).");
  } else {
    out.push("Composed line: none.");
  }
  if (r.notes.length > 0) out.push(`Notes: ${cap(r.notes.join("; "), 500)}`);
  if (r.blocked.length > 0) {
    const counts = new Map<string, number>();
    for (const b of r.blocked) { const k = `${b.surface}.${b.op}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    out.push(`Blocked writes (${r.blocked.length}): ${cap([...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(", "), 400)}`);
  }
  return noDash(out.join("\n"));
}

// ── The runner ──────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

/**
 * Run the REAL heartbeat against the dry-run ctx and return the report. Never throws: a throw from the
 * heartbeat lands in report.error. One run per companion at a time.
 */
export async function runDryRunHeartbeat(
  live: AutonomousContext,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<DryRunReport> {
  const { ctx, report } = dryRunCtx(live, { force: opts.force });
  if (inFlight.has(live.companionId)) {
    report.error = "a dry run is already running for this companion";
    return report;
  }
  inFlight.add(live.companionId);
  try {
    // Imported lazily-by-position, not by cycle: autonomous-core only type-imports this module.
    const { runHeartbeat } = await import("./autonomous-core.js");
    const timeoutMs = opts.timeoutMs ?? 300_000;
    await Promise.race([
      runHeartbeat(ctx),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`dry run timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref?.()),
    ]);
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  } finally {
    inFlight.delete(live.companionId);
  }
  return report;
}
