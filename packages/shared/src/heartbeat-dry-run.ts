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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutonomousContext } from "./autonomous-core.js";
import { withCaller, type InferenceAdapter } from "./inference.js";
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
  /** Which voice composed the text, and where its SOUL came from. */
  voice: string | null;
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
  voice(text: string): void;
  finish(outcome: HeartbeatOutcome | null, info: HeartbeatTickInfo): void;
}

export function newDryRunReport(companionId: string, force: boolean): DryRunReport {
  return {
    companionId, force, gates: [], paletteSize: null, paletteNames: [], decisionRaw: null, move: null, moveReason: null,
    composed: [], blocked: [], notes: [], outcome: null, info: {}, error: null, voice: null,
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
    voice: (text) => safe(() => { report.voice = text; }),
    finish: (outcome, info) => safe(() => { report.outcome = outcome; report.info = info; }),
  };
}

// ── Deny-by-default proxies ─────────────────────────────────────────────────

/**
 * The Librarian methods the heartbeat path calls that are PURE READS, each verified by following it into halseth
 * (2026-11-01 audit; no INSERT/UPDATE/DELETE, no heat warming, no delivery marking, no session open):
 *   getEligibleMetronomePalette -> GET /mind/metronome/actions/:id/eligible (listActions, reachLaneVerdict, readCareHold)
 *   getRecentNotes   -> GET /mind/notes/recent (readRecentNotes)
 *   getDrives        -> GET /mind/drives/:id (readDrivesSql, pure accrual math)
 *   getRazielState   -> GET /biometrics/latest (one SELECT)
 *   fetchSharedObjects -> GET /mind/questions/:id, /companion-growth/tensions/:id, /mind/council/next-open (SELECTs)
 *   creaturesList    -> GET /mind/creatures (SELECTs + pure liveState)
 *   driftsOpen       -> GET /drifts/:id (readDrifts, one SELECT)
 *   getPreferences   -> GET /agency/preferences/:id (readPreferences, one SELECT)
 * DELIBERATELY NOT here: `botOrient` (execBotOrient warms heat and runs markAnswersDelivered, consuming Raziel's
 * answered questions), `getState` (it is `ask("my state")`: the Librarian classifier can route that to a session
 * open), and `ask` itself (the generic path that carries every write). Those are stubbed and recorded.
 */
export const LIBRARIAN_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  "getEligibleMetronomePalette", "getRecentNotes", "getDrives", "getRazielState",
  "fetchSharedObjects", "creaturesList", "driftsOpen", "getPreferences",
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
  // Reads that are NOT pure (see the allow-list note). getState is answered by `pureState` below instead when it can
  // be; this empty answer is only the fallback.
  getState: {},
  botOrient: {},
  writeWmNote: undefined,
  journalSpeech: undefined,
  convoOpen: undefined,
  interactCreature: undefined,
  declarePreference: { id: "dryrun:pref" },
  postQuestion: undefined,
  driftOpen: { id: "dryrun:drift" },
};

/** The librarian fields pureState needs (private on the class; read structurally). */
interface PureStateClient { url?: string; secret?: string; _fetch?: typeof fetch; companionId?: string }

/**
 * The heartbeat's `getState()` shape (soma_float_1..3) from GET /mind/state/:id. felt.soma_floats is ordered
 * float_1..3 (heat/reach/weight for Drevan). Any failure = {} (the decision prompt lacks floats, as before) and a note.
 */
export async function pureState(c: PureStateClient, sink: DryRunSink): Promise<Record<string, unknown>> {
  try {
    if (!c.url || !c.secret || !c.companionId) throw new Error("librarian has no url/secret/companion");
    const f = c._fetch ?? fetch;
    const res = await f(`${c.url}/mind/state/${encodeURIComponent(c.companionId)}`, {
      headers: { Authorization: `Bearer ${c.secret}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`mind/state ${res.status}`);
    const d = (await res.json()) as { felt?: { soma_floats?: Array<{ label?: string; value?: number | null }> } };
    const fl = d.felt?.soma_floats ?? [];
    const out: Record<string, unknown> = {};
    fl.slice(0, 3).forEach((x, i) => { if (typeof x?.value === "number") out[`soma_float_${i + 1}`] = x.value; });
    sink.note(`own state from the pure mind loader: ${fl.slice(0, 3).map((x) => `${x?.label ?? "?"}=${x?.value ?? "?"}`).join(", ") || "no floats"}`);
    return out;
  } catch (e) {
    sink.note(`own state unavailable (${String(e).slice(0, 80)}); decided without soma floats`);
    return {};
  }
}

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
      // getState is `ask("my state")` (can route to a session open), so it never runs. Its floats come from the
      // pure-D1 mind loader instead (GET /mind/state/:id, the read Hearth uses; no heat warming, no session).
      if (prop === "getState") return () => pureState(target as unknown as PureStateClient, sink);
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

// ── The direct, tool-less inference lane ────────────────────────────────────
//
// Hermes runs the FULL agent with Halseth MCP tools on every call, and the gateway IGNORES tool_choice "none" and
// tools [] (verified on the VPS 2026-11-01), so a Hermes compose could write feelings/notes/journals mid-dry-run
// past every proxy. A dry run therefore NEVER calls Hermes: every inference goes through the direct adapter (the
// judges' lane, DeepInfra via withCaller), tool-less by construction, with the companion's Hermes SOUL prepended.

export interface SoulLoad { text: string | null; path: string; source: "soul" | "fallback" }

/** Where the companion's Hermes SOUL.md lives: Cypher is the default profile, Drevan and Gaia have named profiles. */
export function hermesSoulPath(companionId: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const base = (env["HERMES_HOME"] ?? "").trim() || join(home, ".hermes");
  return companionId === "cypher" ? join(base, "SOUL.md") : join(base, "profiles", companionId, "SOUL.md");
}

export function loadSoul(
  companionId: string,
  o: { read?: (path: string) => string; env?: Record<string, string | undefined>; home?: string } = {},
): SoulLoad {
  const path = hermesSoulPath(companionId, o.env, o.home);
  try {
    const text = (o.read ?? ((p: string) => readFileSync(p, "utf8")))(path).trim();
    if (text) return { text, path, source: "soul" };
  } catch { /* fall through */ }
  return { text: null, path, source: "fallback" };
}

/** The dry ctx's inference: direct lane, SOUL first, session ids dropped (the direct adapters take none). */
export function dryRunInference(direct: InferenceAdapter | null | undefined, soul: SoulLoad | null): InferenceAdapter {
  if (!direct) {
    return { generate: async () => { throw new Error("dry run: no direct inference lane; refusing to fall back to Hermes"); } } as InferenceAdapter;
  }
  const lane = withCaller(direct, "heartbeat_dry_run");
  return {
    generate: (...args: Parameters<InferenceAdapter["generate"]>) => {
      const [system, messages, temperature, maxTokens] = args;
      const sys = soul?.text ? `${soul.text}\n\n${system ?? ""}` : (system ?? "");
      return lane.generate(sys, messages, temperature, maxTokens);
    },
  } as InferenceAdapter;
}

/** A cycle guard that never counts. The real one is a stateful counter, so a dry run neither reads nor advances it. */
const NO_CYCLE_GUARD = { check: () => "ok", reset: () => {} } as unknown as AutonomousContext["cycleGuard"];

/** Build the dry-run ctx. Pure: returns the ctx plus the report the run fills in. */
export function dryRunCtx(
  ctx: AutonomousContext,
  opts: { force?: boolean; directAdapter?: InferenceAdapter | null; soul?: SoulLoad | null } = {},
): { ctx: AutonomousContext; report: DryRunReport } {
  const report = newDryRunReport(ctx.companionId, opts.force === true);
  const sink = makeSink(report);
  const real = ctx.sessionWindows;
  const dry: AutonomousContext = {
    ...ctx,
    // The live ctx.inference (Hermes) is replaced unconditionally: it is unreachable from the dry ctx.
    inference: dryRunInference(opts.directAdapter, opts.soul ?? null),
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
  if (r.voice) out.push(`Voice: ${r.voice}`);
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
    out.push(`Not called in a dry run (${r.blocked.length}; writes, plus reads that are not pure): ${cap([...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(", "), 400)}`);
  }
  out.push("Note: your typing this command counts as you being here (it refreshes your last-activity and settles open DM reach-outs as replied).");
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
  opts: { force?: boolean; timeoutMs?: number; directAdapter?: InferenceAdapter | null; soul?: SoulLoad | null } = {},
): Promise<DryRunReport> {
  const soul = opts.soul ?? loadSoul(live.companionId);
  const { ctx, report } = dryRunCtx(live, { force: opts.force, directAdapter: opts.directAdapter, soul });
  report.voice = opts.directAdapter
    ? `composed on the direct lane with ${live.companionId}'s SOUL, no tools: the move is the real decision path, the voice is close but not the Hermes line`
      + (soul.source === "soul" ? ` (SOUL: ${soul.path})` : ` (SOUL unreadable at ${soul.path}: used the bot's own system prompt only)`)
    : null;
  if (!opts.directAdapter) {
    // Fail CLOSED: nothing below this line runs, so no inference of any kind happens, Hermes or otherwise.
    report.error = "no direct inference lane (no DEEPINFRA key on this bot); the dry run stopped before any inference rather than fall back to Hermes";
    return report;
  }
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

/** Split a long report into Discord-sized pieces on line boundaries. */
export function chunkReport(text: string, max = 1900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const l = line.length > max ? line.slice(0, max) : line;
    if (cur && cur.length + 1 + l.length > max) { out.push(cur); cur = l; } else { cur = cur ? `${cur}\n${l}` : l; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Deliver the report to the OWNER's DM (it quotes would-be DM text; the typing channel may be a guild room others read).
 * A reply to his own command, not a reach-out: it uses the lane's resolve()/target.send only, never speakToOwnerDm, so
 * no reach cap, reserve or ledger row is touched. Returns false when the DM could not be reached.
 */
export async function sendReportToOwnerDm(live: AutonomousContext, report: string): Promise<boolean> {
  try {
    const target = live.ownerDm ? await live.ownerDm.resolve() : null;
    if (!target) return false;
    for (const part of chunkReport(report)) await target.send(part);
    return true;
  } catch { return false; }
}
