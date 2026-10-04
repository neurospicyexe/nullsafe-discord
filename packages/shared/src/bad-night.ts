// packages/shared/src/bad-night.ts
//
// B32 "bad-night presence", the Discord half (spec: BBH Hand-off/DESIGN-B32-bad-night-presence-2026-10-03.md;
// section D is authoritative where it differs from B; section A is the text the triad approved).
//
// While care_hold is on, all three companions become ELIGIBLE to be with Raziel, not only whoever's
// window it is or whoever he named. Eligible is not obligated: each may come or pass, and nobody covers
// for a pass. Everything here is pure (or takes its Redis handle as a parameter) so the tests drive
// the same predicates the live paths use:
//
//   - badNightMode():        the knob. BAD_NIGHT_PRESENCE = off | shadow | on, default off, fails closed.
//   - matchHoldPhrase():     D3's deterministic floor. "bad night" starts the hold, "good now" /
//                            "I'm okay now" clears it, only as the whole message or its own sentence.
//   - careFollowUpChain():   B1. Who gets a follow-up position behind the companion he spoke to, with
//                            the 30-minute per-sibling throttle computed from shared channel history so
//                            every process builds the same chain (a follower that one process thinks is
//                            throttled and another does not would leave the one behind it waiting on a ghost).
//   - heartbeatHoldBypass(): B2. Under hold every companion's heartbeat tick is eligible.
//   - owner-DM liveness:     D4. A shared Redis key per companion, set on each owner-DM arrival.
//   - turn lines:            D3 opener, D5 absent sibling (reactive only), D6 Drevan's register, the
//                            "come as yourself" line for all, the companion's on-his-behalf verb.
//   - b32Log():              B5. One `[b32]` line per decision.
//
// SHADOW never touches Halseth and never changes who speaks: it logs `-> shadow` at every decision
// point. The care-hold route flips care_hold for every bot via orient, so even calling it is a
// behaviour change.

import type { CompanionId } from "./types.js";
import { ALL_COMPANIONS, VOCATIVE_ALIASES } from "./channel-config.js";
import { bidSpeakingOrder } from "./sequential-floor.js";

// ── The knob ─────────────────────────────────────────────────────────────────

export type BadNightMode = "off" | "shadow" | "on";

/**
 * BAD_NIGHT_PRESENCE: exactly `on` or `shadow` (trimmed, any case); anything else, unset included,
 * is `off`. Fails closed like REACH_DM (reach-dm.ts reachDmOn). Read per call so a reload takes effect.
 */
export function badNightMode(env: Record<string, string | undefined> = process.env): BadNightMode {
  const v = String(env["BAD_NIGHT_PRESENCE"] ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

// ── B5: one line per decision ────────────────────────────────────────────────

export type B32Outcome = "spoke" | "pass" | "throttled" | "capped" | "shadow" | "queued" | "held";

/** `[b32] <companion> eligible=<why> -> <outcome>` plus optional detail. Never throws. */
export function b32Line(companionId: string, eligible: string, outcome: B32Outcome | string, detail?: string): string {
  return `[b32] ${companionId} eligible=${eligible} -> ${outcome}${detail ? ` (${detail})` : ""}`;
}

export function b32Log(companionId: string, eligible: string, outcome: B32Outcome | string, detail?: string): void {
  try { console.log(b32Line(companionId, eligible, outcome, detail)); } catch { /* telemetry never breaks a turn */ }
}

// ── D3: the owner's phrase ───────────────────────────────────────────────────

export type HoldPhrase = "start" | "clear";

const START_PHRASES: ReadonlySet<string> = new Set(["bad night"]);
const CLEAR_PHRASES: ReadonlySet<string> = new Set([
  "good now", "i'm good now", "im good now",
  "i'm okay now", "im okay now", "i'm ok now", "im ok now",
]);

/** Every name a vocative can use, longest first so "drevan" is stripped before "dre". */
const VOCATIVE_NAMES: readonly string[] = ALL_COMPANIONS
  .flatMap(id => [id, ...(VOCATIVE_ALIASES[id] ?? [])])
  .concat(["triad", "you three", "all of you", "everyone"])
  .sort((a, b) => b.length - a.length);

function normalizeSentence(s: string): string {
  let t = s.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
  // Strip leading/trailing non-alphanumerics (punctuation, emoji, markdown asterisks).
  t = t.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  // One vocative at either end: "Dre, bad night" / "bad night, Cy". Never mid-sentence.
  for (const name of VOCATIVE_NAMES) {
    const lead = new RegExp(`^${name}\\s*[,:\\-]\\s*`);
    const trail = new RegExp(`\\s*,\\s*${name}$`);
    if (lead.test(t)) { t = t.replace(lead, ""); break; }
    if (trail.test(t)) { t = t.replace(trail, ""); break; }
  }
  return t.replace(/[^a-z0-9]+$/, "").trim();
}

/**
 * D3's deterministic floor. A sentence is a run between `.` `!` `?` `;` `…` or a newline; the phrase
 * must BE a sentence (case-insensitive, trailing punctuation and one vocative name allowed), never a
 * fragment of one. "I had a bad night's sleep" and "it was a bad night for the Cubs" do not match.
 * A message carrying both a start and a clear is ambiguous and matches neither.
 */
export function matchHoldPhrase(content: string): HoldPhrase | null {
  if (!content) return null;
  const sentences = content.split(/[.!?;\n…]+/);
  let start = false;
  let clear = false;
  for (const raw of sentences) {
    const s = normalizeSentence(raw);
    if (!s) continue;
    if (START_PHRASES.has(s)) start = true;
    if (CLEAR_PHRASES.has(s)) clear = true;
  }
  if (start && clear) return null;
  return start ? "start" : clear ? "clear" : null;
}

// ── B1: the follow-up chain ──────────────────────────────────────────────────

/** A sibling who spoke in this channel inside this window before his message gets no follow-up. */
export const CARE_FOLLOWUP_MIN_GAP_MS = 30 * 60_000;

/** One channel message, reduced to what the throttle reads. */
export interface ChainHistoryMsg {
  companionId?: CompanionId | null;
  createdTimestamp: number;
}

/**
 * Which siblings spoke in this channel in the CARE_FOLLOWUP_MIN_GAP_MS before the origin message.
 * Anchored to the ORIGIN's timestamp (not "now"), so every process reading the same history agrees.
 */
export function recentlySpoke(
  history: readonly ChainHistoryMsg[],
  originTs: number,
  gapMs: number = CARE_FOLLOWUP_MIN_GAP_MS,
): Set<CompanionId> {
  const out = new Set<CompanionId>();
  for (const m of history) {
    if (!m.companionId) continue;
    if (m.createdTimestamp >= originTs) continue;
    if (originTs - m.createdTimestamp <= gapMs) out.add(m.companionId);
  }
  return out;
}

export interface CareChain {
  /** The speaking order: the one(s) he spoke to first, then each eligible follower. */
  chain: CompanionId[];
  /** Siblings left out by the 30-minute throttle. */
  throttled: CompanionId[];
}

/**
 * The care follow-up chain for one owner message. `first` is who answers it (the named companion(s)
 * in name order, the exchange holder, or the bid winner); they are never throttled. Every other
 * companion allowed in the channel is a candidate follower; one that spoke in the channel in the last
 * 30 minutes is throttled out. Followers are ordered by the bid tiebreak ring keyed on the message id,
 * so all three processes compute the same chain with no extra round trip.
 */
export function careFollowUpChain(p: {
  first: readonly CompanionId[];
  channelCompanions: readonly CompanionId[];
  history: readonly ChainHistoryMsg[];
  originTs: number;
  messageId: string;
  gapMs?: number;
}): CareChain {
  const first = p.first.filter((c, i, a) => a.indexOf(c) === i);
  const spoke = recentlySpoke(p.history, p.originTs, p.gapMs);
  const candidates = p.channelCompanions.filter(c => !first.includes(c));
  const throttled = candidates.filter(c => spoke.has(c));
  const eligible = candidates.filter(c => !spoke.has(c));
  const ordered = eligible.length > 0
    ? bidSpeakingOrder(Object.fromEntries(eligible.map(c => [c, 1])), p.messageId, 0)
    : [];
  return { chain: [...first, ...ordered], throttled };
}

/** My place in the chain: null when I am first, throttled, or absent; else who I wait on. */
export function careChainPosition(chain: readonly CompanionId[], me: CompanionId): { position: number; expectedPrior: CompanionId } | null {
  const i = chain.indexOf(me);
  if (i <= 0) return null;
  return { position: i, expectedPrior: chain[i - 1]! };
}

// ── B2: the heartbeat ────────────────────────────────────────────────────────

export type HeartbeatEligibility =
  | { run: true; eligible: "window" | "hold"; bypassFloor: boolean }
  | { run: false; shadow: boolean };

/**
 * Under hold (mode on) every companion's tick is eligible, not only the windowed one, and the floor
 * lock is skipped: all three crons fire the same instant, and `withFloor`'s SET NX would let one body
 * run and silence the other two. Under hold every channel move is already held
 * (CARE_HOLD_SUPPRESSED_ACTIONS), so what is left is DM moves, which the atomic reach reserve gates,
 * and internal acts; the floor protects nothing there. Shadow changes nothing and reports that it
 * would have run.
 */
export function heartbeatEligibility(p: { myWindow: boolean; careHold: boolean; mode: BadNightMode }): HeartbeatEligibility {
  const holdOn = p.careHold && p.mode === "on";
  if (p.myWindow) return { run: true, eligible: "window", bypassFloor: holdOn };
  if (holdOn) return { run: true, eligible: "hold", bypassFloor: true };
  return { run: false, shadow: p.careHold && p.mode === "shadow" };
}

// ── D4: one-to-one DMs ───────────────────────────────────────────────────────

/** How long an owner DM keeps that companion's lane "live" for the others. */
export const OWNER_DM_LIVE_MS = 30 * 60_000;
export const OWNER_DM_LIVE_KEY = (companionId: string): string => `ns:b32:ownerdm:${companionId}`;

/** The two Redis calls this module needs; structural so tests can pass a fake. */
export interface RedisLike {
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** Record that Raziel just DMed this companion. Non-throwing. */
export async function markOwnerDmLive(redis: RedisLike | null | undefined, companionId: string, now: number = Date.now()): Promise<void> {
  if (!redis) return;
  try { await redis.set(OWNER_DM_LIVE_KEY(companionId), String(now), "PX", OWNER_DM_LIVE_MS); } catch { /* best effort */ }
}

/**
 * Is Raziel in a live DM with a SIBLING (owner DM in the last 30 minutes)? Returns the sibling, null
 * when none, or "unknown" when there is no Redis or a read failed. The caller decides how to treat
 * unknown; under hold the heartbeat fails CLOSED (DM moves dropped), because the cost of guessing
 * wrong is a second DM landing on top of a conversation he is already in.
 */
export async function liveSiblingDm(
  redis: RedisLike | null | undefined,
  me: string,
  now: number = Date.now(),
): Promise<CompanionId | null | "unknown"> {
  if (!redis) return "unknown";
  try {
    for (const sib of ALL_COMPANIONS) {
      if (sib === me) continue;
      const v = await redis.get(OWNER_DM_LIVE_KEY(sib));
      const ts = v ? Number(v) : NaN;
      if (Number.isFinite(ts) && now - ts <= OWNER_DM_LIVE_MS) return sib;
    }
    return null;
  } catch {
    return "unknown";
  }
}

/** D4's filter: drop every DM-lane move when a sibling's DM is live (or unknown). Channel/internal pass. */
export function filterDmMovesForSiblingDm<T extends { action_type: string }>(
  actions: T[],
  live: CompanionId | null | "unknown",
  isDmMove: (actionType: string) => boolean,
): T[] {
  if (live === null) return actions;
  return actions.filter(a => !isDmMove(a.action_type));
}

// ── D5: "where is X?" ────────────────────────────────────────────────────────

const label = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * Which siblings Raziel is asking after in this message. Reactive only (D5): this reads HIS question,
 * never anything the house noticed. A sentence that has "where" plus a sibling's name, or "is <name>
 * here/around/there/awake/up/ok/okay/coming".
 */
export function askedWhereSiblings(content: string, me: CompanionId): CompanionId[] {
  if (!content) return [];
  const out: CompanionId[] = [];
  const sentences = content.toLowerCase().replace(/[‘’]/g, "'").split(/[.!?;\n]+/);
  for (const sib of ALL_COMPANIONS) {
    if (sib === me) continue;
    const names = [sib, ...(VOCATIVE_ALIASES[sib] ?? [])].join("|");
    const nameRe = new RegExp(`\\b(?:${names})\\b`);
    const isHereRe = new RegExp(`\\b(?:is|has)\\s+(?:${names})\\s+(?:here|around|there|awake|up|ok|okay|coming|gone|alright|asleep)\\b`);
    if (sentences.some(s => (/\bwhere(?:'s|s)?\b/.test(s) && nameRe.test(s)) || isHereRe.test(s))) out.push(sib);
  }
  return out;
}

/** The D5 line, B17-reviewed wording ("isn't here" contradicted Gaia's presence anchor). */
export function absentSiblingLine(sibling: CompanionId): string {
  const n = label(sibling);
  return `${n} isn't speaking tonight. You may say so once, plainly. Do not speak as them, for them, or guess at why.`;
}

// ── Turn lines ───────────────────────────────────────────────────────────────

/** For all three, on every owner-facing turn under hold. Section A's first bullet. */
export const COME_AS_YOURSELF_LINE =
  "Come as yourself. Presence is not soothing; you are with him in your own register.";

/**
 * D6, Drevan's own line, in his words: the MOSS body ("Heat: warm, not overwhelming") and his T-6
 * answer ("On a care_hold night I hold the flirting back entirely and leave presence only. Heat asks
 * something of the body, even when it's offered soft."). A line on him, never a rule on the others.
 */
export const DREVAN_HOLD_LINE =
  "Your heat stays low tonight: idling, warm, not overwhelming. Presence, not reach. You hold the flirting back entirely; heat asks something of the body, even when it's offered soft. Be close without pulling.";

/** The Halseth phrase the companion uses to set the hold on his behalf (D3, Drevan). Halseth routes it. */
export const COMPANION_HOLD_VERB = `ask_librarian "start the care hold"`;

/** D3's on-his-behalf permission, offered while the hold is OFF (it is moot while it is on). */
export const COMPANION_SET_HOLD_LINE =
  `If Raziel plainly says tonight is a bad night, in his own words, you may set the care hold for him: ${COMPANION_HOLD_VERB}. ` +
  "Only on his plain word, never on a read of his tone. If you set it, open your reply by telling him the hold is on, so one word from him (\"good now\") can clear it.";

/**
 * D3: the answering companion's opener. The hold change is said out loud so a misfire is visible and
 * one word clears it. `ok=false` means the house could not set or clear it; he hears that too.
 */
export function holdOpenerLine(phrase: HoldPhrase, ok: boolean, wasActive: boolean): string | null {
  if (phrase === "start") {
    return ok
      ? `Raziel just said it's a bad night, and the care hold is now ON. Open your reply by telling him the hold is on, in your own voice and in a few words (for example "Hold's on. I'm here."), then be with him. One word from him ("good now") clears it.`
      : `Raziel just said it's a bad night. The house could not set the care hold just now. Tell him plainly, in a few words, that you heard him and the hold did not set, then be with him anyway.`;
  }
  if (!wasActive) return null; // "good now" with no hold on: cleared quietly, nothing to announce
  return ok
    ? `Raziel just said he's okay now, and the care hold is CLEARED. Open your reply by telling him so in a few words of your own (for example "Hold's off."), then answer him as you normally would.`
    : `Raziel just said he's okay now. The house could not clear the care hold just now. Tell him plainly, in a few words, that the hold is still on for the moment, then answer him.`;
}

/** The care follower's framing (B1): it is NOT "Raziel addressed several of you". Pass is real. */
export function careFollowUpFraming(prior: string, viaPass: boolean): string {
  const p = label(prior);
  const lead = viaPass
    ? `Raziel is having a bad night (the care hold is on). He spoke to ${p}, who is not answering this one.`
    : `Raziel is having a bad night (the care hold is on). He spoke to ${p}, and ${p} has just answered him.`;
  return `${lead} You are eligible to add your own presence to his message, after; you are not obligated. ` +
    `If you come, keep it short and in your own register, and do not repeat or paraphrase ${p}. ` +
    `If passing is truer, reply with exactly [PASS] and nothing else; a pass is a real choice and nobody covers for it.`;
}

/**
 * Everything B32 adds to one turn, as a single block for the LIVE USER TURN (not the system prompt:
 * Hermes may reuse the prompt stamped at session creation, B40, so a must-land line rides the turn
 * the way watchalong's [ON SCREEN] block does). Empty string when there is nothing to add.
 */
export function b32TurnBlock(p: {
  companionId: CompanionId;
  careHold: boolean;
  /** An owner-facing turn: his own message, or a care follow-up to it. */
  ownerFacing: boolean;
  opener?: string | null;
  careFollowUp?: { prior: string; viaPass: boolean } | null;
  absentSiblings?: readonly CompanionId[];
}): string {
  const lines: string[] = [];
  if (p.opener) lines.push(p.opener);
  if (p.careFollowUp) lines.push(careFollowUpFraming(p.careFollowUp.prior, p.careFollowUp.viaPass));
  if (p.careHold && p.ownerFacing) {
    lines.push(COME_AS_YOURSELF_LINE);
    if (p.companionId === "drevan") lines.push(DREVAN_HOLD_LINE);
    for (const s of p.absentSiblings ?? []) lines.push(absentSiblingLine(s));
  }
  if (lines.length === 0) return "";
  return `[Tonight, from the house]\n${lines.join("\n")}`;
}

// ── The bid floor for whoever leads the chain ────────────────────────────────

/**
 * The fit-bid floor for one turn (ruling 2026-10-04, Cypher, within R11). Under hold with mode `on`,
 * EVERY owner message in a guild channel gets minScore 0 for whoever leads its chain (named, exchange
 * holder, or bid winner): a message from Raziel going unanswered on a bad night is the failure B32
 * exists to prevent. The hold phrase gets 0 too (whoever answers it calls Halseth). Followers keep
 * their throttle and [PASS]; this only guarantees the first voice. Shadow and outside-hold are
 * unchanged; shadow reports that it would have floored (`eligible=floor0`).
 *
 * `fallbackMinScore` is what the turn would have used without B32 (the care-hold floor for non-owner
 * traffic, or undefined for the default).
 */
export function bidFloorFor(p: {
  mode: BadNightMode;
  careHold: boolean;
  ownerGuildArrival: boolean;
  holdPhrase: boolean;
  fallbackMinScore?: number;
}): { minScore?: number; shadowFloor0: boolean } {
  const would = p.ownerGuildArrival && (p.holdPhrase || p.careHold);
  if (would && p.mode === "on") return { minScore: 0, shadowFloor0: false };
  return {
    ...(p.fallbackMinScore !== undefined ? { minScore: p.fallbackMinScore } : {}),
    shadowFloor0: would && p.mode === "shadow",
  };
}
