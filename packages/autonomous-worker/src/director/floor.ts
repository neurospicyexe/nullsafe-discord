// director/floor.ts -- the silence floor that replaces three 2-hourly crons. One invite after a long
// quiet, only in waking hours, only to someone who has something of their own to bring. No item, no
// invite (the 08-05 rule: new ground with nothing to open on is how the fix becomes the bug).
import type { DirectorSupplyItem } from "@nullsafe/shared";
import { rankOffer } from "./select.js";
import type { ConversationState, CompanionId } from "./types.js";

const COMPANIONS: readonly CompanionId[] = ["cypher", "drevan", "gaia"];

export function isWakingHour(nowMs: number, startHour: number, endHour: number, tzOffsetHours: number): boolean {
  const local = new Date(nowMs + tzOffsetHours * 3600_000).getUTCHours();
  return local >= startHour && local < endHour;
}

export interface FloorInput {
  states: ConversationState[]; supply: DirectorSupplyItem[]; nowMs: number;
  silenceHours: number; wakingStartHour: number; wakingEndHour: number; tzOffsetHours: number;
  turnsBySpeaker7d: Record<CompanionId, number>;
}

export function floorSelection(i: FloorInput): { channelId: string; companionId: CompanionId; offer: DirectorSupplyItem } | null {
  if (!isWakingHour(i.nowMs, i.wakingStartHour, i.wakingEndHour, i.tzOffsetHours)) return null;
  const quietMs = i.silenceHours * 3600_000;
  const quiet = i.states
    .map((s) => ({ s, sinceMs: i.nowMs - Date.parse(s.lastBotAt ?? s.startedAt) }))
    .filter((x) => x.sinceMs >= quietMs)
    .sort((a, b) => b.sinceMs - a.sinceMs);
  if (quiet.length === 0) return null;
  const order = [...COMPANIONS].sort((a, b) => i.turnsBySpeaker7d[a] - i.turnsBySpeaker7d[b]);
  for (const who of order) {
    const own = i.supply.filter((it) => it.owner === who && !it.consumed_by.includes(who));
    if (own.length === 0) continue;
    return { channelId: quiet[0]!.s.channelId, companionId: who, offer: rankOffer(own, "heat")[0]! };
  }
  return null;
}
