// director/index.ts -- the loom, not a mind. Wires Redis events + the supply poll + the silence floor
// through one decide() and publishes invitations. Shadow mode records what it would have done.
//
// Deploy order (2026-09-03 review): worker FIRST, then bots. The bots' liveness gate
// (shouldDeferToDirector) checks `director:alive` before deferring a companion turn to this
// process, so a worker deploy that lags the bots leaves that key stale and companion turns fall
// back to each bot's own reply path (not silence) until the worker's next 20s heartbeat write.
// Rollback is the mirror: bots FIRST, then worker -- rolling back the worker alone while newer
// bots still expect it live would strand every in-flight invite. A rollback of either half leaves
// `director:*` Redis keys (state, seen, alive) and `director:supply:cursor` in place; they are
// TTL'd or self-healing (the cursor resumes forward, seen/state expire) so nothing needs manual
// cleanup after a rollback.
import { randomUUID } from "node:crypto";
import cron from "node-cron";
import {
  createSubscriberClient, onCommonsMessage, onDirectorResult, publishDirectorInvite,
  directorJevEnabled, directorEchoEval, directorVetoEval, renderDirectorJevState, appendDirectorJevLine,
  readEchoBrakeConfig, readVetoTheta, echoBrakeStep, LOOP_BREAK_STEER,
  type DirectorNoulResult, type EchoBrakeConfig, type EchoAction,
  type Redis, type CommonsMessagePayload, type DirectorResultPayload, type DirectorSupplyItem,
} from "@nullsafe/shared";
import { getDirectorSupply, getDirectorNeighborhood, recordInvitation, resolveInvitation, consumeForageFind } from "../halseth-client.js";
import { directorConfig } from "./config.js";
import { createRedisStateStore, type StateStore } from "./state.js";
import { createSupplyPool, type SupplyPool } from "./supply.js";
import { createHalsethLedger, type Ledger } from "./ledger.js";
import { ingest } from "./ingest.js";
import { select, type Selection } from "./select.js";
import { floorSelection } from "./floor.js";
import { buildInvite } from "./invite.js";
import { emptyState, type ConversationState, type CompanionId } from "./types.js";

export interface DirectorRuntime {
  mode: "shadow" | "live"; redis: Redis; store: StateStore; ledger: Ledger; pool: SupplyPool;
  cfg: { turnBudget: number; noUptakeMs: number; inviteTtlMs: number; order: "heat" | "recency"; limbic: boolean; minGapMs: number };
  now: () => number;
}
const HUMAN_FLOOR_MS = 5 * 60_000;
const ALIVE_KEY = "director:alive";
const ALIVE_TICK_MS = 20_000;
const ALIVE_TTL_S = 60;
const knownChannels = new Set<string>();

function seedsFor(s: ConversationState, who: CompanionId, supply: DirectorSupplyItem[]): Array<{ table: string; id: string }> {
  // The invitee's OWN rows (multi-hub gravity) + what this thread has already been handed. Never companions/<id>.
  return supply
    .filter((it) => it.owner === who && ["tension", "project", "question"].includes(it.kind))
    .slice(0, 6)
    .map((it) => ({ table: it.table, id: it.id }))
    .concat(s.offered.slice(-4).map((o) => ({ table: tableFor(o.kind), id: o.id })));
}
function tableFor(kind: DirectorSupplyItem["kind"]): string {
  return ({ forage: "forage_finds", listen: "media_experiences", question: "companion_questions", tension: "companion_tensions", project: "companion_projects", club: "club_rounds", council: "council_questions", inter_note: "inter_companion_notes", sibling_note: "wm_continuity_notes", care_fact: "care_actions" } as const)[kind];
}

/**
 * Jev beside select() (2026-10-20 redesign, shared/director-jev.ts). Two SEPARATE calls per decide on a
 * commons message (event-triggered, never the floor timer): the echo read (feeds the live brake) and,
 * when the director picks someone, a shadow-only veto check on that companion. Never throws; a failed
 * call is a logged reason. Returns the echo promise so decide() can act on it before inviting.
 */
export type EchoRead = DirectorNoulResult | null;
const COMPANION_IDS: readonly string[] = ["cypher", "drevan", "gaia"];

/** One echo read -> the director's action. A HUMAN summons is steered but never braked; non-"on" modes act on nothing. */
export function resolveEcho(s: ConversationState, sel: Selection, read: EchoRead, cfg: EchoBrakeConfig): { echoing: boolean; streak: number; raw: EchoAction; effective: EchoAction } {
  const step = echoBrakeStep({ p: read && read.ok ? read.p : null, botTurns: s.botTurns, streak: s.echoStreak ?? 0, cfg });
  const humanSummons = sel.kind === "invite" && sel.reason === "addressed" && !!sel.addressedBy && !COMPANION_IDS.includes(sel.addressedBy);
  const raw: EchoAction = humanSummons && step.action === "brake" ? "steer" : step.action;
  return { echoing: step.echoing, streak: step.streak, raw, effective: cfg.mode === "on" ? raw : "none" };
}

export interface DirectorJevDeps {
  echoFn?: typeof directorEchoEval; vetoFn?: typeof directorVetoEval; log?: typeof appendDirectorJevLine;
  brakeCfg?: EchoBrakeConfig; vetoTheta?: number;
}

export function fireDirectorJev(s: ConversationState, sel: Selection, paced: boolean, rt: Pick<DirectorRuntime, "cfg">, deps: DirectorJevDeps = {}): { echo: Promise<EchoRead>; done: Promise<void> } {
  if (!directorJevEnabled()) return { echo: Promise.resolve(null), done: Promise.resolve() };
  const echoFn = deps.echoFn ?? directorEchoEval;
  const vetoFn = deps.vetoFn ?? directorVetoEval;
  const log = deps.log ?? appendDirectorJevLine;
  const cfg = deps.brakeCfg ?? readEchoBrakeConfig();
  const vetoTheta = deps.vetoTheta ?? readVetoTheta();
  const state = renderDirectorJevState({ turns: s.turns, topic: s.topic, openMoves: s.openMoves, botTurns: s.botTurns, turnBudget: rt.cfg.turnBudget });
  const last = s.turns[s.turns.length - 1];
  const director = sel.kind === "invite"
    ? { kind: "invite" as const, companion: sel.companionId, reason: sel.reason, paced }
    : { kind: "silence" as const, reason: sel.reason };
  const safe = (p: Promise<DirectorNoulResult>): Promise<DirectorNoulResult> => p.catch((e) => ({ ok: false as const, reason: `throw:${String(e).slice(0, 80)}`, wall_ms: 0 }));
  const echo = safe(echoFn(state));
  // A paced invite is never issued, so there is nothing to veto.
  const veto = sel.kind === "invite" && !paced ? safe(vetoFn(state, sel.companionId)) : null;
  const done = Promise.all([echo, veto]).then(([e, v]) => {
    const r = resolveEcho(s, sel, e, cfg);
    log({
      kind: "decide", channel_id: s.channelId, after_msg_id: last?.messageId ?? null,
      after_author: last ? (last.companionId ?? last.author) : null, bot_turns: s.botTurns,
      director,
      echo: { p: e.ok ? e.p : null, failure: e.ok ? null : e.reason, wall_ms: e.wall_ms, mode: cfg.mode, streak: r.streak, echoing: r.echoing, action: r.raw, effective: r.effective },
      veto: sel.kind === "invite" && v ? { companion: sel.companionId, p: v.ok ? v.p : null, failure: v.ok ? null : v.reason, wall_ms: v.wall_ms, theta: vetoTheta, would_veto: v.ok ? v.p < vetoTheta : null } : null,
    });
    console.log(`[director-jev] ${s.channelId} director=${director.kind === "invite" && !paced ? director.companion : `silence:${director.kind === "invite" ? "pacing" : director.reason}`} echo=${e.ok ? e.p.toFixed(2) : "?"}/${r.effective}${v && v.ok ? ` veto_p=${v.p.toFixed(2)}${v.p < vetoTheta ? " WOULD_VETO" : ""}` : ""}`);
  }).catch((e) => { console.warn(`[director-jev] shadow failed: ${String(e).slice(0, 200)}`); });
  return { echo, done };
}

/**
 * Serialize async calls keyed by `key` on a shared chain map, so two events for the SAME key
 * (e.g. the same channel) never run concurrently while events for different keys still run in
 * parallel (2026-09-03 review, I1). A failure in one call is logged and does not break the chain
 * for the next call on that key.
 */
export function serializeByKey(chains: Map<string, Promise<void>>, key: string, fn: () => Promise<void>): Promise<void> {
  const chained = (chains.get(key) ?? Promise.resolve())
    .then(fn)
    .catch((e) => console.error(`[director] chain(${key}) failed:`, e));
  chains.set(key, chained);
  return chained;
}

async function issue(sel: Extract<Selection, { kind: "invite" }>, s: ConversationState, rt: DirectorRuntime, steer = false): Promise<void> {
  const inviteId = randomUUID();
  const nowMs = rt.now();
  try {
    await recordInvitation({ id: inviteId, channel_id: s.channelId, thread_id: s.threadId, companion_id: sel.companionId, reason: sel.reason, offer_ids: sel.offer.map((o) => o.id), outcome: rt.mode === "shadow" ? "shadow" : "issued" });
  } catch (e) {
    // I2: an unguarded recordInvitation failure used to throw out of issue() before the invite was
    // ever published, but AFTER select() had already committed to inviting -- the caller (decide/
    // floorTick) had no chance to recover, and the thrown error propagated as an unhandled
    // rejection in the message/result handler chain. Fail closed: no ledger row means no publish.
    console.error("[director] recordInvitation failed -- invite NOT published", e);
    return;
  }
  console.log(`[director] ${rt.mode}: ${sel.reason} -> ${sel.companionId} in ${s.channelId} (offer=${sel.offer.map((o) => o.id).join(",") || "none"})`);
  appendDirectorJevLine({ kind: "invite", invite_id: inviteId, channel_id: s.channelId, companion: sel.companionId, reason: sel.reason, mode: rt.mode, ...(steer ? { steer: "loop_break" } : {}) });
  const lastInviteAt = new Date(nowMs).toISOString();
  // I3: both modes record the pacing clock -- shadow saves state (nothing else changes for it)
  // so the shadow pacing gate in decide() mirrors what live would have done, even though only
  // live actually publishes.
  if (rt.mode === "shadow") { await rt.store.save({ ...s, lastInviteAt }); return; }
  const hood = await getDirectorNeighborhood(sel.companionId, seedsFor(s, sel.companionId, rt.pool.items()));
  const built = buildInvite(sel, s, { neighborhoodBlock: hood.lines.length ? hood.lines.join("\n") : undefined }, rt.cfg, { inviteId, nowMs });
  // Echo steer: the room is restating itself; the invitee is told so in the state block it already reads.
  const invite = steer ? { ...built, stateBlock: `${built.stateBlock}\n${LOOP_BREAK_STEER}` } : built;
  const next: ConversationState = { ...s, offered: [...s.offered, ...sel.offer.map((o) => ({ id: o.id, kind: o.kind, toCompanion: sel.companionId, inviteId, usedBy: null }))], lastInviteAt };
  await rt.store.save(next);
  await publishDirectorInvite(rt.redis, invite);
}

export async function decide(channelId: string, rt: DirectorRuntime, fromMessage = false): Promise<void> {
  const s = await rt.store.load(channelId);
  if (!s) return;
  const sel = select({ state: s, supply: rt.pool.items(), nowMs: rt.now(), turnBudget: rt.cfg.turnBudget, noUptakeMs: rt.cfg.noUptakeMs, humanFloorMs: HUMAN_FLOOR_MS, order: rt.cfg.order });
  const paced = sel.kind === "invite" && !!s.lastInviteAt && rt.now() - Date.parse(s.lastInviteAt) < rt.cfg.minGapMs;
  const jev = fromMessage ? fireDirectorJev(s, sel, paced, rt) : null;
  let steer = false;
  let cur = s;
  const brakeCfg = readEchoBrakeConfig();
  if (sel.kind === "invite" && !paced && jev && brakeCfg.mode !== "off") {
    // The brake decides BEFORE the invite, bounded by DIRECTOR_JEV_TIMEOUT_MS inside the call; a failure
    // or timeout reads as p=null and fails open (no steer, no brake, streak untouched).
    const r = resolveEcho(s, sel, await jev.echo, brakeCfg);
    cur = r.streak !== (s.echoStreak ?? 0) ? { ...s, echoStreak: r.streak } : s;
    if (r.effective === "brake") {
      console.log(`[director] silence: echo_brake (streak ${r.streak}) in ${channelId}`);
      await rt.store.save(cur);
      return;
    }
    steer = r.effective === "steer";
  }
  if (sel.kind === "invite") {
    // I3: pacing. A selection that WOULD invite is still throttled if the last invite in this
    // channel landed within minGapMs -- no record, no publish, just a log line. Prevents a burst
    // of fast-arriving commons messages from each independently qualifying for their own invite.
    if (s.lastInviteAt && rt.now() - Date.parse(s.lastInviteAt) < rt.cfg.minGapMs) {
      console.log(`[director] silence: pacing (last invite ${s.lastInviteAt}) in ${channelId}`);
      return;
    }
    await issue(sel, cur, rt, steer); return;
  }
  if (rt.mode === "live" && (sel.reason === "budget" || sel.reason === "no_uptake")) {
    const reasonCode = sel.reason === "budget" ? "turn_budget" : "no_uptake";
    if (s.threadId) {
      const ok = await rt.ledger.fade(s.threadId, reasonCode);
      console.log(`[director] faded ${s.threadId} (${sel.reason}, ack=${ok})`);
    } else {
      console.log(`[director] cleared ${channelId} (${sel.reason}, no thread to fade)`);
    }
    // C1: a hard clear() deletes the Redis key the silence floor's clock reads (lastBotAt /
    // startedAt), so a channel that just faded looks indistinguishable from one that was NEVER
    // seen -- floorTick would then seed it fresh at the next tick instead of measuring real
    // silence from THIS moment. Reset to an empty state (with startedAt = now) instead of
    // deleting it, so the floor's clock starts ticking immediately.
    await rt.store.save(emptyState(channelId, new Date(rt.now()).toISOString()));
    knownChannels.add(channelId);
  } else if (sel.reason !== "nothing_to_add") {
    console.log(`[director] silence: ${sel.reason} in ${channelId}`);
  }
}

export async function handleMessage(p: CommonsMessagePayload, rt: DirectorRuntime): Promise<void> {
  knownChannels.add(p.channelId);
  // C2: shadow mode must be inert against the Halseth ledger -- only live opens/appends
  // conversation_threads rows. writeLedger gates that inside ingest().
  const s = await ingest(p, { store: rt.store, ledger: rt.ledger, now: () => new Date(rt.now()).toISOString(), writeLedger: rt.mode === "live" });
  if (!s) return;
  const t = s.turns[s.turns.length - 1];
  if (t && directorJevEnabled()) appendDirectorJevLine({ kind: "turn", channel_id: p.channelId, msg_id: p.messageId, author: t.companionId ?? t.author, is_human: t.isHuman, said_at: t.saidAt });
  await decide(p.channelId, rt, true);
}

export async function handleResult(r: DirectorResultPayload, rt: DirectorRuntime): Promise<void> {
  await resolveInvitation(r.inviteId, r.outcome, r.messageId, r.usedOfferIds);
  appendDirectorJevLine({ kind: "result", invite_id: r.inviteId, channel_id: r.channelId, companion: r.companionId, outcome: r.outcome, msg_id: r.messageId ?? null });
  const s = await rt.store.load(r.channelId);
  if (!s) return;
  const offered = s.offered.map((o) => (o.inviteId === r.inviteId && r.usedOfferIds.includes(o.id) ? { ...o, usedBy: r.companionId } : o));
  // C3(c): a pass (or empty/expired) is an answer, not silence -- the open move that summoned
  // this companion is resolved either way. Without this, select()'s open-move rule (rule 2) keeps
  // re-inviting the same companion to the same unanswered summons forever.
  const openMoves = r.outcome === "spoke" ? s.openMoves : s.openMoves.filter((m) => m.to !== r.companionId);
  await rt.store.save({ ...s, offered, openMoves });
  // Post first, consume after: only a SPOKE result burns anything, and only what the post used.
  if (r.outcome === "spoke") {
    // The durable offer record, not the volatile pool -- the pool may have already evicted/dropped
    // the item by the time the result comes back, and a forage consume must not depend on that race.
    const kindOf = new Map(s.offered.map((o) => [o.id, o.kind]));
    for (const id of r.usedOfferIds) {
      if (kindOf.get(id) === "forage") await consumeForageFind(id, r.companionId).catch(() => false);
      rt.pool.remove(id);
    }
    if (r.landed && s.threadId) {
      const ok = await rt.ledger.land(s.threadId, r.landed, r.companionId);
      console.log(`[director] ${s.threadId} LANDED by ${r.companionId} (ack=${ok})`);
      // C1: reset, not clear -- see the note in decide(). A landed thread's channel starts a
      // fresh silence clock from this moment rather than vanishing from the floor's view.
      await rt.store.save(emptyState(r.channelId, new Date(rt.now()).toISOString()));
    }
  }
}

async function floorTick(rt: DirectorRuntime): Promise<void> {
  const cfg = directorConfig();
  const states: ConversationState[] = [];
  const nowIso = new Date(rt.now()).toISOString();
  // I4: knownChannels and cfg.channels overlap (every configured channel is added to
  // knownChannels at startup and again by handleMessage) -- iterating the concatenation double-
  // counted those channels' turns into turns7d, skewing the least-heard ordering. A Set dedupes.
  for (const ch of new Set([...knownChannels, ...cfg.channels])) {
    let st = await rt.store.load(ch);
    if (!st) {
      // C1(b): a channel with no stored state (never ingested, or just reset) must have its
      // floor clock start NOW, not silently resurrect on every tick with a startedAt that never
      // advances. Save the fresh state immediately so lastBotAt/startedAt persist across ticks.
      st = emptyState(ch, nowIso);
      await rt.store.save(st);
    }
    states.push(st);
  }
  const turns7d: Record<CompanionId, number> = { cypher: 0, drevan: 0, gaia: 0 };
  for (const s of states) for (const t of s.turns) if (t.companionId) turns7d[t.companionId]++;
  const pick = floorSelection({ states, supply: rt.pool.items(), nowMs: rt.now(), silenceHours: cfg.silenceHours, wakingStartHour: cfg.wakingStartHour, wakingEndHour: cfg.wakingEndHour, tz: cfg.tzOffsetHours ?? cfg.tz, turnsBySpeaker7d: turns7d });
  if (!pick) return;
  const s = states.find((x) => x.channelId === pick.channelId)!;
  await rt.store.save(s);
  await issue({ kind: "invite", companionId: pick.companionId, reason: "open", offer: [pick.offer] }, s, rt);
}

export function startDirector(deps: { redisUrl: string; redis: Redis }): () => Promise<void> {
  const cfg = directorConfig();
  if (cfg.mode === "off") { console.log("[director] DIRECTOR_ENABLED unset/off -- not starting"); return async () => {}; }
  const rt: DirectorRuntime = {
    mode: cfg.mode, redis: deps.redis, store: createRedisStateStore(deps.redis), ledger: createHalsethLedger(),
    pool: createSupplyPool({ fetch: getDirectorSupply, redis: deps.redis }),
    cfg: { turnBudget: cfg.turnBudget, noUptakeMs: cfg.noUptakeMs, inviteTtlMs: cfg.inviteTtlMs, order: cfg.order, limbic: cfg.limbic, minGapMs: cfg.minGapMs },
    now: () => Date.now(),
  };
  for (const ch of cfg.channels) knownChannels.add(ch);
  const sub = createSubscriberClient(deps.redisUrl);
  // I1: chain per-channel/per-result-channel so two events for the SAME channel never run
  // handleMessage/handleResult concurrently (a race could otherwise interleave two decide() calls
  // reading the same stale state). Different channels still run fully in parallel.
  const msgChains = new Map<string, Promise<void>>();
  const resultChains = new Map<string, Promise<void>>();
  const offMsg = onCommonsMessage(sub, (p) => { void serializeByKey(msgChains, p.channelId, () => handleMessage(p, rt)); });
  const offRes = onDirectorResult(sub, (r) => { void serializeByKey(resultChains, r.channelId, () => handleResult(r, rt)); });
  rt.pool.poll().catch(() => {});
  const pollTimer = setInterval(() => rt.pool.poll().catch(() => {}), cfg.supplyPollMs);
  const floorJob = cron.schedule("*/15 * * * *", () => { floorTick(rt).catch((e) => console.error("[director] floor failed:", e)); });
  // Liveness gate (2026-09-03 review): bots defer a companion turn to the director only while
  // this key is fresh. Runs in BOTH live and shadow -- shadow still owns the commons-message
  // subscription and must be provably alive too. Written once immediately (so a fast restart
  // doesn't leave a 20s gap where bots wrongly believe the director is down) and every 20s after,
  // with a 60s TTL so a crashed/hung process goes stale within one missed tick's grace.
  const writeAlive = () => { rt.redis.set(ALIVE_KEY, String(Date.now()), "EX", ALIVE_TTL_S).catch(() => {}); };
  writeAlive();
  const aliveTimer = setInterval(writeAlive, ALIVE_TICK_MS);
  console.log(`[director] started mode=${cfg.mode} channels=${cfg.channels.join(",") || "(commons via bots)"} poll=${cfg.supplyPollMs}ms`);
  return async () => { offMsg(); offRes(); clearInterval(pollTimer); clearInterval(aliveTimer); floorJob.stop(); await sub.quit().catch(() => {}); };
}
