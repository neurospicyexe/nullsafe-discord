/**
 * Live Jev gate on the human address path (2026-10-25).
 *
 * The regex half of the human address gate (human-address.ts) needs punctuation after a name to read
 * it as a call: "Corbin, look at this" silences the triad, "Corbin look at this" does not. On the
 * first #movie-night with Blue's system in the room (10-25, 18:45 CDT) Raziel spoke to Corbin, a
 * member of Blue's system, with no comma, and Drevan (the room's host) answered a line that was never
 * his. Jev's address read of that same line put 0.85 on Blue and 0.95 on the three human choices
 * together. Raziel: "You guys aren't super great catching when something is directed at another
 * person explicitly ... Let's fix it."
 *
 * This module asks Jev ONE question on the reply path, after the regex gate and shouldRespond have
 * let a companion through on an UNNAMED human line in a room two humans share: is this line a
 * human's? The test is the probability MASS on raziel + blue + someone_else (the same
 * COLD_PICK_HUMAN_MASS the cold pick uses, so one threshold governs both doors), never the argmax.
 * Mass at or above it = every companion stays quiet. Backtest on the 10-25 session: the Corbin line
 * (0.95) is silenced; Raziel's 48 unnamed lines that night all sat under 0.2.
 *
 * HUMAN_ADDRESS_JEV:
 *   on       (code default) the gate is live. One Redis NX claim decides which bot asks Jev; the
 *            verdict (numbers only) is published for the others, who wait a bounded time for it.
 *   shadow   the claim winner asks Jev and logs what the gate WOULD do; nobody waits, nobody is silenced.
 *   off      no Jev call, no Redis: exactly the regex gate alone.
 * FAILS OPEN everywhere: ADDRESS_JEV=off, no Redis, a Jev error or timeout, a verdict that never
 * arrives, all mean "proceed as before". The claim winner publishes an explicit open verdict on
 * failure so the waiters stop at once instead of paying the whole window. Consulted only where a
 * companion would otherwise SPEAK on an unnamed line: a named companion, a reply, a mention, a human
 * named by the regex, a cold Blue line (the cold pick already mass-gates it) and owner-only rooms
 * never reach it.
 *
 * Latency: the winner pays Jev's wall time (JEV_ADDRESS_TIMEOUT_MS cap), the waiters at most
 * HUMAN_JEV_WAIT_MS. In a hosted room only the host survives shouldRespond for an unnamed line, so
 * that room pays one Jev call and no wait. The fit bid's deadline is re-anchored on the verdict's
 * publish time (fit-bid.ts bidDeadlineAfterGate) so the three bots still converge on one speaker.
 */

import type { CompanionId } from "./types.js";
import {
  addressJevEnabled, jevAddressEval, renderJevAddressState,
  type JevAddressCaller, type JevAddressVerdict, type SpeakerSide,
} from "./address-jev.js";
import type { AddressTurn } from "./address-model.js";
import { humanMass, COLD_PICK_HUMAN_MASS } from "./blue-cold-pick.js";

export type HumanJevGateMode = "off" | "shadow" | "on";

/** HUMAN_ADDRESS_JEV: default on; `shadow` / `off` honored (trimmed, any case); junk falls back to on. */
export function humanJevGateMode(env: Record<string, string | undefined> = process.env): HumanJevGateMode {
  const v = (env["HUMAN_ADDRESS_JEV"] ?? "").trim().toLowerCase();
  return v === "off" || v === "shadow" ? v : "on";
}

export const HUMAN_JEV_CLAIM_PREFIX = "ns:humanjev:claim:";
export const HUMAN_JEV_VERDICT_PREFIX = "ns:humanjev:verdict:";
export const HUMAN_JEV_TTL_MS = 120_000;
/** A waiter gives up after this (Jev's own timeout plus slack) and proceeds. */
export const HUMAN_JEV_WAIT_MS = 6_500;
const HUMAN_JEV_POLL_MS = 250;
/** Human probability mass at or above this = the line is a human's. One threshold with the cold pick. */
export const HUMAN_JEV_MASS = COLD_PICK_HUMAN_MASS;

/** What the claim winner publishes: the decision and the numbers behind it, never the text. */
export interface HumanJevVerdict {
  silent: boolean;
  mass: number | null;
  /** raziel | blue | someone_else | - */
  top: string;
  addressee: string;
  confidence: number | null;
  invites: number | null;
  /** jev | jev_error:<reason> | error:<msg> */
  why: string;
  /** Epoch ms when the winner published; the fit bid re-anchors its deadline on it. */
  publishedAt: number;
}

/** Pure: Jev's verdict -> silent iff the human mass reaches the threshold. */
export function humanJevDecision(v: JevAddressVerdict): { silent: boolean; mass: number | null; top: string } {
  const h = humanMass(v);
  return { silent: h.sum !== null && h.sum >= HUMAN_JEV_MASS, mass: h.sum, top: h.top };
}

export interface HumanJevRedis {
  set(key: string, val: string, px: "PX", ms: number, nx?: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface HumanJevGateCtx {
  mode: HumanJevGateMode;
  companionId: CompanionId;
  messageId: string;
  channelId: string;
  speakerSide: SpeakerSide;
  /** The display label the room sees ("Noah M. (via PK)", "Corbin (Blue's system)", "Blue"). */
  speakerLabel: string;
  content: string;
  /** This human's thread holder as the handler knows it (Raziel's exchange holder, Blue's own hold). */
  holder: CompanionId | null;
  redis: HumanJevRedis | null;
  /** Undefined = the real Jev call when ADDRESS_JEV is not off; null = never call Jev (tests inject a fake). */
  jev?: JevAddressCaller | null;
  /** Recent room turns oldest-first, excluding this message. */
  fetchRecent: () => Promise<AddressTurn[]>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
}

export interface HumanJevGateResult {
  /** True only in `on` mode, when Jev read the line as a human's. */
  silent: boolean;
  /** The verdict as this bot knows it (own call or a sibling's publish); null when none arrived. */
  verdict: HumanJevVerdict | null;
  /** me = asked Jev; sibling = read a sibling's publish; open = nothing to go on (fail open). */
  source: "me" | "sibling" | "open";
  /** Why the gate opened without a verdict (off, jev_off, no_redis, wait_timeout) or "-". */
  why: string;
}

const OPEN = (why: string): HumanJevGateResult => ({ silent: false, verdict: null, source: "open", why });

function parseVerdict(raw: string | null): HumanJevVerdict | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<HumanJevVerdict>;
    if (typeof o !== "object" || o === null || typeof o.silent !== "boolean") return null;
    return {
      silent: o.silent,
      mass: typeof o.mass === "number" && Number.isFinite(o.mass) ? o.mass : null,
      top: typeof o.top === "string" ? o.top : "-",
      addressee: typeof o.addressee === "string" ? o.addressee : "-",
      confidence: typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : null,
      invites: typeof o.invites === "number" && Number.isFinite(o.invites) ? o.invites : null,
      why: typeof o.why === "string" ? o.why : "-",
      publishedAt: typeof o.publishedAt === "number" && Number.isFinite(o.publishedAt) ? o.publishedAt : 0,
    };
  } catch {
    return null;
  }
}

const f2 = (n: number | null) => (n === null ? "-" : n.toFixed(2));

/** Never throws. Called by every bot that would otherwise speak on an unnamed human line; Redis decides who asks. */
export async function runHumanJevGate(ctx: HumanJevGateCtx): Promise<HumanJevGateResult> {
  const log = ctx.log ?? ((l: string) => console.log(l));
  const head = `[human-jev] ${ctx.companionId} mode=${ctx.mode} ch=${ctx.channelId} msg=${ctx.messageId} side=${ctx.speakerSide} holder=${ctx.holder ?? "-"}`;
  try {
    if (ctx.mode === "off") return OPEN("off");
    const jev: JevAddressCaller | null = ctx.jev === null ? null
      : ctx.jev ?? (addressJevEnabled() ? (state: string) => jevAddressEval(state) : null);
    if (!jev) return OPEN("jev_off");
    if (!ctx.redis) {
      log(`${head} open why=no_redis`);
      return OPEN("no_redis");
    }
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const now = ctx.now ?? (() => Date.now());
    const started = now();

    const claimed = await ctx.redis.set(HUMAN_JEV_CLAIM_PREFIX + ctx.messageId, ctx.companionId, "PX", HUMAN_JEV_TTL_MS, "NX");
    if (claimed === "OK") {
      let verdict: HumanJevVerdict = {
        silent: false, mass: null, top: "-", addressee: "-", confidence: null, invites: null, why: "jev_error", publishedAt: 0,
      };
      try {
        const turns = await ctx.fetchRecent().catch(() => [] as AddressTurn[]);
        const res = await jev(renderJevAddressState({
          speakerSide: ctx.speakerSide, speakerLabel: ctx.speakerLabel, text: ctx.content, turns, holder: ctx.holder,
        }));
        if (res.ok) {
          const d = humanJevDecision(res.verdict);
          verdict = {
            silent: d.silent, mass: d.mass, top: d.top, addressee: res.verdict.addressee,
            confidence: res.verdict.confidence, invites: res.verdict.invitesReply, why: "jev", publishedAt: 0,
          };
        } else {
          verdict.why = `jev_error:${res.reason}`;
        }
      } catch (e) {
        verdict.why = `error:${String(e).slice(0, 60)}`;
      }
      verdict.publishedAt = now();
      // Published even on failure (silent=false), so the waiters stop instead of paying the whole window.
      await ctx.redis.set(HUMAN_JEV_VERDICT_PREFIX + ctx.messageId, JSON.stringify(verdict), "PX", HUMAN_JEV_TTL_MS).catch(() => {});
      const acts = ctx.mode === "on";
      log(
        `${head} by=me ${acts ? "verdict" : "would"}=${verdict.silent ? "silent" : "open"} why=${verdict.why} ` +
        `mass=${f2(verdict.mass)} top=${verdict.top} addressee=${verdict.addressee} conf=${f2(verdict.confidence)} ` +
        `inv=${f2(verdict.invites)} wall_ms=${verdict.publishedAt - started}`,
      );
      return { silent: acts && verdict.silent, verdict, source: "me", why: "-" };
    }

    // A sibling is asking Jev. Shadow has nothing to wait for; on waits (bounded) for its publish.
    if (ctx.mode !== "on") return OPEN("shadow_sibling");
    const deadline = started + (ctx.waitMs ?? HUMAN_JEV_WAIT_MS);
    const poll = ctx.pollMs ?? HUMAN_JEV_POLL_MS;
    for (;;) {
      const v = parseVerdict(await ctx.redis.get(HUMAN_JEV_VERDICT_PREFIX + ctx.messageId).catch(() => null));
      if (v) {
        log(`${head} by=sibling verdict=${v.silent ? "silent" : "open"} why=${v.why} mass=${f2(v.mass)} top=${v.top} waited_ms=${now() - started}`);
        return { silent: v.silent, verdict: v, source: "sibling", why: "-" };
      }
      if (now() >= deadline) break;
      await sleep(poll);
    }
    log(`${head} open why=wait_timeout waited_ms=${now() - started}`);
    return OPEN("wait_timeout");
  } catch (e) {
    log(`${head} open why=error:${String(e).slice(0, 80)}`);
    return OPEN("error");
  }
}
