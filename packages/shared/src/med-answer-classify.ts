// The med-answer CLASSIFIER fallback (2026-10-06).
//
// parseMedAnswer (med-answer.ts) is a whitelist: it refuses whatever it cannot prove, and his real
// answers keep landing outside it ("Yay!! I'm on top of it today Dre you don't even have to ask
// again taken!" recorded nothing at 20:32 and the 21:00 follow-up fired anyway). Growing the regex
// one dated patch at a time has not closed that, so when the parser says nothing AND a reminder this
// bot sent is still unanswered, ONE short model call reads the message: taken / missed / unclear.
//
// STILL CONSERVATIVE. Only "taken" and "missed" record; "unclear", a timeout, an error, an empty or
// unparseable reply, or a slot that is not one of the open ones all record NOTHING. "missed" needs
// him to SAY a dose was not taken (a deferral or a correction is unclear). With several reminders
// open, the model must name the slot; a bare "taken" with two open is unclear. Halseth still decides
// whether the dose is open and was reminded by this companion, exactly as for a parsed answer.
//
// PRIVACY. The model sees his message and the open slots (slot key + time); never the dose label.
// Nothing here logs; the caller logs slot keys and outcomes only, never his words.

import { withTimeout } from "./owner-dm.js";

export type MedClassifierOutcome = "taken" | "missed" | "unclear";

export interface MedOpenSlot {
  slot_key: string;
  /** Scheduled local time ("20:30"). */
  local_time: string;
  /** When the reminder went out on his clock ("8:30 PM"), if known. */
  sent_local?: string | null;
}

export interface MedClassifierResult {
  outcome: MedClassifierOutcome;
  /** The open slot it answers (taken/missed only), else null. */
  slot: string | null;
  /** Why it is unclear when the model did not say so itself: "timeout", "error", "unparseable", "no_slot". */
  reason?: string;
}

export const MED_CLASSIFIER_TIMEOUT_MS = 8_000;

export const MED_CLASSIFIER_SYSTEM =
  "You read one direct message Raziel sent his companion right after a medication reminder, and decide whether it answers the reminder. " +
  "Reply with exactly one line and nothing else: `taken <slot>`, `missed <slot>`, or `unclear`. " +
  "taken: he says he has taken that dose (\"taken!\", \"done\", \"already did\", \"on top of it, took them\"). " +
  "missed: he plainly says he did NOT take it and will not (\"I forgot it\", \"skipped it tonight\"). " +
  "unclear: anything else, including a plan or deferral (\"later\", \"about to\", \"not yet\"), a question, a correction about the time, a joke, or talk about something else. " +
  "When unsure, answer unclear: a wrong record is worse than none.";

export function buildMedClassifierPrompt(message: string, open: readonly MedOpenSlot[], nowLocal: string): string {
  const slots = open.map(o => `- ${o.slot_key} (scheduled ${o.local_time}${o.sent_local ? `, reminder sent ${o.sent_local}` : ""})`);
  return [
    `It is now ${nowLocal}. Open reminders, none answered yet:`,
    ...slots,
    open.length > 1 ? "Several are open: name the slot he means; if he does not make it clear which, answer unclear." : `Only one is open: its slot is ${open[0]?.slot_key}.`,
    "",
    "His message:",
    `"""${message.slice(0, 1200)}"""`,
  ].join("\n");
}

/** Strict reading of the model's one line. Anything else is unclear. */
export function parseMedClassifierReply(reply: string | null | undefined, open: readonly MedOpenSlot[]): MedClassifierResult {
  const line = (reply ?? "").trim().split("\n")[0]!.trim().replace(/^[`"'*]+|[`"'*.]+$/g, "").toLowerCase();
  if (!line) return { outcome: "unclear", slot: null, reason: "unparseable" };
  if (line === "unclear") return { outcome: "unclear", slot: null };
  const m = /^(taken|missed)(?:\s+([a-z0-9_-]+))?$/.exec(line);
  if (!m) return { outcome: "unclear", slot: null, reason: "unparseable" };
  const outcome = m[1] as "taken" | "missed";
  const named = m[2];
  const keys = open.map(o => o.slot_key.toLowerCase());
  if (named) {
    const i = keys.indexOf(named);
    return i === -1 ? { outcome: "unclear", slot: null, reason: "no_slot" } : { outcome, slot: open[i]!.slot_key };
  }
  // No slot named: only certain when exactly one is open.
  return open.length === 1 ? { outcome, slot: open[0]!.slot_key } : { outcome: "unclear", slot: null, reason: "no_slot" };
}

export interface MedClassifierDeps {
  /** One completion: (system, user, signal) -> text. The caller wires the direct lane, never Hermes. */
  generate(system: string, user: string, signal: AbortSignal): Promise<string | null | undefined>;
  timeoutMs?: number;
}

/** The doses a classifier may answer: no answer recorded (taken or missed) AND a reminder this bot
 *  delivered for that slot and date is still within its window. Empty = do not call the model. */
export function openRemindedSlots(
  doses: ReadonlyArray<{ slot_key: string; local_date: string; local_time: string; answered_local: string | null; outcome?: "taken" | "missed" | null }> | null,
  sent: ReadonlyArray<{ slot_key: string; local_date: string; firstAt: number | null; followupAt: number | null }>,
  fmtLocal: (ms: number) => string,
): MedOpenSlot[] {
  if (!doses) return [];
  const out: MedOpenSlot[] = [];
  for (const d of doses) {
    if (d.answered_local || (d.outcome !== null && d.outcome !== undefined)) continue;
    const s = sent.find(r => r.slot_key === d.slot_key && r.local_date === d.local_date);
    if (!s) continue;
    const last = Math.max(s.firstAt ?? 0, s.followupAt ?? 0);
    if (!out.some(o => o.slot_key === d.slot_key)) out.push({ slot_key: d.slot_key, local_time: d.local_time, sent_local: last ? fmtLocal(last) : null });
  }
  return out;
}

export interface MedClassifierRunDeps extends MedClassifierDeps {
  companionId: string;
  /** librarian.medAnswers: the same recording route a parsed answer takes. */
  record(answeredAtIso: string, entries: Array<{ slot: string | null; outcome: "taken" | "missed" }>): Promise<Array<{ slot_key: string; local_date: string; outcome: "taken" | "missed" }> | null>;
  log?(line: string): void;
}

/**
 * The fire-and-forget path the reply handler starts when the parser found nothing and a reminder is
 * outstanding. Never throws; records only on taken/missed. Logs slot keys and outcomes, never his
 * words or the dose label.
 */
export async function runMedAnswerClassifier(
  deps: MedClassifierRunDeps,
  message: string,
  open: readonly MedOpenSlot[],
  nowLocal: string,
  answeredAtIso: string,
): Promise<MedClassifierResult & { recorded: number }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const tag = `[${deps.companionId}] [med]`;
  try {
    const r = await classifyMedAnswer(deps, message, open, nowLocal);
    const label = `classifier:${r.outcome}${r.reason ? `:${r.reason}` : ""}`;
    if (r.outcome === "unclear" || !r.slot) {
      log(`${tag} answer in DM (${label}) -> nothing recorded (open=${open.map(o => o.slot_key).join(",")})`);
      return { ...r, recorded: 0 };
    }
    const recs = await deps.record(answeredAtIso, [{ slot: r.slot, outcome: r.outcome }]);
    log(`${tag} answer in DM (${label}) -> ${recs === null ? "error (nothing recorded)" : recs.length ? `recorded ${recs.map(x => `slot=${x.slot_key} date=${x.local_date} outcome=${x.outcome}`).join("; ")}` : "no open dose (nothing recorded)"}`);
    return { ...r, recorded: recs?.length ?? 0 };
  } catch (e) {
    log(`${tag} answer in DM (classifier:error) -> nothing recorded (${e instanceof Error ? e.name : "error"})`);
    return { outcome: "unclear", slot: null, reason: "error", recorded: 0 };
  }
}

/** One model call; never throws. */
export async function classifyMedAnswer(
  deps: MedClassifierDeps,
  message: string,
  open: readonly MedOpenSlot[],
  nowLocal: string,
): Promise<MedClassifierResult> {
  if (!open.length || !message.trim()) return { outcome: "unclear", slot: null, reason: "no_slot" };
  const timeoutMs = deps.timeoutMs ?? MED_CLASSIFIER_TIMEOUT_MS;
  const ac = new AbortController();
  try {
    const reply = await withTimeout(Promise.resolve(deps.generate(MED_CLASSIFIER_SYSTEM, buildMedClassifierPrompt(message, open, nowLocal), ac.signal)), timeoutMs);
    return parseMedClassifierReply(reply, open);
  } catch (e) {
    ac.abort();
    return { outcome: "unclear", slot: null, reason: e instanceof Error && e.message === "timeout" ? "timeout" : "error" };
  }
}
