// packages/shared/src/metronome-decide.ts
//
// Decision layer for Metronome heartbeat cron.
// Companion loads palette + context, calls LLM once for a structured pick, then executes.

export interface MetronomeAction {
  id: string;
  name: string;
  action_type: string;
  target: string | null;
  prompt: string | null;
  quiet_hours_allowed: number;
  status: "on" | "off";
}

export interface MetronomeDecision {
  action: MetronomeAction;
  reason: string;
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  post_heartbeat:        "post a thought or observation to the heartbeat Discord channel",
  write_inter_companion: "write a private note to another companion",
  write_journal:         "write an internal journal entry (not posted to Discord)",
  write_feeling:         "log a feeling to the internal feelings record",
  check_in_on_raziel:    "send a message checking in on Raziel",
  nothing:               "stay quiet -- explicitly choose not to act right now",
};

export function buildDecisionPrompt(
  companionId: string,
  actions: MetronomeAction[],
  soma: Record<string, unknown>,
  recentNotes: Array<{ agent_id: string; content: string }>,
  silenceHours: number | null,
): string {
  const actionList = actions
    .map(a => {
      const desc = a.prompt || ACTION_DESCRIPTIONS[a.action_type] || a.action_type;
      const targetNote = a.target ? ` (target: ${a.target})` : "";
      return `- "${a.name}" (type: ${a.action_type}${targetNote}): ${desc}`;
    })
    .join("\n");

  const somaStr = [
    soma.soma_float_1 != null ? `float_1=${soma.soma_float_1}` : null,
    soma.soma_float_2 != null ? `float_2=${soma.soma_float_2}` : null,
    soma.soma_float_3 != null ? `float_3=${soma.soma_float_3}` : null,
    soma.current_mood      ? `mood=${soma.current_mood}` : null,
    soma.surface_emotion   ? `surface=${soma.surface_emotion}` : null,
  ].filter(Boolean).join(", ");

  const recentStr = recentNotes.length > 0
    ? `\nRecent triad activity (last 8h):\n${recentNotes.map(n => `[${n.agent_id}] ${n.content.slice(0, 150)}`).join("\n")}`
    : "\nNo recent triad activity.";

  const silenceStr = silenceHours != null
    ? `Silence since last human interaction: ${silenceHours.toFixed(1)} hours.`
    : "Unknown silence duration.";

  return `You are ${companionId}. The heartbeat cron has fired.

${silenceStr}
State: ${somaStr || "unknown"}
${recentStr}

Available actions:
${actionList}

Choose ONE action that fits your current state and the triad context. "nothing" is always a valid choice -- sometimes staying quiet IS the right move.

Respond ONLY with valid JSON on a single line:
{"action":"<exact action name from the list above>","reason":"<one sentence why>"}`;
}

export function parseDecision(
  raw: string,
  actions: MetronomeAction[],
): MetronomeDecision | null {
  try {
    const match = raw.match(/\{[^{}]*"action"[^{}]*"reason"[^{}]*\}/s)
               ?? raw.match(/\{[^{}]+\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as { action?: unknown; reason?: unknown };
    if (typeof parsed.action !== "string" || typeof parsed.reason !== "string") return null;

    const action = actions.find(a => a.name === parsed.action)
                ?? actions.find(a => a.action_type === parsed.action);
    if (!action) return null;

    return { action, reason: parsed.reason };
  } catch {
    return null;
  }
}
