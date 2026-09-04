// director/index.ts -- the loom, not a mind. Wires Redis events + the supply poll + the silence floor
// through one decide() and publishes invitations. Shadow mode records what it would have done.
import { randomUUID } from "node:crypto";
import cron from "node-cron";
import {
  createSubscriberClient, onCommonsMessage, onDirectorResult, publishDirectorInvite,
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
  cfg: { turnBudget: number; noUptakeMs: number; inviteTtlMs: number; order: "heat" | "recency"; limbic: boolean };
  now: () => number;
}
const HUMAN_FLOOR_MS = 5 * 60_000;
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

async function issue(sel: Extract<Selection, { kind: "invite" }>, s: ConversationState, rt: DirectorRuntime): Promise<void> {
  const inviteId = randomUUID();
  const nowMs = rt.now();
  await recordInvitation({ id: inviteId, channel_id: s.channelId, thread_id: s.threadId, companion_id: sel.companionId, reason: sel.reason, offer_ids: sel.offer.map((o) => o.id), outcome: rt.mode === "shadow" ? "shadow" : "issued" });
  console.log(`[director] ${rt.mode}: ${sel.reason} -> ${sel.companionId} in ${s.channelId} (offer=${sel.offer.map((o) => o.id).join(",") || "none"})`);
  if (rt.mode === "shadow") return;
  const hood = await getDirectorNeighborhood(sel.companionId, seedsFor(s, sel.companionId, rt.pool.items()));
  const invite = buildInvite(sel, s, { neighborhoodBlock: hood.lines.length ? hood.lines.join("\n") : undefined }, rt.cfg, { inviteId, nowMs });
  const next: ConversationState = { ...s, offered: [...s.offered, ...sel.offer.map((o) => ({ id: o.id, kind: o.kind, toCompanion: sel.companionId, inviteId, usedBy: null }))] };
  await rt.store.save(next);
  await publishDirectorInvite(rt.redis, invite);
}

export async function decide(channelId: string, rt: DirectorRuntime): Promise<void> {
  const s = await rt.store.load(channelId);
  if (!s) return;
  const sel = select({ state: s, supply: rt.pool.items(), nowMs: rt.now(), turnBudget: rt.cfg.turnBudget, noUptakeMs: rt.cfg.noUptakeMs, humanFloorMs: HUMAN_FLOOR_MS, order: rt.cfg.order });
  if (sel.kind === "invite") { await issue(sel, s, rt); return; }
  if (rt.mode === "live" && (sel.reason === "budget" || sel.reason === "no_uptake")) {
    const reasonCode = sel.reason === "budget" ? "turn_budget" : "no_uptake";
    if (s.threadId) {
      const ok = await rt.ledger.fade(s.threadId, reasonCode);
      console.log(`[director] faded ${s.threadId} (${sel.reason}, ack=${ok})`);
    } else {
      console.log(`[director] cleared ${channelId} (${sel.reason}, no thread to fade)`);
    }
    await rt.store.clear(channelId);
    knownChannels.add(channelId);
  } else if (sel.reason !== "nothing_to_add") {
    console.log(`[director] silence: ${sel.reason} in ${channelId}`);
  }
}

export async function handleMessage(p: CommonsMessagePayload, rt: DirectorRuntime): Promise<void> {
  knownChannels.add(p.channelId);
  const s = await ingest(p, { store: rt.store, ledger: rt.ledger, now: () => new Date(rt.now()).toISOString() });
  if (!s) return;
  await decide(p.channelId, rt);
}

export async function handleResult(r: DirectorResultPayload, rt: DirectorRuntime): Promise<void> {
  await resolveInvitation(r.inviteId, r.outcome, r.messageId, r.usedOfferIds);
  const s = await rt.store.load(r.channelId);
  if (!s) return;
  const offered = s.offered.map((o) => (o.inviteId === r.inviteId && r.usedOfferIds.includes(o.id) ? { ...o, usedBy: r.companionId } : o));
  await rt.store.save({ ...s, offered });
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
      await rt.store.clear(r.channelId);
    }
  }
}

async function floorTick(rt: DirectorRuntime): Promise<void> {
  const cfg = directorConfig();
  const states: ConversationState[] = [];
  for (const ch of [...knownChannels, ...cfg.channels]) {
    states.push((await rt.store.load(ch)) ?? emptyState(ch, new Date(rt.now()).toISOString()));
  }
  const turns7d: Record<CompanionId, number> = { cypher: 0, drevan: 0, gaia: 0 };
  for (const s of states) for (const t of s.turns) if (t.companionId) turns7d[t.companionId]++;
  const pick = floorSelection({ states, supply: rt.pool.items(), nowMs: rt.now(), silenceHours: cfg.silenceHours, wakingStartHour: cfg.wakingStartHour, wakingEndHour: cfg.wakingEndHour, tzOffsetHours: cfg.tzOffsetHours, turnsBySpeaker7d: turns7d });
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
    cfg: { turnBudget: cfg.turnBudget, noUptakeMs: cfg.noUptakeMs, inviteTtlMs: cfg.inviteTtlMs, order: cfg.order, limbic: cfg.limbic },
    now: () => Date.now(),
  };
  for (const ch of cfg.channels) knownChannels.add(ch);
  const sub = createSubscriberClient(deps.redisUrl);
  const offMsg = onCommonsMessage(sub, (p) => handleMessage(p, rt).catch((e) => console.error("[director] message failed:", e)));
  const offRes = onDirectorResult(sub, (r) => handleResult(r, rt).catch((e) => console.error("[director] result failed:", e)));
  rt.pool.poll().catch(() => {});
  const pollTimer = setInterval(() => rt.pool.poll().catch(() => {}), cfg.supplyPollMs);
  const floorJob = cron.schedule("*/15 * * * *", () => { floorTick(rt).catch((e) => console.error("[director] floor failed:", e)); });
  console.log(`[director] started mode=${cfg.mode} channels=${cfg.channels.join(",") || "(commons via bots)"} poll=${cfg.supplyPollMs}ms`);
  return async () => { offMsg(); offRes(); clearInterval(pollTimer); floorJob.stop(); await sub.quit().catch(() => {}); };
}
