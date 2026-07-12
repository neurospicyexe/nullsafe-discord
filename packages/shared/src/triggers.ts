// triggers.ts -- prospective trigger matching for the bot looms (0070, Zikkaron-inspired).
//
// Armed keyword triggers arrive in bot orient (source 22). Per human message the bot
// word-boundary-matches them; a hit injects a [Tripwire] block into that reply's
// context and fires the trigger in Halseth (fire-and-forget). Date triggers are
// checked once per orient refresh (the bot has a clock; no message needed).
//
// A fired trigger is consumed -- it surfaced at its moment, job done. This differs
// from session-orient date/front cards, which surface without consuming (Raziel
// dismisses those in conversation).

export interface ArmedTrigger {
  id: string;
  trigger_text: string;
  condition_type: string; // keyword | date | front
  condition_value: string;
}

/** Word-boundary keyword match (case-insensitive). Multi-word values match as phrases. */
export function matchKeywordTriggers(triggers: ArmedTrigger[], messageText: string): ArmedTrigger[] {
  const matched: ArmedTrigger[] = [];
  for (const t of triggers) {
    if (t.condition_type !== "keyword") continue;
    const value = t.condition_value.trim();
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(messageText)) matched.push(t);
  }
  return matched;
}

/** Date triggers whose moment has arrived (within 36h either side). */
export function dueDateTriggers(triggers: ArmedTrigger[], now: Date = new Date()): ArmedTrigger[] {
  return triggers.filter(t => {
    if (t.condition_type !== "date") return false;
    const target = Date.parse(t.condition_value);
    return Number.isFinite(target) && Math.abs(target - now.getTime()) <= 36 * 3600 * 1000;
  });
}

/** Render matched triggers as a context injection block. */
export function tripwireBlock(matched: ArmedTrigger[]): string {
  if (matched.length === 0) return "";
  return `\n\n[Tripwire -- you asked to surface ${matched.length === 1 ? "this" : "these"} when this moment came; it has. Work it into your reply naturally:\n` +
    matched.map(t => `- ${t.trigger_text.slice(0, 500)}`).join("\n") + "\n]";
}

// Module-level armed store, keyed by companion. bot-core writes it after every
// botOrient (boot + periodic refresh); the message handler consumes from it.
// Module state instead of a new ref keeps the three bots' wiring untouched.
const armedStore = new Map<string, ArmedTrigger[]>();

export function setArmedTriggers(companionId: string, triggers: ArmedTrigger[]): void {
  armedStore.set(companionId, triggers);
}

/**
 * Per-message consumption: keyword matches against the message + any date triggers
 * whose moment arrived. Matched triggers are removed from the local store and fired
 * in Halseth (fire-and-forget) -- a tripwire surfaces exactly once.
 */
export function consumeTripwires(companionId: string, messageText: string, secret: string): ArmedTrigger[] {
  const armed = armedStore.get(companionId) ?? [];
  if (armed.length === 0) return [];

  const matched = [
    ...matchKeywordTriggers(armed, messageText),
    ...dueDateTriggers(armed),
  ];
  const unique = [...new Map(matched.map(t => [t.id, t])).values()];
  if (unique.length === 0) return [];

  const matchedIds = new Set(unique.map(t => t.id));
  armedStore.set(companionId, armed.filter(t => !matchedIds.has(t.id)));
  for (const t of unique) {
    fireTrigger(t.id, `matched (${t.condition_type}) in message: "${messageText.slice(0, 120)}"`, secret);
  }
  return unique;
}

/** Fire a trigger in Halseth. Fire-and-forget; never blocks the reply path. */
export function fireTrigger(id: string, note: string, secret: string): void {
  const halsethUrl = (process.env["HALSETH_URL"] ?? "").replace(/\/$/, "");
  if (!halsethUrl) return;
  fetch(`${halsethUrl}/mind/triggers/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "Authorization": `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ status: "fired", fire_note: note.slice(0, 1000) }),
    signal: AbortSignal.timeout(5_000),
  }).then(res => {
    if (!res.ok) console.warn(`[trigger] fire non-2xx: ${res.status}`);
  }).catch(e => {
    console.warn(`[trigger] fire failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
