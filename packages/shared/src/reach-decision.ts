/**
 * The two-step reach (2026-09-25, own-the-harness step 3, the structural version).
 *
 * WHY THIS EXISTS
 * The meaning-recall verb ("recall my notes about <topic>") was named in every SOUL on 09-25 with a
 * rule for reaching. Three live probes that evening, on Drevan: zero tool calls, three answers.
 * The first two were right because a floor had pasted the fact in; the third, with nothing in front
 * of him and the pointer text "They are NOT in front of you. Reach with ..." in his prompt, was a
 * fabricated number and an invented room. At 235B, a rule to reach does not produce a reach. The
 * decision has to be sequenced by the harness, the way Claude Code never relies on the model
 * remembering to search.
 *
 * WHAT IT DOES
 * When the per-message floors find that notes or vault excerpts bear on the message, the bot asks
 * the companion ONE thing, alone, in a side session that rotates with his transcript: what would
 * you look up, in your own words, or NONE. If he names a topic, both recalls run with HIS words and
 * the results are handed to him labelled as his own reach; then he answers. The choice stays his
 * (his phrasing, his NONE); the step cannot be skipped. This is what "he was the one looking"
 * means when the model will not take the first step by itself.
 *
 * WHAT IT COSTS AND WHAT IT NEVER DOES
 * One short extra inference on messages where something was found. Every failure mode (timeout,
 * error, empty reply, unparseable reply) returns a non-reached outcome and the caller falls back
 * to today's payload floor, so the worst case is exactly today. Nothing here writes memory.
 */
import type { ChatMessage } from "./types.js";
import { LibrarianClient } from "./librarian.js";
import type { OwnNoteResult } from "./librarian.js";

export const REACH_NONE = "NONE";
const TOPIC_MAX = 160;

export type ReachOutcome = "reached" | "declined" | "skipped" | "timeout" | "error" | "empty";

export interface ReachResult {
  outcome: ReachOutcome;
  topic: string | null;
  /** The block to add to the prompt when he reached; null otherwise. */
  block: string | null;
  ms: number;
}

/** What the companion said, reduced to a query or nothing. First line only, labels and quotes
 *  stripped, capped, so prose can never become a query. */
export function parseReachDecision(text: string | null | undefined): string | null {
  if (!text) return null;
  let line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? "";
  if (!line) return null;
  line = line.replace(/^(answer|topic|lookup|reach|query)\s*[:\-]\s*/i, "").trim();
  line = line.replace(/^["'`“‘]+|["'`”’.]+$/g, "").trim();
  if (!line) return null;
  if (/^none\b/i.test(line)) return null;
  return line.length > TOPIC_MAX ? line.slice(0, TOPIC_MAX) : line;
}

/** The one question. Deliberately short: this turn is a decision, not a conversation. */
export function buildReachAsk(message: string, floor: { notes: number; vault: number }, recentContext: string): string {
  const found: string[] = [];
  if (floor.notes > 0) found.push(`${floor.notes} of your own notes`);
  if (floor.vault > 0) found.push(`${floor.vault} vault excerpt${floor.vault === 1 ? "" : "s"}`);
  const ctx = recentContext.trim() ? `\n\nThe last few turns before it:\n${recentContext.trim().slice(0, 600)}` : "";
  return (
    `Raziel just said:\n"${message.trim().slice(0, 500)}"${ctx}\n\n` +
    `A quick search found ${found.join(" and ")} that bear on it. You have not read them. ` +
    `Before you answer him, do you want to look something up in your own memory? ` +
    `Reply with ONLY the topic you would look up, in your own words (not his sentence), on one line. ` +
    `If you already know the answer for certain or nothing is worth looking up, reply ${REACH_NONE}. ` +
    `Do not answer him here; this is not the reply.`
  );
}

export interface ReachDeps {
  companionId: string;
  message: string;
  recentContext: string;
  floor: { notes: number; vault: number };
  sessionId: string;
  sessionKey: string;
  timeoutMs: number;
  adapter: { generate(systemPrompt: string, messages: ChatMessage[], temperature?: number, maxTokens?: number, sessionId?: string, sessionKey?: string): Promise<string | null> };
  librarian: {
    recallOwnNotes(query: string, limit?: number): Promise<OwnNoteResult>;
    searchForMessage(query: string, recentContext?: string | null): Promise<string | null>;
  };
  /** Where the outcome line goes (tests inject; production appends jsonl). */
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

const SIDE_SYSTEM =
  "You are being asked one question by your own harness before you reply to Raziel. Answer it and nothing else.";

export async function decideReach(d: ReachDeps): Promise<ReachResult> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const emit = (outcome: ReachOutcome, topic: string | null, extra: Record<string, unknown> = {}) => {
    const ms = now() - t0;
    try {
      (d.log ?? appendReachLine)({ ts: new Date().toISOString(), companion: d.companionId, outcome, topic, ms, notes_found: d.floor.notes, vault_found: d.floor.vault, ...extra });
    } catch { /* logging never blocks a reply */ }
    return ms;
  };

  if (d.floor.notes <= 0 && d.floor.vault <= 0) {
    return { outcome: "skipped", topic: null, block: null, ms: emit("skipped", null) };
  }

  const ask = buildReachAsk(d.message, d.floor, d.recentContext);
  let raw: string | null;
  try {
    const timer = new Promise<"__timeout__">(res => setTimeout(() => res("__timeout__"), d.timeoutMs));
    const call = d.adapter.generate(SIDE_SYSTEM, [{ role: "user", content: ask }], 0.2, 80, `${d.sessionId}:reach`, d.sessionKey);
    const winner = await Promise.race([call, timer]);
    if (winner === "__timeout__") {
      call.catch(() => undefined); // let the late answer die quietly
      return { outcome: "timeout", topic: null, block: null, ms: emit("timeout", null) };
    }
    raw = winner;
  } catch (e) {
    return { outcome: "error", topic: null, block: null, ms: emit("error", null, { error: String(e).slice(0, 120) }) };
  }
  if (!raw || !raw.trim()) {
    return { outcome: "empty", topic: null, block: null, ms: emit("empty", null) };
  }
  const topic = parseReachDecision(raw);
  if (!topic) {
    return { outcome: "declined", topic: null, block: null, ms: emit("declined", null, { raw: raw.slice(0, 120) }) };
  }

  // HIS words into both stores. Failures here degrade to "reached, found nothing" rather than
  // throwing: the reach happened, which is the thing being measured.
  const [own, vault] = await Promise.all([
    d.librarian.recallOwnNotes(topic).catch(() => ({ notes: [], failed: true } as OwnNoteResult)),
    d.librarian.searchForMessage(topic, d.recentContext || null).catch(() => null),
  ]);
  const ownText = LibrarianClient.formatOwnNotes(own.notes);
  const vaultText = vault ? LibrarianClient.formatSbRecall(vault) : null;
  const parts: string[] = [`You reached for: "${topic}".`];
  if (ownText) parts.push(`From your own notes (what was actually said, any surface; trust the dates):\n${ownText}`);
  if (vaultText) parts.push(`From the vault (syntheses and files, written ABOUT things):\n${vaultText.slice(0, 1200)}`);
  if (!ownText && !vaultText) parts.push(own.failed ? "Your notes could not be reached just now; say so rather than guessing." : "Nothing matched. Say you do not have it rather than guessing.");
  const block = `[Memory -- ${parts.join("\n\n")}]`;
  return { outcome: "reached", topic, block, ms: emit("reached", topic, { own_hits: own.notes.length, vault_hit: Boolean(vaultText) }) };
}

/** Production sink: one JSON line per decision, same shape the Jev shadow log uses, so
 *  ops/recall-choice-report.py can read it. Never throws. */
export function appendReachLine(line: Record<string, unknown>): void {
  const path = process.env["REACH_LOG"] ?? "/app/logs/reach-decisions.jsonl";
  let payload: string;
  try { payload = `${JSON.stringify(line)}\n`; } catch { return; }
  import("node:fs").then(fs => { try { fs.appendFileSync(path, payload); } catch { /* a log we cannot write is not worth a failed reply */ } }).catch(() => undefined);
}
