// The owner-DM lane: the ONE way a proactive message reaches Raziel's DM (B7 steps 2b, 2, 2c).
//
// 2b built this inline for med_reminder (bot-core resolveOwnerDm + the scheduler's onSent). Steps
// 2 and 2c route every Raziel-facing metronome move to the same DM, so the lane is lifted here and
// shared rather than written a second time. Both users get the same three things:
//
//   1. resolve(): the owner's 1:1 DM, opened once over REST, sealed as a recall source
//      (recall-context.ts sealDmChannel) the moment it exists.
//   2. onSent(): the bookkeeping after a real send (sentIds so a reply to it reaches this bot, STM
//      so the reply turn knows what it said). Nothing else.
//   3. isVerbatimRepeat(): R-8, "never verbatim twice", against this bot's own recent DM texts.
//
// WHY NOT sendAutonomousMessage. That path writes the text into a wm note, the Second Brain live
// index and voice telemetry, which are exactly the raw-quote surfaces 2b sealed for DMs (dm.ts). A DM
// sent through it would leak into orient in a shared room. Nothing here writes anywhere but the DM.

import { verbatimCopyOf } from "./echo-guard.js";

/** The owner's DM with this bot, reduced to what a sender needs (keeps discord.js out of tests). */
export interface OwnerDmTarget {
  channelId: string;
  /** Send; resolves to the message id. Throws on failure (the error's `code` is read). */
  send(content: string): Promise<string>;
  /** This bot's own recent messages in the DM, newest last. The R-8 pool. */
  recentOwnTexts(): Promise<string[]>;
}

/** Built once in bot-core and handed to every proactive DM sender. */
export interface OwnerDmLane {
  resolve(): Promise<OwnerDmTarget | null>;
  /** After a real send. Must not throw. */
  onSent(channelId: string, text: string, messageId: string): void | Promise<void>;
}

/** R-8 on an autonomous send: exact-after-normalisation against this companion's recent DMs. These
 *  lines are short, far under the reply rail's 120-char floor, so the floor is lifted here (2b's
 *  decision, kept); under 8 words the shingler compares whole normalised strings, which is exactly
 *  "verbatim". */
export function isVerbatimRepeat(text: string, recent: readonly string[]): boolean {
  return verbatimCopyOf(text, recent.map(t => ({ text: t, label: "self" })), { minChars: 1 }).copied;
}

/** Strip the wrappers a model adds around a short line (quotes, a "Message:" lead). */
export function cleanOneLiner(raw: string | null | undefined): string {
  let t = (raw ?? "").trim();
  t = t.replace(/^(message|dm|reply)\s*:\s*/i, "").trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/** Discord error 50007: "Cannot send messages to this user" (his privacy settings block the DM). */
export function isDmBlocked(e: unknown): boolean {
  return (e as { code?: number })?.code === 50007;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
