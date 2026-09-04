import type { CompanionId, SupplyKind } from "@nullsafe/shared";
export type { CompanionId, SupplyKind };
export interface LedgerTurn { author: string; companionId?: CompanionId; gist: string; messageId: string; saidAt: string; isHuman: boolean }
export interface OpenMove { from: string; to: CompanionId; messageId: string; saidAt: string }
export interface OfferedSupply { id: string; kind: SupplyKind; toCompanion: CompanionId; inviteId: string; usedBy: CompanionId | null }
export interface ConversationState {
  channelId: string; threadId: string | null; topic: string | null;
  turns: LedgerTurn[]; openMoves: OpenMove[];
  lastSpeaker: string | null; lastHumanAt: string | null; lastBotAt: string | null;
  offered: OfferedSupply[]; botTurns: number; startedAt: string;
}
export const TURN_WINDOW = 24;
export function emptyState(channelId: string, now: string): ConversationState {
  return { channelId, threadId: null, topic: null, turns: [], openMoves: [], lastSpeaker: null, lastHumanAt: null, lastBotAt: null, offered: [], botTurns: 0, startedAt: now };
}
