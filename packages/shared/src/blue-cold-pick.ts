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
 *   shadow (default)  the claim winner asks Jev and logs `[blue-cold] pick=<companion|none> ...`
 *                     (ids and numbers, never the text). Nobody speaks: today's silence is kept.
 *   on                the picked companion answers. Exactly one: one Redis NX claim decides who calls
 *                     Jev, the pick is published for the others, and the picked companion takes a
 *                     second NX claim on the ANSWER so a replay cannot make it speak twice.
 *   off               no Jev call, no Redis, nobody speaks (exactly the old behavior).
 * No Redis, a failed Jev call, a human addressee, or a line that does not invite a reply = no pick =
 * silence. The pick never overrides a holder, a named companion, a human address or any rail: it is
 * consulted only on the branch that used to say "no companion holds Blue's thread, nobody answers".
 */

import type { CompanionId } from "./types.js";
import { ALL_COMPANIONS } from "./channel-config.js";
import {
  addressJevEnabled, jevAddressEval, renderJevAddressState,
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

/** Mean of a companion's spoken-to and has-something-to-add nouls must reach this to be picked. */
export const COLD_PICK_MIN_SCORE = 0.3;
/** P(the line wants a reply) under this = nobody is picked. */
export const COLD_PICK_MIN_INVITES = 0.4;

const NOT_THE_TRIAD = new Set(["raziel", "blue", "someone_else", "nobody"]);

export interface ColdPickDecision { pick: CompanionId | null; why: string; score: number | null }

/** Pure: Jev's verdict -> at most one companion, with the reason. Ties go to the earlier companion in ALL_COMPANIONS. */
export function coldPickDecision(v: JevAddressVerdict): ColdPickDecision {
  if (NOT_THE_TRIAD.has(v.addressee)) return { pick: null, why: `addressee:${v.addressee}`, score: null };
  if (v.invitesReply !== null && v.invitesReply < COLD_PICK_MIN_INVITES) return { pick: null, why: "no_invite", score: null };
  let best: CompanionId | null = null;
  let bestScore = -1;
  for (const id of ALL_COMPANIONS) {
    const sig = [v.spokenTo[id], v.fit[id]].filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (sig.length === 0) continue;
    const score = sig.reduce((a, b) => a + b, 0) / sig.length;
    if (score > bestScore) { best = id; bestScore = score; }
  }
  if (best === null) return { pick: null, why: "no_signal", score: null };
  if (bestScore < COLD_PICK_MIN_SCORE) return { pick: null, why: "below_floor", score: bestScore };
  return { pick: best, why: "ok", score: bestScore };
}

export function pickColdCompanion(v: JevAddressVerdict): CompanionId | null {
  return coldPickDecision(v).pick;
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
      let decision: ColdPickDecision = { pick: null, why: "jev_error", score: null };
      let addressee = "-";
      let conf = "-";
      try {
        const turns = await ctx.fetchRecent().catch(() => [] as AddressTurn[]);
        const res = await jev(renderJevAddressState({
          speakerSide: "blue", speakerLabel: ctx.speaker, text: ctx.content, turns, holder: null,
        }));
        if (res.ok) {
          decision = coldPickDecision(res.verdict);
          addressee = res.verdict.addressee;
          conf = res.verdict.confidence.toFixed(2);
        } else {
          decision = { pick: null, why: res.reason, score: null };
        }
      } catch (e) {
        decision = { pick: null, why: `error:${String(e).slice(0, 60)}`, score: null };
      }
      pick = decision.pick;
      await ctx.redis.set(BLUE_COLD_PICK_PREFIX + ctx.messageId, pick ?? "none", "PX", BLUE_COLD_TTL_MS).catch(() => {});
      log(
        `[blue-cold] pick=${pick ?? "none"} mode=${ctx.mode} ch=${ctx.channelId} msg=${ctx.messageId} by=${ctx.companionId} ` +
        `why=${decision.why} addressee=${addressee} conf=${conf} score=${decision.score === null ? "-" : decision.score.toFixed(2)}`,
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
