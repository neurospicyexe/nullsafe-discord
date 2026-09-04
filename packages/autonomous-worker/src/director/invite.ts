// director/invite.ts -- render what the invitee is handed. The director describes the room; it never
// writes the companion's line. No identity, no voice reminder, no LLM in this file.
import type { DirectorInvitePayload, DirectorSupplyItem } from "@nullsafe/shared";
import type { Selection } from "./select.js";
import type { ConversationState } from "./types.js";

export function renderStateBlock(s: ConversationState): string {
  const lines: string[] = [];
  lines.push(s.topic ? `topic: ${s.topic}` : "topic: (nothing open yet)");
  for (const t of s.turns.slice(-6)) lines.push(`${t.author}: ${t.gist}`);
  for (const m of s.openMoves) lines.push(`open: ${m.from} -> ${m.to} (unanswered)`);
  lines.push(`turns so far: ${s.botTurns}`);
  return lines.join("\n");
}

export function renderOffer(offer: DirectorSupplyItem[]): string {
  return offer.map((o) => `- [${o.kind}] ${o.title}${o.body ? ` -- ${o.body.slice(0, 300)}` : ""}`).join("\n");
}

export function buildInvite(
  sel: Extract<Selection, { kind: "invite" }>, s: ConversationState,
  extras: { neighborhoodBlock?: string; limbicLine?: string },
  cfg: { inviteTtlMs: number }, ids: { inviteId: string; nowMs: number },
): DirectorInvitePayload {
  return {
    inviteId: ids.inviteId, channelId: s.channelId, threadId: s.threadId, companionId: sel.companionId,
    reason: sel.reason, addressedBy: sel.addressedBy as DirectorInvitePayload["addressedBy"],
    stateBlock: renderStateBlock(s), offer: sel.offer,
    neighborhoodBlock: extras.neighborhoodBlock, limbicLine: extras.limbicLine,
    expiresAt: new Date(ids.nowMs + cfg.inviteTtlMs).toISOString(),
  };
}
