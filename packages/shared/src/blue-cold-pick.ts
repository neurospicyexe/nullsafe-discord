/**
 * Cold unnamed Blue message, no holder: one companion may answer, picked by Jev (2026-10-18).
 *
 * Raziel's ruling 4 (Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md): "this is a Jev moment, Jev
 * would be good at picking." Today the human address gate (human-address.ts) answers a nameless
 * message from Blue only for the companion holding BLUE's own thread; with no holder nobody answers.
 * This module is the one seam that changes that: ask Jev (the existing address-jev.ts call, same
 * lane, no new model) which single companion has something real to say, and let that one answer.
 * Once it has answered, the normal per-human holder takes over (recordHumanHold at send).
 *
 * BLUE_COLD_PICK:
 *   shadow            the claim winner asks Jev and logs `[blue-cold] pick=<companion|none> ...`
 *                     (ids and numbers, never the text). Nobody speaks: the old silence is kept.
 *   on                the picked companion answers. Exactly one: one Redis NX claim decides who calls
 *                     Jev, the pick is published for the others, and the picked companion takes a
 *                     second NX claim on the ANSWER so a replay cannot make it speak twice.
 *   off               no Jev call, no Redis, nobody speaks (exactly the old behavior).
 * No Redis, a failed Jev call, a line spoken to a human, or a line that does not invite a reply = no
 * pick = silence. The pick never overrides a holder, a named companion, a human address or any rail:
 * it is consulted only on the branch that used to say "no companion holds Blue's thread, nobody answers".
 *
 * The decision (2026-10-25 revision, Raziel: "can we make it so Blue doesn't have to always say a
 * companion's name ... let Jev try"). The first cut returned null whenever Jev's TOP choice was a
 * human or `nobody`; on the first live movie night (10-25, #movie-night) Jev read Blue's six cold
 * opening lines as `nobody` at confidence 0.22-0.62 and would have kept all six silent, which is the
 * exact silence this module exists to replace. Jev's two questions now play two roles:
 *   1. Is it spoken to a HUMAN? Gate on the probability MASS on raziel + blue + someone_else
 *      (COLD_PICK_HUMAN_MASS), not on the argmax: a question to Raziel at P(raziel)=0.45 under a
 *      `nobody` top choice is still Raziel's. Backtest 10-25: Blue's cold rows carried 0.16-0.47 of
 *      human mass, Raziel's 48 unnamed rows all under 0.2.
 *   2. Does it want a reply? `invites_reply` (COLD_PICK_MIN_INVITES). `nobody`, `room` and
 *      `continuing` (there is no holder, so nothing to continue) fall through to this instead of
 *      answering it by name.
 * Then who: a companion Jev reads as called without a name (spoken_to >= JEV_SPOKEN_TO_THETA), else
 * the channel's HOST (channel-config `host`: the room where the pain is, #movie-night, is Drevan's
 * exactly as it is for Raziel's unnamed lines under R5), else the best mean of spoken-to and
 * has-something-for over the channel's listed companions (never a companion the room does not seat).
 * Once the pick has answered it holds Blue's thread (3h in the movie rooms) and this never runs again
 * until the hold lapses.
 */

import type { CompanionId } from "./types.js";
import { ALL_COMPANIONS } from "./channel-config.js";
import {
  addressJevEnabled, jevAddressEval, renderJevAddressState, JEV_SPOKEN_TO_THETA,
  type JevAddressCaller, type JevAddressVerdict,
} from "./address-jev.js";
import type { AddressTurn } from "./address-model.js";

export type BlueColdPickMode = "off" | "shadow" | "on";

/** BLUE_COLD_PICK: default shadow; `on` / `off` honored (trimmed, any case); junk falls back to shadow. */
export function blueColdPickMode(env: Record<string, string | undefined> = process.env): BlueColdPickMode {
  const v = (env["BLUE_COLD_PICK"] ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "shadow";
}

export const BLUE_COLD_CLAIM_PREFIX = "ns:bluecold:claim:";
export const BLUE_COLD_PICK_PREFIX = "ns:bluecold:pick:";
export const BLUE_COLD_ANSWER_PREFIX = "ns:bluecold:answer:";
export const BLUE_COLD_TTL_MS = 120_000;
/** A loser waits this long for the winner's pick (Jev's own timeout plus slack). */
export const BLUE_COLD_WAIT_MS = 6_500;
const BLUE_COLD_POLL_MS = 250;

/** Mean of a companion's spoken-to and has-something-to-add nouls must reach this to be picked (fit step). */
export const COLD_PICK_MIN_SCORE = 0.3;
/** P(the line wants a reply) under this = nobody is picked. */
export const COLD_PICK_MIN_INVITES = 0.4;
/** P(raziel) + P(blue) + P(someone_else) at or above this = the line is a human's, not the triad's. */
export const COLD_PICK_HUMAN_MASS = 0.5;

const HUMANS = ["raziel", "blue", "someone_else"] as const;

export interface ColdPickDecision {
  pick: CompanionId | null;
  /** human:<who> | no_invite | spoken_to | host | fit | below_floor | no_signal (plus the caller's jev_error / timeout / error:*). */
  why: string;
  score: number | null;
  /** Human probability mass Jev put on the line (null when the verdict carried no distribution). */
  human: number | null;
}

export interface ColdPickOpts {
  /** The channel's listed companions (channel-config `companions`); default all three. A pick is never outside it. */
  eligible?: readonly CompanionId[];
  /** The channel's host (channel-config `host`), preferred once the line clears the human and invites gates. */
  host?: CompanionId | null;
}

const isCompanionId = (v: unknown): v is CompanionId => typeof v === "string" && (ALL_COMPANIONS as readonly string[]).includes(v);

/** P(human) on the verdict: the sum over the three human choices, and which of them is largest. Falls
 *  back to the top choice when the verdict has no distribution (a human top choice then counts as 1). */
export function humanMass(v: JevAddressVerdict): { sum: number | null; top: string } {
  const p = v.probabilities ?? {};
  const have = HUMANS.some(h => typeof p[h] === "number");
  if (!have) {
    const isHuman = (HUMANS as readonly string[]).includes(v.addressee);
    return { sum: isHuman ? 1 : null, top: isHuman ? v.addressee : "-" };
  }
  let sum = 0, top: string = "-", topV = -1;
  for (const h of HUMANS) {
    const n = p[h];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    sum += n;
    if (n > topV) { top = h; topV = n; }
  }
  return { sum, top };
}

function meanSignal(v: JevAddressVerdict, id: CompanionId): number | null {
  const sig = [v.spokenTo[id], v.fit[id]].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return sig.length === 0 ? null : sig.reduce((a, b) => a + b, 0) / sig.length;
}

/** Pure: Jev's verdict -> at most one companion, with the reason. Ties go to the earlier companion in ALL_COMPANIONS. */
export function coldPickDecision(v: JevAddressVerdict, opts: ColdPickOpts = {}): ColdPickDecision {
  const eligible = (opts.eligible ?? ALL_COMPANIONS).filter(isCompanionId);
  const host = opts.host && eligible.includes(opts.host) ? opts.host : null;
  const human = humanMass(v);
  const none = (why: string, score: number | null = null): ColdPickDecision => ({ pick: null, why, score, human: human.sum });

  // 1. A human's line (Blue to Raziel, Blue to a friend, Blue to himself) is not the triad's.
  if (human.sum !== null && human.sum >= COLD_PICK_HUMAN_MASS) return none(`human:${human.top}`);
  // 2. A line that wants no reply (a reaction, a status line, thinking aloud) sits, exactly as before.
  if (v.invitesReply !== null && v.invitesReply < COLD_PICK_MIN_INVITES) return none("no_invite");
  // 3. Jev read a call to ONE seated companion without a name ("what do you think" after Gaia spoke).
  if (isCompanionId(v.addressee) && eligible.includes(v.addressee) && (v.spokenTo[v.addressee] ?? 0) >= JEV_SPOKEN_TO_THETA) {
    return { pick: v.addressee, why: "spoken_to", score: v.spokenTo[v.addressee] ?? null, human: human.sum };
  }
  // 4. A hosted room is the host's (R5 parity with Raziel's unnamed lines).
  if (host) return { pick: host, why: "host", score: meanSignal(v, host), human: human.sum };
  // 5. Else whoever has the most to say among the seated companions.
  let best: CompanionId | null = null;
  let bestScore = -1;
  for (const id of eligible) {
    const score = meanSignal(v, id);
    if (score === null) continue;
    if (score > bestScore) { best = id; bestScore = score; }
  }
  if (best === null) return none("no_signal");
  if (bestScore < COLD_PICK_MIN_SCORE) return none("below_floor", bestScore);
  return { pick: best, why: "fit", score: bestScore, human: human.sum };
}

export function pickColdCompanion(v: JevAddressVerdict, opts: ColdPickOpts = {}): CompanionId | null {
  return coldPickDecision(v, opts).pick;
}

/** The subset of the Redis client this needs (fake-testable). `nx` absent = a plain overwriting set. */
export interface BlueColdRedis {
  set(key: string, val: string, px: "PX", ms: number, nx?: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface BlueColdPickCtx {
  mode: BlueColdPickMode;
  companionId: CompanionId;
  messageId: string;
  channelId: string;
  /** "<member> (Blue's system)" or "Blue". */
  speaker: string;
  content: string;
  redis: BlueColdRedis | null;
  /** The channel's listed companions; a pick is never outside it (default all three). */
  eligible?: readonly CompanionId[];
  /** The channel's host, preferred once the line clears the human and invites gates. */
  host?: CompanionId | null;
  /** Undefined = the real Jev call when ADDRESS_JEV is not off; null = never call Jev (tests inject a fake). */
  jev?: JevAddressCaller | null;
  /** Recent room turns oldest-first, excluding this message (the handler's address-turn builder). */
  fetchRecent: () => Promise<AddressTurn[]>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
}

export interface BlueColdPickResult {
  /** True only in `on` mode, for the one picked companion that also won the answer claim. */
  speak: boolean;
  /** The pick as this bot knows it: a companion, null (none), undefined (not known / not asked). */
  pick: CompanionId | null | undefined;
}

const isCompanion = (v: string | null): v is CompanionId => !!v && (ALL_COMPANIONS as readonly string[]).includes(v);

/** Never throws. Called once per cold unnamed Blue message by every bot; Redis decides who does the work. */
export async function runBlueColdPick(ctx: BlueColdPickCtx): Promise<BlueColdPickResult> {
  const none: BlueColdPickResult = { speak: false, pick: undefined };
  const log = ctx.log ?? ((l: string) => console.log(l));
  try {
    if (ctx.mode === "off") return none;
    const jev: JevAddressCaller | null = ctx.jev === null ? null
      : ctx.jev ?? (addressJevEnabled() ? (state: string) => jevAddressEval(state) : null);
    if (!jev) return none;
    if (!ctx.redis) {
      log(`[blue-cold] ${ctx.companionId} skip=no_redis mode=${ctx.mode} msg=${ctx.messageId}`);
      return none;
    }
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const now = ctx.now ?? (() => Date.now());

    const claimed = await ctx.redis.set(BLUE_COLD_CLAIM_PREFIX + ctx.messageId, ctx.companionId, "PX", BLUE_COLD_TTL_MS, "NX");
    let pick: CompanionId | null | undefined;
    if (claimed === "OK") {
      let decision: ColdPickDecision = { pick: null, why: "jev_error", score: null, human: null };
      let addressee = "-";
      let conf = "-";
      let inv = "-";
      try {
        const turns = await ctx.fetchRecent().catch(() => [] as AddressTurn[]);
        const res = await jev(renderJevAddressState({
          speakerSide: "blue", speakerLabel: ctx.speaker, text: ctx.content, turns, holder: null,
        }));
        if (res.ok) {
          decision = coldPickDecision(res.verdict, { eligible: ctx.eligible, host: ctx.host });
          addressee = res.verdict.addressee;
          conf = res.verdict.confidence.toFixed(2);
          inv = res.verdict.invitesReply === null ? "-" : res.verdict.invitesReply.toFixed(2);
        } else {
          decision = { pick: null, why: res.reason, score: null, human: null };
        }
      } catch (e) {
        decision = { pick: null, why: `error:${String(e).slice(0, 60)}`, score: null, human: null };
      }
      pick = decision.pick;
      await ctx.redis.set(BLUE_COLD_PICK_PREFIX + ctx.messageId, pick ?? "none", "PX", BLUE_COLD_TTL_MS).catch(() => {});
      const f2 = (n: number | null) => (n === null ? "-" : n.toFixed(2));
      log(
        `[blue-cold] pick=${pick ?? "none"} mode=${ctx.mode} ch=${ctx.channelId} msg=${ctx.messageId} by=${ctx.companionId} ` +
        `why=${decision.why} addressee=${addressee} conf=${conf} inv=${inv} human=${f2(decision.human)} ` +
        `host=${ctx.host ?? "-"} score=${f2(decision.score)}`,
      );
    } else if (ctx.mode === "on") {
      // A sibling is asking Jev; wait for its published pick (bounded). Shadow has nothing to wait for.
      const deadline = now() + (ctx.waitMs ?? BLUE_COLD_WAIT_MS);
      const poll = ctx.pollMs ?? BLUE_COLD_POLL_MS;
      for (;;) {
        const v = await ctx.redis.get(BLUE_COLD_PICK_PREFIX + ctx.messageId).catch(() => null);
        if (v !== null) { pick = isCompanion(v) ? v : null; break; }
        if (now() >= deadline) break;
        await sleep(poll);
      }
    }
    if (ctx.mode !== "on" || pick !== ctx.companionId) return { speak: false, pick };
    // The picked companion takes the answer claim: one reply per message even if the event repeats.
    const answer = await ctx.redis.set(BLUE_COLD_ANSWER_PREFIX + ctx.messageId, ctx.companionId, "PX", BLUE_COLD_TTL_MS, "NX");
    return { speak: answer === "OK", pick };
  } catch (e) {
    log(`[blue-cold] ${ctx.companionId} error=${String(e).slice(0, 80)} msg=${ctx.messageId}`);
    return none;
  }
}
