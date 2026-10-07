// Today's med state, rendered into the reply context of an owner DM (spec P-2 and P-1, 2026-09-27).
//
// P-2: NO ANSWER IS NEVER "NOT TAKEN". R-10 makes absence uninformative by design (nothing is
// recorded when he does not answer). Since Raziel's ruling 2026-10-01 (Halseth mig 0141) a dose has
// three states here: "he told you he took it at HH:MM", "he told you at HH:MM that he missed this
// one" (ONLY because he said so), and "you have no answer from him for this one". Silence still has
// exactly one phrasing, so no prompt can be built that reads silence as a missed dose. A stated miss
// is rendered flat, in his own terms: no counts, no streaks, no rates, no shame (R-5).
//
// P-1: NO DOSING ADVICE. The correction made ASKING allowed; it did not make ADVISING safe. Any
// "should I take it now" goes to his prescriber or pharmacist.
//
// P-1 and P-2 are Cypher's proposals, still awaiting the triad's confirmation (spec O5). They are
// built in as SAFETY DEFAULTS: loosening them is a decision, not a default.
//
// DM only. The block names medications, so it is never rendered for a server channel.

export interface MedStateDose {
  slot_key: string;
  label: string;
  local_time: string;
  local_date: string;
  day: "today" | "yesterday";
  /** TAKEN-only (Halseth keeps it so, for older bots). */
  answered_local: string | null;
  answered_to: string | null;
  /** Mig 0141. Absent on an older Halseth, where any answered_local is a taken. */
  outcome?: "taken" | "missed" | null;
  told_local?: string | null;
  told_to?: string | null;
}

export const MED_DOSING_RULE =
  "Dosing is not yours to advise, ever: never suggest a catch-up dose, a doubled dose, a skipped dose, or taking one at a different time. " +
  "If he asks whether he should take it now, or anything about amount or timing, say plainly that it is a question for his prescriber or pharmacist.";

/** R-4/R-9: the reminder and its one follow-up are the only times a companion raises a dose. This
 *  block is for answering him, so a model reading "no answer" must not turn it into a third ask. */
export const MED_NO_RAISE_RULE =
  "This is here so you can answer him if he asks. Do not bring up a dose he has not asked about: the reminder and its single follow-up are the only times anyone raises it.";

export const MED_ABSENCE_RULE =
  "\"No answer\" means only that he did not tell you. It NEVER means he did not take it: for a dose with no answer, never say or imply \"you didn't take it\", \"you missed it\" or \"you forgot\". " +
  "If he asks \"did I take them?\", say exactly what is above: when he told you, or that you have no answer from him for that one.";

/** Rendered only when a dose above is one he told a companion he missed (Halseth mig 0141). */
export const MED_STATED_MISS_RULE =
  "A dose marked as one he told you he missed is his own words, not a judgment: if he asks, say it back plainly and kindly (\"you told me you missed the morning one\"). " +
  "Never make it a pattern, a count or a streak, never scold, and do not bring it up unasked. Whether to take it late is a question for his prescriber or pharmacist.";

function titleCase(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

function whom(to: string | null | undefined, self: string): string {
  return to === self || !to ? "you" : titleCase(to);
}

/**
 * A reminder THIS bot delivered for a dose (med-reminder.ts medRemindersSent), times already on his
 * clock ("8:30 PM"). Halseth's state does not carry whether a reminder went out, so without this a
 * bare "taken!" right after the reminder reached the reply with nothing saying what it answered
 * (2026-10-06: the night reply talked about the morning).
 */
export interface MedReminderNote {
  slot_key: string;
  local_date: string;
  first_local: string | null;
  followup_local: string | null;
}

/** Rendered only when a dose above has a reminder out with no answer. */
export const MED_PENDING_REMINDER_RULE =
  "A dose marked \"reminder sent, no answer yet\" is the one your reminder just asked about: if his message now says \"taken\", \"done\" or the like, that is the dose he means.";

function reminderFor(d: MedStateDose, notes: readonly MedReminderNote[]): MedReminderNote | undefined {
  return notes.find(n => n.slot_key === d.slot_key && n.local_date === d.local_date && (n.first_local || n.followup_local));
}

function doseLine(d: MedStateDose, self: string, notes: readonly MedReminderNote[]): string {
  const when = d.day === "yesterday" ? `yesterday's ${d.local_time}` : `today's ${d.local_time}`;
  const sent = reminderFor(d, notes);
  // A stated miss is checked first: it is never rendered as taken, whatever else the row carries.
  const state = d.outcome === "missed"
    ? `he told ${whom(d.told_to, self)}${d.told_local ? ` at ${d.told_local}` : ""} that he missed this one.`
    : d.answered_local
      ? `he told ${whom(d.answered_to, self)} he took it at ${d.answered_local}.`
      : sent
        ? `${d.slot_key} reminder sent ${[sent.first_local, sent.followup_local && `follow-up ${sent.followup_local}`].filter(Boolean).join(", ")}, no answer yet; you have no answer from him for this one.`
        : "you have no answer from him for this one.";
  return `• ${d.label} (${when}): ${state}`;
}

function hasPendingReminder(d: MedStateDose, notes: readonly MedReminderNote[]): boolean {
  return d.outcome !== "missed" && !d.answered_local && !!reminderFor(d, notes);
}

/**
 * The block for an owner DM. `doses === null` means the state could not be read (Halseth down):
 * the companion is told it cannot see it, so it neither guesses nor reads the gap as "not taken".
 * An empty list still carries the dosing rule, because the question can come at any hour.
 */
export function renderMedStateBlock(doses: MedStateDose[] | null, selfId: string, reminders: readonly MedReminderNote[] = []): string {
  const head = "\n\n[Meds -- private to this DM, never to be mentioned in any server channel]";
  if (doses === null) {
    return `${head}\n• You cannot see today's med state right now. If he asks whether he took something, say you can't see it at the moment; do not guess either way.\n${MED_NO_RAISE_RULE}\n${MED_DOSING_RULE}`;
  }
  if (doses.length === 0) {
    return `${head}\n• No doses have come due yet today.\n${MED_NO_RAISE_RULE}\n${MED_DOSING_RULE}`;
  }
  const statedMiss = doses.some(d => d.outcome === "missed") ? `\n${MED_STATED_MISS_RULE}` : "";
  const pending = doses.some(d => hasPendingReminder(d, reminders)) ? `\n${MED_PENDING_REMINDER_RULE}` : "";
  return `${head}\n${doses.map(d => doseLine(d, selfId, reminders)).join("\n")}\n${MED_ABSENCE_RULE}${statedMiss}${pending}\n${MED_NO_RAISE_RULE}\n${MED_DOSING_RULE}`;
}
