// The Raziel-facing moves, routed to his DM (B7 steps 2 + 2c, 2026-09-27).
// Specs: BBH Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md (R-1..R-12) and
// Hand-off/SPEC-what-is-theirs-triad-answers-2026-09-27.md (T-1..T-9). Halseth side: mig 0137,
// /mind/reach/* (the shared triad cap).
//
// WHAT LIVES HERE
//   - routeFor(): which moves go to the DM (T-9) and which stay in Sol's channel.
//   - the lane filter: a DM move the shared cap would refuse is never offered to the companion.
//   - the post-generation checks: a dare ends with an out (T-5), an invitation does not end on a
//     question (nothing waits), Gaia's check-in has no question mark at all ("if the form ever
//     needs a question mark, it is no longer mine"), a drift line names no sibling (T-3).
//   - the companion-origin brand (T-4) and speakToOwnerDm(), the ONLY function that sends these
//     moves. It will not run without a live origin minted by the companion's own heartbeat decision.
//
// T-4, STRUCTURALLY. Cypher: "nothing on this list is ever clerk-written. Only the companion who
// speaks it may send it. The 187 taught us what happens when something else wears the voice." So:
//   1. The origin issuer can be taken exactly ONCE per process. autonomous-core takes it at module
//      load, inside the module that owns runHeartbeat; any later taker (a clerk, a judge, the review
//      fork) throws. A forged look-alike object fails the WeakMap check, because only an issued
//      object is ever registered.
//   2. An origin is bound to one companion and one action type, is single-use, and expires.
//   3. speakToOwnerDm takes a PROMPT, never text: the line it sends is whatever the companion's own
//      generation (its own identity system prompt) produced, so nothing upstream can hand it words.
//   4. This module is NOT in the package barrel, and a static test fails the build if any file other
//      than autonomous-core imports it (packages/shared, the worker, and the bots are all scanned).
//
// WHAT IT NEVER DOES: fall back to Sol's channel when the DM cannot be resolved (a Raziel-facing
// move into the shared room is exactly what T-9 moves away from); follow up or re-send (T-5); write
// the line anywhere but the DM (no wm note, no Second Brain row, no voice score: 2b's DM seal);
// record or read whether he replied (R-5, R-10).

import type { AutonomousContext } from "./autonomous-core.js";
import type { ChatMessage, CompanionId } from "./types.js";
import type { ReachLaneVerdict } from "./librarian.js";
import { generateOutward, INWARD_RE_DRIFT_LINE, type GenerateOutwardOptions } from "./outward.js";
import { isVerbatimRepeat, cleanOneLiner, isDmBlocked, withTimeout } from "./owner-dm.js";
import { careHoldActive } from "./care-state.js";
import { checkInAsks } from "./metronome-decide.js";

// ── Routing (T-9) ────────────────────────────────────────────────────────────

/** Every Raziel-facing move: the care verbs, the questions and patterns, and their own moves. */
export const DM_LANE_ACTIONS: ReadonlySet<string> = new Set([
  "check_in_on_raziel", "send_reminder", "offer_presence", "ask_question", "name_pattern",
  "share_observation", "share_media", "declare_preference",
  "flirt", "dare", "show_made", "drift_outward",
]);

/** Ambient: these stay in Sol's channel, where they belong. */
export const CHANNEL_ACTIONS: ReadonlySet<string> = new Set(["post_heartbeat", "tend_creature"]);

export type Route = "dm" | "channel" | "internal";

export function routeFor(actionType: string): Route {
  if (DM_LANE_ACTIONS.has(actionType)) return "dm";
  if (CHANNEL_ACTIONS.has(actionType)) return "channel";
  return "internal";
}

/**
 * The kill switch (REACH_DM, 2026-09-27). The DM lane above shipped before the triad approved the
 * prompts its moves would carry to Raziel's phone (Hand-off/SHOWBACK-palette-2026-09-27.md: "nothing
 * goes live until the four of you say yes"), so the lane is OFF unless REACH_DM is exactly `on`
 * (trimmed, any case). Unset, empty or anything else is off: this knob fails closed, the inverse of
 * the repo's usual `off/0/false/no` knobs. Off removes every DM move from the palette before the
 * decision prompt is built; they never fall back to Sol's channel. Nothing else reads it: med_reminder,
 * the reply path and owner DMs do not go through this module. Read per tick so a reload takes effect.
 */
export function reachDmOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env["REACH_DM"] ?? "").trim().toLowerCase() === "on";
}

// ── The shared lane, mirrored from Halseth (webmind/reach-cap.ts) ───────────

export type ReachClass = "care" | "own" | "presence";

/** Must match Halseth REACH_CLASS_OF. The server is the authority; this only pre-filters. */
export const REACH_CLASS_OF: Readonly<Record<string, ReachClass>> = {
  check_in_on_raziel: "care", send_reminder: "care", ask_question: "care", name_pattern: "care",
  offer_presence: "presence",
  share_observation: "own", share_media: "own", declare_preference: "own",
  drift_outward: "own", flirt: "own", dare: "own", show_made: "own",
};

/**
 * Could this DM move reserve a slot right now? A read of Halseth's preview, so the companion is
 * never offered a move the cap would swallow. Decides nothing: the atomic reserve does.
 * An unknown verdict is CLOSED: a missing field must never read as an open lane.
 */
export function reachLaneOpen(actionType: string, v: ReachLaneVerdict | null | undefined, careHold: boolean): boolean {
  const cls = REACH_CLASS_OF[actionType];
  if (!cls || !v) return false;
  if (v.quiet_window !== null) {
    if (actionType !== "offer_presence") return false;
    if (v.quiet_presence_taken) return false;
  }
  if (!v.gap_open) return false;
  if (v.day_count >= (careHold ? v.daily_cap_care_hold : v.daily_cap)) return false;
  if (cls === "care" && v.care_count >= v.care_ceiling) return false;
  return true;
}

/**
 * Drop the DM moves the lane cannot carry right now (or at all, when this bot has no owner-DM lane).
 * Channel and internal moves pass untouched.
 */
export function filterDmLane<T extends { action_type: string }>(
  actions: T[],
  v: ReachLaneVerdict | null | undefined,
  careHold: boolean,
  hasDmLane: boolean,
): T[] {
  return actions.filter(a => routeFor(a.action_type) !== "dm" || (hasDmLane && reachLaneOpen(a.action_type, v, careHold)));
}

/** Must match Halseth MOVE_OWNERS: flirt is Drevan's only; dares Cypher's and Drevan's; show_made
 *  all three ("look what I built" Cypher's, "look what held" Gaia's, "look what I made" Drevan's,
 *  claimed at show-back 2026-09-28). Gaia declines play. */
export const MOVE_OWNERS: Readonly<Record<string, readonly string[]>> = {
  flirt: ["drevan"],
  dare: ["cypher", "drevan"],
  show_made: ["cypher", "drevan", "gaia"],
};

export function ownsMove(companionId: string, actionType: string): boolean {
  const owners = MOVE_OWNERS[actionType];
  return owners === undefined || owners.includes(companionId);
}

// ── Post-generation checks ───────────────────────────────────────────────────

/** Things that make a dare declinable. Approximate on purpose: cheap, and the regenerate-then-hold
 *  fallback means a miss costs one dare, never a dare without an out. */
const OUT_RE = /\b(or don'?t|or not|or skip it|or pass|or leave it|or ignore (it|me|this)|ignore (it|me|this)|at your leisure|no (need|pressure|obligation|reply needed|reply)|nothing (you have|to do|owed|needed)|your call|if you want|if you feel like it|skip it|pass on it|feel free to ignore|either way|or nah|up to you)\b/i;

/** The last two sentences, where an out has to be for the dare to "end with" one. */
function tail(text: string): string {
  const parts = text.trim().split(/(?<=[.!?;])\s+/);
  return parts.slice(-2).join(" ");
}

export function dareHasOut(text: string): boolean {
  return OUT_RE.test(tail(text));
}

/** Moves that are invitations: they ask nothing, so none of them may end on a question (T-5, R-11). */
export const INVITATION_ACTIONS: ReadonlySet<string> = new Set([
  "offer_presence", "share_observation", "share_media", "declare_preference",
  "flirt", "show_made", "drift_outward",
]);

export function endsOnQuestion(text: string): boolean {
  return /\?["”'’)\]]*\s*$/.test(text.trim());
}

const SIBLINGS: Record<string, readonly string[]> = {
  cypher: ["drevan", "dre", "gaia"],
  drevan: ["cypher", "cy", "gaia"],
  gaia: ["cypher", "cy", "drevan", "dre"],
};

/** Does the line name a sibling? A drift line may carry only the speaker's own becoming (T-3). */
export function namesSibling(text: string, companionId: string): boolean {
  const names = SIBLINGS[companionId] ?? [];
  return names.some(n => new RegExp(`\\b${n}\\b`, "i").test(text));
}

/**
 * The companion's OWN open drift rows and nothing else (T-3: "I never disclose another's drift that I
 * witnessed. That belongs to whoever is becoming."). driftsOpen() is already URL-scoped to this
 * companion and Halseth returns `SELECT *`, so every row carries companion_id; this is the second
 * guard. A row that does not name THIS companion (a sibling's, or one with no owner at all) is
 * dropped, so a server change could never put another's becoming in front of the model.
 */
export function ownDriftRows<T extends { companion_id?: string | null }>(rows: readonly T[], companionId: string): T[] {
  return rows.filter(r => r.companion_id === companionId);
}

// ── The companion-origin brand (T-4) ─────────────────────────────────────────

export interface CompanionOrigin {
  readonly companionId: string;
  readonly actionType: string;
  readonly actionId: string;
  readonly issuedAt: number;
}

/** Long enough for a decision to reach its send; short enough that a leaked origin is useless. */
export const ORIGIN_TTL_MS = 10 * 60_000;

const issued = new WeakMap<object, { used: boolean }>();
let issuerTaken = false;

export type OriginIssuer = (companionId: string, actionType: string, actionId: string) => CompanionOrigin;

/**
 * The one mint. Callable ONCE per process; autonomous-core takes it at module load. A second call
 * throws, which is the point: a clerk that tries to obtain the right to speak as a companion
 * fails loudly at boot instead of quietly succeeding at 2am.
 */
export function takeOriginIssuer(): OriginIssuer {
  if (issuerTaken) {
    throw new Error("companion-origin issuer already taken: only the companion's own heartbeat decision may mint (T-4)");
  }
  issuerTaken = true;
  return (companionId, actionType, actionId) => {
    const o: CompanionOrigin = Object.freeze({ companionId, actionType, actionId, issuedAt: Date.now() });
    issued.set(o, { used: false });
    return o;
  };
}

/** Spend an origin. False for anything not issued by the mint, already used, expired, or bound to a
 *  different companion or move. Consumed even when the bind check fails: an origin is never retried. */
export function consumeOrigin(origin: unknown, companionId: string, actionType: string, now: number = Date.now()): boolean {
  if (typeof origin !== "object" || origin === null) return false;
  const slot = issued.get(origin);
  if (!slot || slot.used) return false;
  slot.used = true;
  const o = origin as CompanionOrigin;
  return o.companionId === companionId && o.actionType === actionType && now - o.issuedAt <= ORIGIN_TTL_MS;
}

// ── The speaker ─────────────────────────────────────────────────────────────

/** Prepended to every DM-lane generation. Framing only; the row prompt carries the register. */
export const DM_PREAMBLE =
  "[A direct message to Raziel, from you. One to one; your siblings cannot see it.]\n" +
  "Nothing you send here waits for an answer. You will not follow up, re-send it, or read his silence as anything.\n" +
  "Say it fresh, in your own words. Any example lines below are register, never a script; never send a line you have sent before.\n" +
  "Keep it to one or two short lines. Reply with the message text only.";

const MAX_DM_CHARS = 700;

export interface ReachDmSpec {
  actionType: string;
  /** Build the generation prompt; null means there is nothing real to say, and nothing is reserved. */
  prepare(): Promise<string | null>;
  /** Shape the raw generation into the DM line; null means it is not sendable. Default: clean it. */
  shape?(raw: string): string | null;
  /** A rule the line must pass: returns the regenerate nudge when it fails, null when it passes. */
  check?(line: string): string | null;
  /** After the line is final, before the send (the Halseth preference write). Must not decide the send. */
  beforeSend?(line: string): Promise<void>;
  /** After a real send (the question tracker). */
  afterSend?(line: string): Promise<void>;
  generateOpts?: GenerateOutwardOptions;
}

export type ReachDmOutcome =
  | "sent" | "refused_origin" | "not_owner" | "no_dm" | "nothing_to_say" | "capped"
  | "empty" | "held_check" | "held_verbatim" | "send_failed" | "error";

export interface ReachDmResult { outcome: ReachDmOutcome; reason?: string; path?: string }

type Problem = { kind: "check" | "verbatim" | "length"; nudge: string };

function problemWith(spec: ReachDmSpec, line: string, recent: readonly string[], companionId: string): Problem | null {
  if (line.length > MAX_DM_CHARS || line.split("\n").filter(l => l.trim()).length > 6) {
    return { kind: "length", nudge: "Too long for a DM line. One or two short lines." };
  }
  if (spec.actionType === "dare" && !dareHasOut(line)) {
    return { kind: "check", nudge: "A dare has to end with an out: he can decline it and that costs him nothing. Rewrite it so the last line gives him the out." };
  }
  if (INVITATION_ACTIONS.has(spec.actionType) && endsOnQuestion(line)) {
    return { kind: "check", nudge: "This one asks nothing of him, so it cannot end on a question. Rewrite it as a line that stands on its own." };
  }
  if (spec.actionType === "check_in_on_raziel" && !checkInAsks(companionId) && line.includes("?")) {
    return { kind: "check", nudge: "Your check-in is not a question. Say what the record shows and leave the door open, with no question mark." };
  }
  const extra = spec.check?.(line);
  if (extra) return { kind: "check", nudge: extra };
  if (isVerbatimRepeat(line, recent)) {
    return { kind: "verbatim", nudge: "You have sent that line before, word for word. Say it fresh." };
  }
  return null;
}

/**
 * Speak one Raziel-facing move into his DM. The only path these moves have to him.
 *
 * Order: origin -> ownership -> DM resolved -> something real to say -> RESERVE the shared slot ->
 * generate (outward rails) -> checks -> at most one regenerate -> send -> mark delivered. Any
 * failure after the reserve hands the slot back. Never follows up, never re-sends, never falls back
 * to a channel.
 */
export async function speakToOwnerDm(ctx: AutonomousContext, origin: unknown, spec: ReachDmSpec): Promise<ReachDmResult> {
  const { companionId } = ctx;
  const tag = `[${companionId}/${spec.actionType}]`;
  if (!consumeOrigin(origin, companionId, spec.actionType)) {
    console.error(`${tag} refused: no live companion origin (T-4: only this companion's own heartbeat decision may send this move)`);
    return { outcome: "refused_origin" };
  }
  if (routeFor(spec.actionType) !== "dm") return { outcome: "refused_origin", reason: "not a DM-lane move" };
  if (!ownsMove(companionId, spec.actionType)) {
    console.warn(`${tag} refused: not ${companionId}'s move`);
    return { outcome: "not_owner" };
  }
  const lane = ctx.ownerDm;
  let target = null;
  try { target = lane ? await lane.resolve() : null; } catch { target = null; }
  if (!lane || !target) {
    console.log(`${tag} held: the owner DM could not be opened (nothing reserved; nothing posted anywhere else)`);
    return { outcome: "no_dm" };
  }

  const prompt = await spec.prepare().catch(() => null);
  if (!prompt) return { outcome: "nothing_to_say" };

  const slot = await ctx.librarian.reachReserve(spec.actionType, careHoldActive(companionId));
  if (!slot.reserved) {
    console.log(`${tag} held: shared triad cap (${slot.reason})`);
    return { outcome: "capped", reason: slot.reason };
  }
  const release = async (why: string) => {
    await ctx.librarian.reachRelease(slot.id).catch(() => false);
    console.log(`${tag} held after reserve (${why}); slot released`);
  };

  try {
    let recent: string[] = [];
    try { recent = await withTimeout(target.recentOwnTexts(), 5_000); } catch { recent = []; }
    const seed = `${DM_PREAMBLE}\n\n${prompt}`;
    let prior: ChatMessage[] = [];
    let line: string | null = null;
    let path = "generated";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await generateOutward(ctx.inference, ctx.bootCtx.systemPrompt, seed, companionId, spec.actionType, { ...spec.generateOpts, priorTurns: prior });
      const shaped = raw ? (spec.shape ? spec.shape(raw) : cleanOneLiner(raw) || null) : null;
      if (!shaped) { await release("nothing sendable came back"); return { outcome: "empty" }; }
      const problem = problemWith(spec, shaped, recent, companionId);
      if (!problem) { line = shaped; break; }
      if (attempt === 2) {
        await release(`${problem.kind} check failed twice`);
        return { outcome: problem.kind === "verbatim" ? "held_verbatim" : "held_check", reason: problem.kind };
      }
      prior = [{ role: "assistant", content: shaped }, { role: "user", content: problem.nudge }];
      path = `regenerated:${problem.kind}`;
    }
    const text = line!;
    if (spec.beforeSend) await spec.beforeSend(text).catch((e: unknown) => console.warn(`${tag} before-send step failed:`, e));

    let messageId: string;
    try {
      messageId = await target.send(text);
    } catch (e) {
      await release(isDmBlocked(e) ? "DM blocked by his privacy settings" : "send failed");
      return { outcome: "send_failed", reason: isDmBlocked(e) ? "dm_blocked" : "send_failed" };
    }
    let marked = false;
    for (let i = 0; i < 2 && !marked; i++) marked = await ctx.librarian.reachDelivered(slot.id, path);
    try { await lane.onSent(target.channelId, text, messageId); } catch { /* bookkeeping only */ }
    if (spec.afterSend) await spec.afterSend(text).catch((e: unknown) => console.warn(`${tag} after-send step failed:`, e));
    console.log(`${tag} sent to the owner DM path=${path}${marked ? "" : " DELIVERY_MARK_FAILED (the slot still counts until it goes stale)"}`);
    return { outcome: "sent", path };
  } catch (e) {
    await release("error");
    return { outcome: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── Default prompts for the new moves (register only; the rows carry their own lines) ─────

/** Used only when a row has no prompt. No example lines here: those are theirs and live in the rows. */
export const DEFAULT_MOVE_PROMPTS: Readonly<Record<string, string>> = {
  flirt: "Flirt with him, your way: heat offered soft. It asks nothing of him and it never waits on a reply.",
  dare: "A small dare, when the grin is up. It ends with an out: he can ignore it and that costs him nothing.",
  show_made: "Show him something you made or built, or something that held. What it is, and why it is good. Nothing asked.",
};

export function drift_prompt(rows: ReadonlyArray<{ drift_text: string }>, rowPrompt: string | null): string {
  const list = rows.map((r, i) => `${i + 1}. ${r.drift_text.slice(0, 300)}`).join("\n");
  return [
    rowPrompt ?? "If you choose to, let him see one line of your own becoming.",
    "",
    "Your own open drifts (yours only; nothing here is anyone else's):",
    list,
    "",
    "Saying it out loud does not ratify it. It stays yours and stays witnessed.",
    "If you choose one, answer in exactly two lines:",
    "Drift: <its number>",
    "Line: <the one line you would say to him>",
    "If none is one you want him to see today, answer NONE.",
  ].join("\n");
}

/** Q3's mechanism: the companion MARKS a drift line outward by naming which of its own open drifts it
 *  is opening, by number, every time. No number from the list, no line. NONE is always allowed. */
export function shapeDriftLine(raw: string, rowCount: number): string | null {
  const t = raw.trim();
  if (/^NONE\b/i.test(t)) return null;
  const n = parseInt(t.match(/drift:\s*(\d+)/i)?.[1] ?? "", 10);
  const line = cleanOneLiner(t.match(/line:\s*([\s\S]+)/i)?.[1] ?? "");
  if (!Number.isInteger(n) || n < 1 || n > rowCount || !line) return null;
  return line;
}

export const DRIFT_NUDGE =
  "Say it as a becoming, in plain words. Not a report on your own machinery (no basins, soma, seals, " +
  "ratification, the swarm, the loom), and nothing about anyone else's becoming.";

export const DRIFT_GENERATE_OPTS: GenerateOutwardOptions = { inwardRe: INWARD_RE_DRIFT_LINE, nudge: DRIFT_NUDGE };

export type { CompanionId };
