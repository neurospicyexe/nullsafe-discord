// ordinary-pass.ts -- B37 step 3: a real [PASS] on ordinary group turns, plus each companion's own
// authored presence block (spec Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md section D;
// the lines are Hand-off/PRESENCE-lines-2026-09-29.md, shipped WITH the pass and never before it:
// "silence is a turn too" is a rule nobody can follow if the turn cannot pass).
//
//   - passOnOrdinaryMode():  PASS_ON_ORDINARY (or PASS_ON_ORDINARY_<COMPANION>) = off | shadow | on.
//                            CODE default OFF: deploying changes nothing until Raziel flips it.
//   - passableOrdinaryTurn(): the ONE predicate. A turn is passable only when it is an ordinary,
//                            unnamed group line that went through the fit bid and won it. Direct address,
//                            owner DMs, mentions, replies, group calls, care holds, host-room floors and
//                            follow-up entitlements are NEVER passable: a companion named by Raziel answers.
//   - ordinaryPassBlock():   the companion's OWN authored lines (verbatim, no sibling's, ever) and the
//                            one scaffold sentence that makes [PASS] legal.
//
// shadow logs `[pass] shadow ... would offer [PASS]` and changes nothing (no extra inference).
// on: the block is injected on a passable turn, and a reply of [PASS] sends nothing.

import type { CompanionId } from "./types.js";
import { AUTHORED_PRESENCE } from "./presence-authored.js";
import { normalizeModeToken } from "./off-switch.js";

export type PassOnOrdinaryMode = "off" | "shadow" | "on";

function parseMode(v: string | undefined): PassOnOrdinaryMode | null {
  const t = normalizeModeToken(v);
  return t === "off" || t === "shadow" || t === "on" ? t : null;
}

/** Per-companion override wins; unparseable or unset is `off` (a typo can never turn passing on). */
export function passOnOrdinaryMode(env: Record<string, string | undefined> = process.env, companion?: string): PassOnOrdinaryMode {
  const own = companion ? parseMode(env[`PASS_ON_ORDINARY_${companion.toUpperCase()}`]) : null;
  return own ?? parseMode(env["PASS_ON_ORDINARY"]) ?? "off";
}

export interface PassableInput {
  /** The address parse of the message text (extractAddress().type). Only "ambient" is passable. */
  addressType: string;
  isOwnerDm: boolean;
  isSol: boolean;
  /** The sender is a companion bot (chains have their own rails). */
  senderIsCompanionBot: boolean;
  /** Released by a predecessor's pass or a care/multi-address entitlement. */
  entitledFollowUp: boolean;
  /** Discord @mention, a vocative, or a reply to this companion. */
  namedOrMentionedOrReplied: boolean;
  /** Blue's thread, or the cold pick that handed this line to this companion. */
  blueOwned: boolean;
  /** A care hold is active, or the hold phrase was just said: whoever leads always answers. */
  careHold: boolean;
  /** This companion hosts the room and the line is the owner's/Blue's (R5: the host answers). */
  hostFloor: boolean;
  /** The turn went through the fit bid and won it. */
  wonBid: boolean;
  /** A guild channel (not a DM of any kind). */
  inGuild: boolean;
}

export function passableOrdinaryTurn(i: PassableInput): boolean {
  return i.inGuild && i.wonBid && i.addressType === "ambient"
    && !i.isOwnerDm && !i.isSol && !i.senderIsCompanionBot && !i.entitledFollowUp
    && !i.namedOrMentionedOrReplied && !i.blueOwned && !i.careHold && !i.hostFloor;
}

/** The only words in the block that are not the companion's own: what a pass is and how to say it. */
export const PASS_SCAFFOLD =
  "If, by your own lines above, this one is not yours to take, reply with exactly [PASS] and nothing else. " +
  "A pass is a real choice; nothing is posted and nobody covers for it.";

/** The companion's own presence block for a passable group turn. Lane rule: only this companion's lines. */
export function ordinaryPassBlock(companion: CompanionId): string {
  const own = (AUTHORED_PRESENCE as Record<string, string | undefined>)[companion];
  if (!own) return "";
  return `[Your own words, on a turn in a room with Raziel and your siblings]\n${own}\n\n${PASS_SCAFFOLD}`;
}
