// director/ingest.ts -- Discord -> ConversationState. Three bots publish every message; dedupe here.
import { extractAddress, type CommonsMessagePayload } from "@nullsafe/shared";
import { applyTurn, type StateStore } from "./state.js";
import { emptyState, type ConversationState, type LedgerTurn, type CompanionId } from "./types.js";
import type { Ledger } from "./ledger.js";

const ALL: readonly CompanionId[] = ["cypher", "drevan", "gaia"];
const GIST_MAX = 140;

export function toTurn(p: CommonsMessagePayload): LedgerTurn {
  const isHuman = p.authorKind !== "companion";
  return {
    // Non-companion authors are labeled "raziel" for the ledger.
    // Blue/guest attribution in the commons is out of scope; the existing owner path handles their replies.
    author: isHuman ? "raziel" : (p.companionId ?? "unknown"),
    companionId: isHuman ? undefined : p.companionId,
    gist: p.content.replace(/\s+/g, " ").trim().slice(0, GIST_MAX),
    messageId: p.messageId, saidAt: p.createdAt, isHuman,
  };
}

export function addressedIn(p: CommonsMessagePayload): CompanionId[] {
  const a = extractAddress(p.content);
  const self = p.companionId;
  if (a.type === "named") return a.id === self ? [] : [a.id];
  if (a.type === "named_multi") return a.ids.filter((id) => id !== self);
  if (a.type === "group") return ALL.filter((id) => id !== self);
  return [];
}

export async function ingest(p: CommonsMessagePayload, deps: { store: StateStore; ledger: Ledger; now: () => string }): Promise<ConversationState | null> {
  if (!(await deps.store.seenMessage(p.messageId))) return null;
  let s = (await deps.store.load(p.channelId)) ?? emptyState(p.channelId, deps.now());
  const turn = toTurn(p);
  if (!s.threadId) s = { ...s, threadId: await deps.ledger.ensureThread(s, turn) };
  if (s.threadId) await deps.ledger.appendTurn(s.threadId, turn);
  s = applyTurn(s, turn, addressedIn(p));
  await deps.store.save(s);
  return s;
}
