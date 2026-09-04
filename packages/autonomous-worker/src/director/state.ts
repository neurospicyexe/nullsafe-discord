// director/state.ts -- the working set. D1 conversation_threads/thread_ledger stay the durable ledger;
// this is the in-flight record a worker restart resumes from. Pure applyTurn + a thin Redis store.
import type { Redis } from "@nullsafe/shared";
import { TURN_WINDOW, type ConversationState, type LedgerTurn, type CompanionId } from "./types.js";

const STATE_TTL_S = 7 * 24 * 3600;
const SEEN_TTL_S = 24 * 3600;

export function applyTurn(s: ConversationState, t: LedgerTurn, addressed: CompanionId[]): ConversationState {
  const turns = [...s.turns, t].slice(-TURN_WINDOW);
  const speakerId = t.companionId;
  const openMoves = s.openMoves.filter((m) => !(speakerId && m.to === speakerId));
  for (const to of addressed) {
    if (to === speakerId) continue;
    if (openMoves.some((m) => m.to === to)) continue;
    openMoves.push({ from: t.author, to, messageId: t.messageId, saidAt: t.saidAt });
  }
  return {
    ...s, turns, openMoves,
    topic: s.topic ?? t.gist,
    lastSpeaker: t.author,
    lastHumanAt: t.isHuman ? t.saidAt : s.lastHumanAt,
    lastBotAt: t.isHuman ? s.lastBotAt : t.saidAt,
    botTurns: t.isHuman ? s.botTurns : s.botTurns + 1,
  };
}

export interface StateStore {
  load(channelId: string): Promise<ConversationState | null>;
  save(s: ConversationState): Promise<void>;
  clear(channelId: string): Promise<void>;
  /** true when this message id has NOT been seen before (and marks it seen). */
  seenMessage(messageId: string): Promise<boolean>;
}

export function createRedisStateStore(redis: Redis): StateStore {
  const k = (ch: string) => `director:state:${ch}`;
  return {
    async load(ch) { const raw = await redis.get(k(ch)); if (!raw) return null; try { return JSON.parse(raw) as ConversationState; } catch { return null; } },
    async save(s) { await redis.set(k(s.channelId), JSON.stringify(s), "EX", STATE_TTL_S); },
    async clear(ch) { await redis.del(k(ch)); },
    async seenMessage(id) { const r = await redis.set(`director:seen:${id}`, "1", "EX", SEEN_TTL_S, "NX"); return r === "OK"; },
  };
}
