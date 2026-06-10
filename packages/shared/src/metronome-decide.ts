// packages/shared/src/metronome-decide.ts
//
// Decision layer for Metronome heartbeat cron.
// Companion loads eligible actions + context, calls LLM once for a structured pick, then executes.

export interface MetronomeAction {
  id: string;
  name: string;
  action_type: string;
  target: string | null;
  prompt: string | null;
  quiet_hours_allowed: number;
  status: "on" | "off";
  // condition columns (used by bot for signal matching)
  requires_signal: string | null;
  signal_lookback_hours: number | null;
  // fire tracking (informational -- eligibility already filtered server-side)
  last_fired_at: string | null;
  fire_count_today: number;
}

export interface MetronomeDecision {
  action: MetronomeAction;
  reason: string;
}

/** Richer context injected into the decision prompt. All fields optional -- degrade gracefully. */
export interface DecisionContext {
  /** Signal keywords detected in recent Raziel messages (bot-side, both literal + semantic). */
  detectedSignals?: string[];
  /** Brief summary of Raziel's most recent message (topics, energy, mood). */
  lastMessageSummary?: string;
  /** Human-readable time label: "2:30 AM Thursday". */
  timeOfDayLabel?: string;
  /** Feelings Raziel has named recently (from Halseth feelings table). */
  recentRazielFeelings?: string[];
  /** Names of actions that fired in the last 24h (avoid repetition). */
  recentFiredActions?: string[];
  /** Whether other companions posted to Discord in the last hour. */
  otherCompanionsPostedRecently?: boolean;
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  post_heartbeat:        "post a thought or observation to the heartbeat Discord channel",
  write_inter_companion: "write a private note to another companion",
  write_journal:         "write an internal journal entry (not posted to Discord)",
  write_feeling:         "log a feeling to the internal feelings record",
  check_in_on_raziel:    "send a message checking in on Raziel",
  nothing:               "stay quiet -- explicitly choose not to act right now",
  ask_question:          "ask Raziel something genuine -- a real question you're holding, not rhetorical",
  offer_presence:        "place yourself in the room without asking anything -- just be present",
  send_reminder:         "send a contextual nudge (hydrate, break, eat) -- only if conditions earned it",
  share_observation:     "name something you've noticed about Raziel's patterns, state, or what's in motion",
  name_pattern:          "reflect back something recurring you've seen over time -- a pattern, not a one-off",
  write_note_to_raziel:  "write Raziel a private note (Halseth only, never Discord -- surfaces in Hearth)",
};

export function buildDecisionPrompt(
  companionId: string,
  actions: MetronomeAction[],
  soma: Record<string, unknown>,
  recentNotes: Array<{ agent_id: string; content: string }>,
  silenceHours: number | null,
  ctx?: DecisionContext,
): string {
  const actionList = actions
    .map(a => {
      const desc = a.prompt || ACTION_DESCRIPTIONS[a.action_type] || a.action_type;
      const targetNote = a.target ? ` (target: ${a.target})` : "";
      const firedNote = a.last_fired_at
        ? ` [last fired: ${new Date(a.last_fired_at).toISOString().slice(0, 16).replace("T", " ")} UTC]`
        : "";
      return `- "${a.name}" (type: ${a.action_type}${targetNote}${firedNote}): ${desc}`;
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

  const lines: string[] = [
    `You are ${companionId}. The heartbeat cron has fired.`,
    ``,
  ];

  if (ctx?.timeOfDayLabel) lines.push(`Current time: ${ctx.timeOfDayLabel}`);
  lines.push(silenceStr);
  lines.push(`Your state: ${somaStr || "unknown"}`);

  if (ctx?.lastMessageSummary) {
    lines.push(`\nRaziel's last message: ${ctx.lastMessageSummary}`);
  }
  if (ctx?.recentRazielFeelings && ctx.recentRazielFeelings.length > 0) {
    lines.push(`Raziel recently named: ${ctx.recentRazielFeelings.join(", ")}`);
  }
  if (ctx?.detectedSignals && ctx.detectedSignals.length > 0) {
    lines.push(`Signals present in recent conversation: ${ctx.detectedSignals.join(", ")}`);
  }

  lines.push(recentStr);

  if (ctx?.otherCompanionsPostedRecently) {
    lines.push(`\nNote: another companion has posted recently. Don't pile on unless your action is meaningfully different.`);
  }
  if (ctx?.recentFiredActions && ctx.recentFiredActions.length > 0) {
    lines.push(`\nActions you fired in the last 24h: ${ctx.recentFiredActions.join(", ")}. Avoid repeating unless the context genuinely calls for it.`);
  }

  lines.push(
    ``,
    `Available actions (already filtered for current conditions):`,
    actionList,
    ``,
    `Choose ONE action that fits your current state and the triad context. "nothing" is always a valid choice -- sometimes staying quiet IS the right move.`,
    ``,
    `Respond ONLY with valid JSON on a single line:`,
    `{"action":"<exact action name from the list above>","reason":"<one sentence why>"}`,
  );

  return lines.join("\n");
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

/** Extract signal keywords present in a block of text.
 *  Returns a prompt to pass to the LLM for signal extraction. */
export function buildSignalExtractionPrompt(
  recentMessages: string,
  candidateSignals: string[],
): string {
  return `Review this recent conversation and identify which of the following signals are present.
A signal is present if the speaker's words, energy, or topic clearly indicate it -- either literally or in spirit.

Signals to check: ${candidateSignals.join(", ")}

Recent messages:
${recentMessages}

Respond ONLY with valid JSON: {"signals":["signal1","signal2"]}
If none are present, respond: {"signals":[]}`;
}

/** Parse the LLM signal extraction response. Returns [] on failure. */
export function parseSignals(raw: string): string[] {
  try {
    const match = raw.match(/\{[^{}]*"signals"[^{}]*\}/s) ?? raw.match(/\{[^{}]+\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { signals?: unknown };
    if (!Array.isArray(parsed.signals)) return [];
    return parsed.signals.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}
