// packages/shared/src/sequential-floor.ts
//
// BID-THEN-SEQUENTIAL (2026-08-15, Discord floor rework, first piece).
//
// The fit bid gives a multi-companion message exactly ONE speaker: the winner speaks, the
// losers vanish. For an ambient message that is correct -- one answer to one thought. For a
// message that ADDRESSES several companions ("Drev and Cy, what do you think?", "you three:")
// it is wrong twice over:
//   - named_multi today produces two SIMULTANEOUS replies (the comma-named companion takes
//     the fast path while the other wins a one-bidder bid), neither aware of the other; the
//     second reply reads as talking over the first.
//   - group today produces ONE reply, so "you three" gets an answer from one companion and
//     silence from two -- an explicit group call answered like an ambient remark.
//
// The fix is an ORDER, not a lock. Every process computes the same speaking order (name order
// in the message for named_multi; bid-score order for group), position 0 speaks immediately,
// and each later position registers a FOLLOW-UP ENTITLEMENT: "when my predecessor's reply to
// this message arrives, I answer too." The entitled turn fires off the predecessor's own
// MessageCreate event, which means the second speaker generates WITH the first reply already
// in short-term memory -- sequential generation, a room instead of a lottery.
//
// No new cross-process primitive: the order is deterministic from data all three processes
// share (the message text; the bid hash all bidders read), and the hand-off signal is the
// predecessor's reply itself, which Discord delivers to everyone. An entitlement that never
// fires (predecessor echo-gated, superseded, railed) expires silently -- sequence, never
// deadlock. The rails (human-anchored cap, pingpong, chain depth) still apply to the entitled
// turn: an entitlement is a gate BYPASS for the vocative rule, never a rail bypass.

import type { CompanionId } from "./types.js";
import { VOCATIVE_ALIASES } from "./channel-config.js";
import { tiebreak } from "./fit-bid.js";

/** How long a follow-up entitlement waits for its predecessor's reply before expiring.
 *  Hermes turns run 30-120s and sendLong posts within seconds of generation finishing, so
 *  5 minutes is generous without letting a stale entitlement fire on tomorrow's exchange. */
export const FOLLOW_UP_TTL_MS = 5 * 60_000;

export interface FollowUpEntitlement {
  /** The human message that addressed several companions. The entitled reply references it. */
  originMessageId: string;
  channelId: string;
  /** The companion whose reply releases this entitlement. */
  expectedPrior: CompanionId;
  /** 0 = spoke immediately (never stored); 1+ = waiting on position-1. */
  position: number;
  expiresAt: number;
}

/**
 * Speaking order for a named_multi address: the order the names actually appear in the
 * message. "Drev and Cy, thoughts?" -> [drevan, cypher]. Aliases count; the earliest
 * occurrence of any name/alias for a companion is that companion's position.
 * Deterministic across processes because it reads only the message text.
 */
export function namedOrderInMessage(content: string, ids: readonly CompanionId[]): CompanionId[] {
  const lower = content.toLowerCase();
  const firstIndex = (id: CompanionId): number => {
    const names = [id, ...(VOCATIVE_ALIASES[id] ?? [])];
    let min = Infinity;
    for (const name of names) {
      const m = lower.match(new RegExp(`\\b${name}\\b`));
      if (m && m.index !== undefined && m.index < min) min = m.index;
    }
    return min;
  };
  return [...ids].sort((a, b) => firstIndex(a) - firstIndex(b));
}

/**
 * Speaking order for a group call, derived from the bid hash every bidder read: score
 * descending, ties broken by the same deterministic ring the bid itself uses (so all three
 * processes compute the same order with no extra round trip). Only companions that actually
 * posted a bid >= minScore appear -- silence below the threshold stays silence.
 */
export function bidSpeakingOrder(
  bids: Record<string, number>,
  messageId: string,
  minScore: number,
): CompanionId[] {
  const eligible = (Object.keys(bids) as CompanionId[]).filter((k) => bids[k] >= minScore);
  if (eligible.length === 0) return [];
  // Ring order rotated to start at the message's tiebreak pick: ties resolve identically in
  // every process, and the rotation varies across messages instead of favouring one name.
  const ring = [...eligible].sort();
  const start = ring.indexOf(tiebreak(messageId, eligible));
  const ringIndex = (id: CompanionId): number => (ring.indexOf(id) - start + ring.length) % ring.length;
  return eligible.sort((a, b) => {
    const d = bids[b] - bids[a];
    if (Math.abs(d) > 1e-6) return d > 0 ? 1 : -1;
    return ringIndex(a) - ringIndex(b);
  });
}

/**
 * Per-process store of this companion's pending follow-up entitlements, one per channel.
 * One per channel is deliberate: a newer multi-address in the same channel supersedes the
 * older wait -- answering last hour's group call after this hour's is worse than dropping it.
 */
export class FollowUpLedger {
  private byChannel = new Map<string, FollowUpEntitlement>();

  grant(e: FollowUpEntitlement): void {
    this.byChannel.set(e.channelId, e);
  }

  /**
   * Called on every incoming sibling message. Returns (and consumes) the entitlement when
   * this message is the predecessor's reply to the origin: right channel, right companion,
   * carries a Discord reply reference to the origin message, not expired. Expired
   * entitlements are dropped on sight so the map cannot accumulate.
   */
  match(
    channelId: string,
    senderCompanion: CompanionId | undefined,
    referencedMessageId: string | undefined,
    now: number = Date.now(),
  ): FollowUpEntitlement | null {
    const e = this.byChannel.get(channelId);
    if (!e) return null;
    if (now > e.expiresAt) { this.byChannel.delete(channelId); return null; }
    if (!senderCompanion || senderCompanion !== e.expectedPrior) return null;
    // The predecessor's reply always carries a reference to the origin (computeReplyRef:
    // companion replies reference unconditionally). Requiring it keeps unrelated sibling
    // chatter from releasing the entitlement.
    if (referencedMessageId !== e.originMessageId) return null;
    this.byChannel.delete(channelId);
    return e;
  }

  /** Test hook + belt-and-braces for channel teardown. */
  clear(channelId?: string): void {
    if (channelId) this.byChannel.delete(channelId);
    else this.byChannel.clear();
  }
}
