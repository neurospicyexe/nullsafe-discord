// director/select.ts -- zero-LLM speaker selection (spec §4). Pure. First matching rule wins.
// Never round-robin, never fills time: fairness is the silence floor's job (floor.ts), not this one's.
import type { DirectorSupplyItem } from "@nullsafe/shared";
import type { ConversationState, CompanionId } from "./types.js";

// "open" and "off_hours" are produced by floor.ts (Task 11), not by select().
export type SelectReason = "addressed" | "supply_relevant" | "open";
export type SilenceReason = "human_floor" | "budget" | "no_uptake" | "nothing_to_add" | "off_hours";
export type Selection =
  | { kind: "invite"; companionId: CompanionId; reason: SelectReason; offer: DirectorSupplyItem[]; addressedBy?: string }
  | { kind: "silence"; reason: SilenceReason };
export interface SelectInput {
  state: ConversationState; supply: DirectorSupplyItem[]; nowMs: number;
  turnBudget: number; noUptakeMs: number; humanFloorMs: number; order: "heat" | "recency";
}

const COMPANIONS: readonly CompanionId[] = ["cypher", "drevan", "gaia"];
const STOP = new Set(["the","and","that","this","with","from","have","were","they","them","what","when","which","would","there","their","about","into","just","like","been","then","than","also","your","some","more","only","over","very","still"]);
const isCompanion = (s: string): s is CompanionId => (COMPANIONS as readonly string[]).includes(s);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z']+/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)));
}

/** Overlap of the item's words with the live topic + last 3 gists, as a fraction of the item's words. */
export function relevance(item: DirectorSupplyItem, state: ConversationState): number {
  const live = words([state.topic ?? "", ...state.turns.slice(-3).map((t) => t.gist)].join(" "));
  const own = words(`${item.title} ${item.body}`);
  if (own.size === 0 || live.size === 0) return 0;
  let hits = 0; for (const w of own) if (live.has(w)) hits++;
  return hits / own.size;
}

export function rankOffer(items: DirectorSupplyItem[], order: "heat" | "recency"): DirectorSupplyItem[] {
  return [...items].sort((a, b) => {
    if (order === "heat") { const dh = (b.heat ?? 0) - (a.heat ?? 0); if (dh !== 0) return dh; }
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}

export function select(i: SelectInput): Selection {
  const { state: s, nowMs } = i;
  // 1. Human on the floor.
  if (s.lastHumanAt && nowMs - Date.parse(s.lastHumanAt) < i.humanFloorMs) {
    const lastHuman = [...s.turns].reverse().find((t) => t.isHuman);
    const humanAddressed = s.openMoves.some((m) => lastHuman && m.messageId === lastHuman.messageId);
    if (!humanAddressed) return { kind: "silence", reason: "human_floor" };
  }
  // 3 (checked before 2 so a budget fade cannot be dodged by a summons).
  if (s.botTurns >= i.turnBudget) return { kind: "silence", reason: "budget" };
  // 2. Open move.
  for (const m of [...s.openMoves].sort((a, b) => (a.saidAt < b.saidAt ? -1 : 1))) {
    const spokeSince = s.turns.some((t) => t.companionId === m.to && t.saidAt > m.saidAt);
    if (!spokeSince) return { kind: "invite", companionId: m.to, reason: "addressed", offer: [], addressedBy: m.from };
  }
  // 4. Two-in-a-row exclusion.
  const botTurns = s.turns.filter((t) => !t.isHuman);
  const lastTwo = botTurns.slice(-2);
  const excluded = new Set<string>();
  if (lastTwo.length === 2 && lastTwo[0]!.companionId && lastTwo[0]!.companionId === lastTwo[1]!.companionId) excluded.add(lastTwo[1]!.companionId);
  // 5. Relevant supply owned by an eligible companion, not already offered in this thread.
  const offeredIds = new Set(s.offered.map((o) => o.id));
  const candidates = i.supply
    .filter((it) => isCompanion(it.owner) && !excluded.has(it.owner) && !offeredIds.has(it.id) && !it.consumed_by.includes(it.owner))
    .map((it) => ({ it, r: relevance(it, s) }))
    .filter((x) => x.r >= 0.15)
    .sort((a, b) => b.r - a.r);
  if (candidates.length > 0) {
    const top = rankOffer(candidates.filter((c) => c.r === candidates[0]!.r).map((c) => c.it), i.order)[0]!;
    return { kind: "invite", companionId: top.owner as CompanionId, reason: "supply_relevant", offer: [top] };
  }
  // 6. No uptake.
  const distinct = new Set(botTurns.map((t) => t.companionId ?? t.author));
  if (s.turns.length >= 1 && distinct.size < 2 && s.lastBotAt && nowMs - Date.parse(s.lastBotAt) >= i.noUptakeMs) {
    return { kind: "silence", reason: "no_uptake" };
  }
  return { kind: "silence", reason: "nothing_to_add" };
}
