// packages/shared/src/pass-turn.ts
//
// What a follow-up PASS turn is allowed to do (2026-09-26 review of 07158d4 / 5d61566).
//
// A pass turn (sequential-floor.ts followUpPassFor -> bot-core's listener -> handleMessage with
// `followUpPass`) re-reads the HUMAN origin message after a predecessor in a multi-address order
// was silenced. It runs the whole handler on that message a second time, and the handler was
// written for arrivals: every branch keyed on "is this a human message?" answered yes, so a pass
// turn
//   - reset the bot-to-bot rails (human-anchored cap, pingpong cooldown, cycle guard) as if Raziel
//     had just spoken again, and skipped the cap / cooldown / chain-depth checks entirely -- the
//     opposite of sequential-floor.ts's promise that an entitlement bypasses the vocative gate and
//     NONE of the rails;
//   - re-ran the ambient relevance classifier in owner_only channels, which could say "not for
//     me" and drop an entitlement the listener had already consumed;
//   - repeated arrival work: the PK claim hold, voice STT, the vision pass (~90s an image), the
//     session-window touch;
//   - could voice (follow-ups never voice), and got generic "your companion already spoke"
//     framing instead of "Raziel addressed several of you".
//
// Every one of those is decided here, pure, and the handler calls these at each site, so the
// tests below drive the same predicates the live path uses.

import type { SeenImage } from "./vision.js";
import { FOLLOW_UP_TTL_MS } from "./sequential-floor.js";

/** The two facts every decision below turns on. */
export interface TurnKind {
  /** Structural: a bot user with no webhook (a PK proxy is a human). */
  isCompanionBot: boolean;
  /** False for a follow-up pass turn: the message already arrived once. */
  isArrival: boolean;
}

/**
 * Do the bot-to-bot rails (human-anchored cap, pingpong cooldown, per-human reply cap, chain
 * depth, and the post-send counter) govern this turn? A sibling-triggered turn, yes. A pass turn,
 * yes: it is a follow-up in a companion chain on a message Raziel sent once, not a new message.
 */
export function appliesBotRails(t: TurnKind): boolean {
  return t.isCompanionBot || !t.isArrival;
}

/** Only a human message ARRIVING re-opens the floor: counters, cooldown and cycle guard reset. */
export function resetsBotRails(t: TurnKind): boolean {
  return !t.isCompanionBot && t.isArrival;
}

/**
 * The quiet-gap reset of stale rails (an autonomous seed hours later must not stay wedged by the
 * last thread's counters). A pass turn never takes it: the gap it would measure is the one
 * between the origin and what came before it, which says nothing about the chain it is in.
 */
export function clearsStaleRails(t: TurnKind & { isNewThread: boolean }): boolean {
  return t.isCompanionBot && t.isArrival && t.isNewThread;
}

export type BotRailSilence = "human-anchored-cap" | "pingpong-cooldown" | "per-human-cap";

/** Which rail silences this turn, or null. Only consulted when appliesBotRails. */
export function botRailSilence(p: {
  botTurnsSinceHuman: number;
  capMax: number;
  cooldownUntil: number;
  botReplies: number;
  maxBotReplies: number;
  now: number;
}): BotRailSilence | null {
  if (p.botTurnsSinceHuman >= p.capMax) return "human-anchored-cap";
  if (p.now < p.cooldownUntil) return "pingpong-cooldown";
  if (p.botReplies >= p.maxBotReplies) return "per-human-cap";
  return null;
}

/**
 * Should the ambient relevance classifier judge this message? Only an unaddressed human message
 * in an owner_only channel. Never an entitled follow-up: the entitlement IS the decision that this
 * companion answers, and for a pass it was consumed before the turn ran, so a "no" here would drop
 * it silently.
 */
export function runsAmbientClassifier(p: {
  ownerOnlyChannel: boolean;
  isCompanionBot: boolean;
  isMentioned: boolean;
  isReplyToMe: boolean;
  directlyAddressed: boolean;
  namesSiblingOnly: boolean;
  entitled: boolean;
}): boolean {
  return p.ownerOnlyChannel && !p.isCompanionBot && !p.isMentioned && !p.isReplyToMe
    && !p.directlyAddressed && !p.namesSiblingOnly && !p.entitled;
}

/** Voice is for a human-facing turn that is not a follow-up. Follow-ups (pass or not) never voice. */
export function mayVoice(p: { isCompanionBot: boolean; entitled: boolean }): boolean {
  return !p.isCompanionBot && !p.entitled;
}

const label = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * The peer framing block for this turn. Pure; the handler appends it to the context prompt.
 *
 *   - entitled, released by the predecessor's REPLY: "X has just answered, now you".
 *   - entitled, released by a PASS: the predecessor did NOT answer (a rail silenced it), so the
 *     block must not say it did -- a model told "do not paraphrase X" goes looking for X's reply.
 *     It names the pass and lists whatever earlier positions did say.
 *   - a sibling message, not entitled: peer-to-peer exchange.
 *   - a human message: note any sibling replies already under it.
 */
export function turnFraming(p: {
  isCompanionBot: boolean;
  /** The releasing sibling's label on a normal follow-up; the trigger author otherwise. */
  peerLabel: string;
  entitled: { expectedPrior: string } | null;
  viaPass: boolean;
  /** Sibling replies after the trigger, already formatted `Name: "text"`. */
  peerReplies: string[];
}): string {
  if (p.entitled && p.viaPass) {
    const prior = label(p.entitled.expectedPrior);
    const said = p.peerReplies.length
      ? `\n[Already said to it:\n${p.peerReplies.join("\n")}\nDo not repeat or paraphrase them -- add what only you would say.]`
      : "";
    return `\n\n[Raziel addressed several of you at once. ${prior} was to answer before you and is not answering this one, so the turn passes to you: answer Raziel's original message with your own read.]${said}`;
  }
  if (p.entitled) {
    return `\n\n[Raziel addressed several of you at once, and ${p.peerLabel} has just answered. Now it is your turn: answer Raziel's original message with your own read. Do not repeat or paraphrase ${p.peerLabel} -- add what only you would say. Acknowledging ${p.peerLabel} in passing is fine.]`;
  }
  if (p.isCompanionBot) {
    return `\n\n[You are in direct exchange with ${p.peerLabel}. This is triad space -- peer to peer. Speak to them and to the moment. Do not address Raziel or explain the triad. Respond from inside it.]`;
  }
  if (p.peerReplies.length > 0) {
    return `\n\n[Your companion has already spoken to this:\n${p.peerReplies.join("\n")}\nYou are in this together. You may address them -- respond from inside the triad, not solely toward Raziel.]`;
  }
  return "";
}

/** FOLLOWUP_PASS: default on; exactly "off" (trimmed, any case) disables publish and listener. */
export function followUpPassEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env["FOLLOWUP_PASS"] ?? "").trim().toLowerCase() !== "off";
}

// ── Arrival media, kept for the pass turn ───────────────────────────────────

/** What the arrival turn derived from the message's attachments. */
export interface ArrivalMedia {
  /** The STT transcript when the message was a voice note; null otherwise. */
  transcript: string | null;
  seenImages: SeenImage[];
}

/**
 * Per-process memory of each arrival's STT transcript and image descriptions, keyed by message id,
 * so a pass turn on the same message reuses them instead of paying STT and a ~90s-per-image vision
 * pass again. The TTL outlives the entitlement it serves (FOLLOW_UP_TTL_MS): a pass can only arrive
 * while an entitlement is live, and one that outlived the cache would re-run the vision call.
 */
export const ARRIVAL_MEDIA_TTL_MS = FOLLOW_UP_TTL_MS + 60_000;

export class ArrivalMediaCache {
  private byId = new Map<string, { media: ArrivalMedia; expiresAt: number }>();

  constructor(private ttlMs = ARRIVAL_MEDIA_TTL_MS, private cap = 200) {}

  set(messageId: string, media: ArrivalMedia, now: number = Date.now()): void {
    this.byId.delete(messageId);
    this.byId.set(messageId, { media, expiresAt: now + this.ttlMs });
    while (this.byId.size > this.cap) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  get(messageId: string, now: number = Date.now()): ArrivalMedia | null {
    const e = this.byId.get(messageId);
    if (!e) return null;
    if (now > e.expiresAt) { this.byId.delete(messageId); return null; }
    return e.media;
  }

  get size(): number { return this.byId.size; }
}

/**
 * How this turn gets its attachment content.
 *   arrival      -> run STT and vision as always; record the result for a later pass.
 *   pass + hit   -> reuse the arrival's transcript and descriptions; run nothing.
 *   pass + miss  -> the cache aged out or was evicted. STT is re-run (a voice note's text IS the
 *                   message; without it the turn is empty) but a failure is never announced in
 *                   the channel -- the arrival already said so if it failed. Vision is NOT re-run:
 *                   the images are named as not looked at, which the prompt block says plainly.
 */
export function arrivalMediaPlan(isArrival: boolean, cached: ArrivalMedia | null): {
  reuse: ArrivalMedia | null;
  runStt: boolean;
  announceSttFailure: boolean;
  runVision: boolean;
  record: boolean;
} {
  if (isArrival) return { reuse: null, runStt: true, announceSttFailure: true, runVision: true, record: true };
  if (cached) return { reuse: cached, runStt: false, announceSttFailure: false, runVision: false, record: false };
  return { reuse: null, runStt: true, announceSttFailure: false, runVision: false, record: false };
}
