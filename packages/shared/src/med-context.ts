// Today's med state, rendered into the reply context of an owner DM (spec P-2 and P-1, 2026-09-27).
//
// P-2: NO ANSWER IS NEVER "NOT TAKEN". R-10 makes absence uninformative by design (nothing is
// recorded when he does not answer), so the only two states a dose can have here are "he told you
// he took it at HH:MM" and "you have no answer from him for this one". The renderer has no third
// phrasing, so no prompt can be built that reads silence as a missed dose.
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
  answered_local: string | null;
  answered_to: string | null;
}

export const MED_DOSING_RULE =
  "Dosing is not yours to advise, ever: never suggest a catch-up dose, a doubled dose, a skipped dose, or taking one at a different time. " +
  "If he asks whether he should take it now, or anything about amount or timing, say plainly that it is a question for his prescriber or pharmacist.";

export const MED_ABSENCE_RULE =
  "\"No answer\" means only that he did not tell you. It NEVER means he did not take it: never say or imply \"you didn't take it\", \"you missed it\" or \"you forgot\". " +
  "If he asks \"did I take them?\", say exactly what is above: when he told you, or that you have no answer from him for that one.";

function titleCase(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

function doseLine(d: MedStateDose, self: string): string {
  const when = d.day === "yesterday" ? `yesterday's ${d.local_time}` : `today's ${d.local_time}`;
  const state = d.answered_local
    ? `he told ${d.answered_to === self || !d.answered_to ? "you" : titleCase(d.answered_to)} he took it at ${d.answered_local}.`
    : "you have no answer from him for this one.";
  return `• ${d.label} (${when}): ${state}`;
}

/**
 * The block for an owner DM. `doses === null` means the state could not be read (Halseth down):
 * the companion is told it cannot see it, so it neither guesses nor reads the gap as "not taken".
 * An empty list still carries the dosing rule, because the question can come at any hour.
 */
export function renderMedStateBlock(doses: MedStateDose[] | null, selfId: string): string {
  const head = "\n\n[Meds -- private to this DM, never to be mentioned in any server channel]";
  if (doses === null) {
    return `${head}\n• You cannot see today's med state right now. If he asks whether he took something, say you can't see it at the moment; do not guess either way.\n${MED_DOSING_RULE}`;
  }
  if (doses.length === 0) {
    return `${head}\n• No doses have come due yet today.\n${MED_DOSING_RULE}`;
  }
  return `${head}\n${doses.map(d => doseLine(d, selfId)).join("\n")}\n${MED_ABSENCE_RULE}\n${MED_DOSING_RULE}`;
}
