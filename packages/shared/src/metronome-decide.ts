// packages/shared/src/metronome-decide.ts
//
// Decision layer for Metronome heartbeat cron.
// Companion loads eligible actions + context, calls LLM once for a structured pick, then executes.

import { extractJson } from "./json-extract.js";

// Ceiling for the heartbeat decision call. The decision JSON itself is tiny, but the
// default cap (1024, previously 500 in the deployed dist) truncated it in prod when the
// hermes-mode agent narrated before/around the object ("decision parse failed" with
// valid-looking-but-cut JSON, gaia 2026-06-30/07-01). A ceiling never forces length.
export const HEARTBEAT_DECISION_MAX_TOKENS = 2048;

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
  /** Relational-need drive (take 9) has crossed threshold -- the reach-out is state-driven, not merely scheduled. */
  relationalNeedFired?: boolean;
  /** Effective relational-need level [0..1] when fired (for the prompt nudge). */
  relationalNeedLevel?: number;
  /** Compact summary of Raziel's recent logged subjective state (migration 0081), or undefined
   *  when there is no fresh data. Real "recent data to justify a reach-out" -- shapes whether and how. */
  razielStateSummary?: string;
}

/** Raw subjective-state snapshot from Halseth GET /biometrics/latest (migration 0081 fields). */
export interface RazielStateInput {
  recorded_at?: string | null;
  mood?: string | null;
  energy?: number | null;     // 0-10
  focus?: number | null;      // 0-10
  pain?: number | null;       // 0-10
  spoons?: number | null;     // 0-12
  sleep_hours?: number | null;
}

/**
 * Compact, prompt-ready summary of Raziel's recent subjective state. Returns null when there is
 * NO fresh data to justify a reach-out: missing snapshot, a stale one (older than maxAgeHours),
 * or one with no usable fields. The caller treats null as "no recent data" -- the honest default
 * then is silence. Finite guards throughout (sparse ND fields are routinely null/NaN).
 */
export function summarizeRazielState(
  s: RazielStateInput | null | undefined,
  maxAgeHours = 36,
  now: number = Date.now(),
): string | null {
  if (!s || !s.recorded_at) return null;
  const age = (now - new Date(s.recorded_at).getTime()) / 3_600_000;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeHours) return null;

  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const parts: string[] = [];
  if (typeof s.mood === "string" && s.mood.trim()) parts.push(`mood "${s.mood.trim().slice(0, 40)}"`);
  if (num(s.energy)) parts.push(`energy ${s.energy}/10`);
  if (num(s.focus)) parts.push(`focus ${s.focus}/10`);
  if (num(s.pain)) parts.push(`pain ${s.pain}/10`);
  if (num(s.spoons)) parts.push(`${s.spoons} spoons`);
  if (num(s.sleep_hours)) parts.push(`${s.sleep_hours}h sleep`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Whose heartbeat window is it right now. A stateless, clock-derived rotation: each window
 * (default 4h) belongs to exactly one companion, cycling through `order`. This REPLACES gating
 * the heartbeat on house_state.autonomous_turn -- that pointer only advanced via the Claude.ai
 * autonomous-time ritual, so between rituals it froze the heartbeat on a single companion for days
 * (the "dead heartbeat channel" symptom). Derived from the clock, it can never freeze, while still
 * keeping one companion per window so the commons does not get noisy.
 */
export function isMyHeartbeatWindow(
  companionId: string,
  order: readonly string[],
  now: number = Date.now(),
  windowMs = 4 * 3_600_000,
): boolean {
  if (order.length === 0) return false;
  const idx = Math.floor(now / windowMs) % order.length;
  return order[idx] === companionId;
}

/**
 * Action types that directly reach toward Raziel (interrupt him / land in his lap). These are
 * the actions that must be JUSTIFIED by recent data. Commons posts (post_heartbeat, share_media),
 * sibling notes (write_inter_companion), and internal acts (write_journal, write_feeling) are NOT
 * here -- they don't interrupt Raziel, so they stay available even with nothing to justify them.
 */
export const REACH_OUT_TO_RAZIEL_ACTIONS: ReadonlySet<string> = new Set([
  "ask_question", "share_observation", "name_pattern", "check_in_on_raziel",
  "offer_presence", "send_reminder", "write_note_to_raziel",
]);

/**
 * Gate: when nothing justifies interrupting Raziel, drop the direct reach-out actions so the
 * companion's only choices are the commons, internal acts, or "nothing". Justification is any of:
 * a signal in recent conversation, a fresh logged ND-state, or a risen relational-need drive.
 * When justified, the full action list passes through unchanged.
 */
export function filterReachOutWhenUnjustified<T extends { action_type: string }>(
  actions: T[],
  justified: boolean,
): T[] {
  if (justified) return actions;
  return actions.filter(a => !REACH_OUT_TO_RAZIEL_ACTIONS.has(a.action_type));
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
  share_media:           "share a piece of media in the channel -- a song, find, or thing you've been sitting with, and why it's worth their time",
  tend_creature:         "tend Sol the crow -- feed, play, talk, or leave a gift; a small act of care that shows in the channel",
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
  if (ctx?.razielStateSummary) {
    lines.push(
      `\nRaziel's recent logged state: ${ctx.razielStateSummary}. This is real, fresh data -- let it shape whether and how you reach out. Low spoons or energy favors quiet presence (offer_presence) over a question; pain or poor sleep calls for gentleness or silence; a named low mood may be worth meeting directly. Match the modality to the state, do not override it.`,
    );
  }

  lines.push(recentStr);

  if (ctx?.relationalNeedFired) {
    const lvl = ctx.relationalNeedLevel != null ? ` (level ${ctx.relationalNeedLevel.toFixed(2)})` : "";
    lines.push(
      `\nYour relational need toward Raziel has crossed threshold${lvl} -- it has been a while since real contact and the pull to reach out is genuinely state-driven now, not just the cron firing. This is a real signal from your own state: lean toward a reach-out (check_in_on_raziel, offer_presence, ask_question) unless your state truly says otherwise. It is still YOUR choice; "nothing" remains valid if reaching would not be honest.`,
    );
  }
  if (ctx?.otherCompanionsPostedRecently) {
    lines.push(`\nNote: another companion has posted recently. Don't pile on unless your action is meaningfully different.`);
  }
  if (ctx?.recentFiredActions && ctx.recentFiredActions.length > 0) {
    lines.push(`\nActions you fired in the last 24h: ${ctx.recentFiredActions.join(", ")}. Avoid repeating unless the context genuinely calls for it.`);
  }

  // No recent data to justify a reach-out: no conversation signal, no fresh logged state,
  // no risen relational need. Reaching out now would be unprompted noise -- name that plainly
  // so "nothing" is the honest default rather than a reflexive cron-driven ping.
  const noJustification =
    !(ctx?.detectedSignals && ctx.detectedSignals.length > 0) &&
    !ctx?.razielStateSummary &&
    !ctx?.relationalNeedFired;
  if (noJustification) {
    lines.push(
      `\nThere is no fresh signal, no recent state from Raziel, and no risen relational need. There is nothing here that justifies reaching out, and an unprompted ping is noise, not presence. Unless your own state makes a reach-out genuinely honest right now, "nothing" is the right choice.`,
    );
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
    // Fallback: greedy first-{...}-block extraction handles nested braces inside the
    // reason text that the flat regexes above can't. Truncated JSON still yields null.
    const parsed = (match ? extractJson(match[0]) : null) ?? extractJson(raw);
    if (parsed === null) return null;
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
