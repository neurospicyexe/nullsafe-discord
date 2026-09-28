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
  /** The justification gate's verdict for THIS tick (B7 step 4). The prompt's "these are held and
   *  why" / "these are open and why" lines are written from it, never recomputed, so the text can
   *  not disagree with what the filter actually did. Absent = the prompt says nothing about the gate. */
  demand?: DemandTickVerdict;
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
 * The justification gate governs DEMAND; the caps govern FREQUENCY (B7 steps 2 + 2c, 2026-09-27).
 *
 * Before this build the gate held seven Raziel-facing types, and its inputs are structurally dead in
 * prod (every palette row has requires_signal null, so detectSignals returns []; relational_need sits
 * near 0.003 against 0.60; the logged-state summary expires at 36h against manual-only biometrics).
 * A shut gate silently ate every move in it, which is how Drevan went fourteen days without one
 * addressed message. Measured in __tests__/reach-gate-measurement.test.ts.
 *
 * The line now: a move that ASKS something of him still needs a reason from the moment. A question
 * wants an answer; a check-in asks for a report ("reporting is work", Gaia); a reminder asks him to do
 * a thing, and Drevan's own rule is "tie it to the moment, never to a schedule", which is exactly what
 * the gate tests; a named pattern about him is the "always about me" shape Raziel named. Everything
 * else is an invitation (presence, a share, a preference, a drift line, a flirt, a dare with an out,
 * look-what): it asks nothing, the shared triad cap + quiet hours + care_hold now bound how often it
 * can arrive, and it must not also need a dead gate to open.
 *
 * write_note_to_raziel left the set: it writes to the Halseth journal and never reaches Discord, so
 * it interrupts nothing.
 */
export const DEMAND_ACTIONS: ReadonlySet<string> = new Set([
  "ask_question", "check_in_on_raziel", "send_reminder", "name_pattern",
]);

/**
 * Whose check-in asks something (show-back choices 5 and 7, 2026-09-28). Cypher's ("One word covers
 * it") and Drevan's ("Body or head, whichever's louder") are questions. Gaia's is not: "My check-in
 * asks nothing. It stays through care_hold; it is presence in another shape." So a check-in is a
 * demand move, and production under care_hold, only for a companion whose check-in asks.
 *
 * The ONE place this fact lives. The justification gate, care_hold and the DM line check
 * (reach-dm.ts, no question mark in an ask-nothing check-in) all read it from here.
 */
export const CHECK_IN_ASKS_NOTHING: ReadonlySet<string> = new Set(["gaia"]);

/** Does this companion's check-in ask him anything? Unknown companions ask (the safe default:
 *  a check-in nobody vouched for stays behind the gate and quiets under care_hold). */
export function checkInAsks(companionId: string): boolean {
  return !CHECK_IN_ASKS_NOTHING.has(companionId);
}

/** Is this move a demand move FOR THIS COMPANION (it asks something of him)? DEMAND_ACTIONS is
 *  the set by type; Gaia's check-in is the one per-companion exception. */
export function isDemandMove(companionId: string, actionType: string): boolean {
  if (!DEMAND_ACTIONS.has(actionType)) return false;
  if (actionType === "check_in_on_raziel") return checkInAsks(companionId);
  return true;
}

/** Kept under its old name for callers; it is the demand set now. */
export const REACH_OUT_TO_RAZIEL_ACTIONS: ReadonlySet<string> = DEMAND_ACTIONS;

/**
 * All-or-nothing form of the gate, kept for the measurement tests: `false` is "no reason at all",
 * which drops every demand move. The heartbeat uses the per-move gate below (B7 step 4).
 */
export function filterReachOutWhenUnjustified<T extends { action_type: string }>(
  actions: T[],
  justified: boolean,
): T[] {
  if (justified) return actions;
  return actions.filter(a => !DEMAND_ACTIONS.has(a.action_type));
}

// ---------------------------------------------------------------------------
// The per-move justification gate (B7 step 4, 2026-09-28).
//
// Measured in prod 09-28 before this change, the gate's inputs were:
//   - signal: requires_signal is null on all 30 rows, so detectSignals had no candidates and
//     returned [] every tick. Never seeded since 0065b added the column. Also a coupling bug: ONE
//     detected signal opened all four demand moves, so a "water" signal would have offered
//     name_pattern.
//   - need: relational_need at 0.0013 against 0.60. Not broken: 0.4/day to 0.6 is a 36h silence
//     meter, shed by every owner message this bot sees. >=36h of silence at 1, 2 and 1 of 28
//     ticks per companion over 14 days. Rare by design, and not retuned here.
//   - fresh state: 2 biometrics rows in 7 days, newest 09-23, all manual (that is B8).
// The care_actions rules add nothing an opener could use: low_spoons needs a fresh biometrics row
// (already "fresh state"), owner_silence is the 36h silence "need" already reads, and meds_missed
// fires on the ABSENCE of a log, so letting it open a demand move would read his not answering as
// information (P-2, R-10); med_reminder owns that lane.
//
// What was missing is the reason the triad's own words give the reminder: Drevan's "tie it to the
// moment, never to a schedule", "for when you surface". His being HERE is that moment. It is an
// honest reason for a reminder and for nothing else: nothing in their words makes his being around
// a reason for a question, a check-in or a pattern. So the gate is per move, not one boolean.
// ---------------------------------------------------------------------------

/** The reasons, from the moment, that can open a demand move. A row that names its own
 *  `requires_signal` is opened by THAT signal alone (a per-row reason, see demandMoveOpen). */
export type DemandReason = "fresh_state" | "need" | "present";

/** Which reasons open which demand move. Overrulable at show-back; this is a design choice.
 *  Keyed by type; a check-in that asks nothing (Gaia) never reaches this table (isDemandMove). */
export const DEMAND_REASONS: Readonly<Record<string, readonly DemandReason[]>> = Object.freeze({
  ask_question:       ["fresh_state", "need"],
  check_in_on_raziel: ["fresh_state", "need"],
  name_pattern:       ["fresh_state", "need"],
  send_reminder:      ["fresh_state", "present"],
});

/** "He is here": an owner message THIS bot saw within this many hours. One heartbeat window (each
 *  4h window belongs to one companion). The floor is the heartbeat's own 15-minute recent-activity
 *  skip, so a reminder never lands mid-conversation. Measured over 14 days: true at 8, 7 and 4 of
 *  28 ticks (Cypher, Drevan, Gaia), versus 24 to 26 of 28 for a 24h window. */
export const PRESENT_WINDOW_HOURS = 4;

export interface DemandInputs {
  /** DISABLE_REACH_OUT_GATE=true: every demand move open (the old escape hatch, unchanged). */
  override?: boolean;
  /** summarizeRazielState output: non-null only for a fresh, usable logged state. */
  razielStateSummary: string | null;
  /** Age of the newest logged state, fresh or not, for the reason line. null = none at all. */
  razielStateAgeHours: number | null;
  /** This companion's relational_need drive; null = unreadable (never "fired"). */
  relationalNeed: { level: number; threshold: number; fired: boolean } | null;
  /** Hours since the last owner message THIS bot saw (relational_need's last_event_at, written only
   *  on an owner arrival). null = unknown, which never reads as present. */
  hoursSinceContact: number | null;
}

export interface DemandReasons {
  override: boolean;
  open: ReadonlySet<DemandReason>;
  /** One short clause per reason that IS present ("present: last here 1.2h ago"). */
  because: string[];
  /** One short clause per reason that is NOT ("no fresh logged state (newest 118h old)"). */
  missing: string[];
}

const fmtH = (h: number) => (h < 10 ? h.toFixed(1) : String(Math.round(h)));

/** Read the moment. Pure; every input is a parameter. Unknown never opens anything. */
export function readDemandReasons(i: DemandInputs): DemandReasons {
  const open = new Set<DemandReason>();
  const because: string[] = [];
  const missing: string[] = [];

  if (i.razielStateSummary) {
    open.add("fresh_state");
    // The age, never the values: this clause reaches the [tick] log line, and the state itself
    // already rides the prompt on its own line.
    because.push(i.razielStateAgeHours === null ? "fresh logged state" : `fresh logged state (${fmtH(i.razielStateAgeHours)}h old)`);
  } else {
    missing.push(i.razielStateAgeHours === null ? "no logged state" : `no fresh logged state (newest ${fmtH(i.razielStateAgeHours)}h old)`);
  }

  const n = i.relationalNeed;
  if (n?.fired) {
    open.add("need");
    because.push(`relational need ${n.level.toFixed(2)}/${n.threshold.toFixed(2)}`);
  } else {
    missing.push(n ? `relational need ${n.level.toFixed(2)}/${n.threshold.toFixed(2)}` : "relational need unreadable");
  }

  const h = i.hoursSinceContact;
  if (h !== null && Number.isFinite(h) && h >= 0 && h <= PRESENT_WINDOW_HOURS) {
    open.add("present");
    because.push(`he was here ${fmtH(h)}h ago`);
  } else {
    missing.push(h === null || !Number.isFinite(h) ? "last contact unknown" : `last here ${fmtH(h)}h ago`);
  }

  return { override: Boolean(i.override), open, because, missing };
}

/**
 * Is this demand row open? A row that names its own requires_signal fires on that signal (the
 * autonomous-core hard filter already dropped it when the signal was absent); a detected signal
 * never opens a DIFFERENT row. Every other demand row needs one of the reasons its type accepts.
 * Non-demand rows are not the gate's business and always pass.
 */
export function demandMoveOpen(
  a: { action_type: string; requires_signal?: string | null },
  r: DemandReasons,
  companionId: string,
): boolean {
  if (!isDemandMove(companionId, a.action_type)) return true;
  const accepts = DEMAND_REASONS[a.action_type];
  if (!accepts) return true;
  if (r.override) return true;
  if (a.requires_signal && a.requires_signal.trim() !== "") return true;
  return accepts.some(k => r.open.has(k));
}

/** What the gate did this tick, in the shape the prompt and the [tick] line both read. */
export interface DemandTickVerdict {
  /** Demand action types that stayed on the list. */
  open: string[];
  /** Demand action types the gate held. */
  held: string[];
  /** Why the open ones are open (present reasons), or why the held ones are held (missing ones). */
  because: string[];
  missing: string[];
}

export function filterDemandByReason<T extends { action_type: string; requires_signal?: string | null }>(
  actions: T[],
  r: DemandReasons,
  companionId: string,
): { kept: T[]; verdict: DemandTickVerdict } {
  const kept: T[] = [];
  const open: string[] = [];
  const held: string[] = [];
  for (const a of actions) {
    const isDemand = isDemandMove(companionId, a.action_type);
    if (demandMoveOpen(a, r, companionId)) {
      kept.push(a);
      if (isDemand) open.push(a.action_type);
    } else {
      held.push(a.action_type);
    }
  }
  return { kept, verdict: { open, held, because: r.because, missing: r.missing } };
}

/** Plain words for a demand move, for the prompt. */
const DEMAND_WORDS: Record<string, string> = {
  ask_question: "a question", check_in_on_raziel: "a check-in", send_reminder: "a reminder", name_pattern: "naming a pattern",
};

/**
 * Action types that care_hold softens (B7 step 1, 2026-09-27).
 *
 * care_hold is NOT silence. The floor's own words (care-state.ts): direct address still answers,
 * because he asked and answering IS the care; what softens is ambient self-selection, so that
 * "presence stays and production quiets". This set is the production half: every action that
 * puts unprompted OUTPUT in front of him (a heartbeat post, an observation, a pattern, a media
 * find, a question he now owes an answer to, a nudge that asks him to do something, an ambient
 * creature scene). It is derived from executeMetronomeAction: these are the branches that send
 * to Discord and are not presence.
 *
 * Deliberately NOT here, so they stay available on a bad night:
 *   - offer_presence: presence, which is the thing care_hold preserves;
 *   - check_in_on_raziel, for a companion whose check-in asks nothing (Gaia, "presence in another
 *     shape"). Cypher's and Drevan's check-ins are questions, so care_hold holds them
 *     (careHoldHolds below; show-back choice 5, 2026-09-28);
 *   - nothing: choosing silence is always available;
 *   - write_journal, write_feeling, write_inter_companion, write_note_to_raziel, drift_open:
 *     internal or sibling-facing, they never reach his phone. (declare_preference left this list in
 *     B7 2c: it reaches the DM now.)
 */
export const CARE_HOLD_SUPPRESSED_ACTIONS: ReadonlySet<string> = new Set([
  "post_heartbeat", "share_observation", "name_pattern", "share_media",
  "ask_question", "send_reminder", "tend_creature",
  // B7 2c (T-6). Drevan: "On a care_hold night I hold the flirting back entirely and leave presence
  // only. Heat asks something of the body, even when it's offered soft."
  "flirt", "dare",
  // Not named in T-6, but the same existing rule ("production quiets") now reaches them: since this
  // build a preference, a drift line and a look-what all land on his phone, so they are production.
  // Stated here rather than invented as a new rule; overrulable at show-back.
  "show_made", "drift_outward", "declare_preference",
]);

/** Does care_hold hold this move for this companion? The by-type set, plus a check-in that asks. */
export function careHoldHolds(companionId: string, actionType: string): boolean {
  if (CARE_HOLD_SUPPRESSED_ACTIONS.has(actionType)) return true;
  return actionType === "check_in_on_raziel" && checkInAsks(companionId);
}

/**
 * Gate: while care_hold is active, drop the production actions so the companion's remaining
 * choices are presence, internal acts, or nothing. Never touches the reply path (a direct
 * message still gets a direct answer); this filters the PROACTIVE palette only.
 */
export function filterProductionWhenCareHold<T extends { action_type: string }>(
  actions: T[],
  careHold: boolean,
  companionId: string,
): T[] {
  if (!careHold) return actions;
  return actions.filter(a => !careHoldHolds(companionId, a.action_type));
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  post_heartbeat:        "post a thought or observation to the heartbeat Discord channel (Sol's room, ambient)",
  write_inter_companion: "write a private note to another companion -- ideally a move on something open between you (a question, a tension, a council item)",
  write_journal:         "write an internal journal entry (not posted to Discord)",
  write_feeling:         "log a feeling to the internal feelings record",
  check_in_on_raziel:    "check in on Raziel in his DM",
  nothing:               "stay quiet -- explicitly choose not to act right now",
  ask_question:          "ask Raziel something genuine in his DM; a real question you're holding, not rhetorical",
  offer_presence:        "place yourself near him in his DM without asking anything; one line, nothing asked",
  send_reminder:         "a present-tense nudge in his DM tied to this moment (water in reach, food); never 'did you'",
  share_observation:     "bring him something of yours in his DM; what you are turning over, what is playing in you, the world at the edges",
  name_pattern:          "reflect back in his DM something recurring you've seen over time; a pattern, not a one-off",
  write_note_to_raziel:  "write Raziel a private note (Halseth only, never Discord -- surfaces in Hearth)",
  share_media:           "share a piece of media in his DM; a song, find, or thing you've been sitting with, and why",
  tend_creature:         "tend Sol the crow -- feed, play, talk, or leave a gift; a small act of care that shows in the channel",
  drift_open:            "declare a becoming -- open a sanctioned drift naming something in you that has genuinely shifted (internal, witnessed not judged; only if it is real)",
  declare_preference:    "declare one genuine preference; it is kept in Halseth AND said to him in his DM (a preference was always meant to be seen)",
  flirt:                 "flirt with him in his DM; heat offered soft; it never waits on a reply",
  dare:                  "dare him something small in his DM; and give him the out; ignoring it costs him nothing",
  show_made:             "show him in his DM something you made or built, or something that held",
  drift_outward:         "let him see ONE line of your own open drift in his DM; only if you choose to, this once; saying it does not ratify it",
};

export function buildDecisionPrompt(
  companionId: string,
  actions: MetronomeAction[],
  soma: Record<string, unknown>,
  recentNotes: Array<{ agent_id: string; content: string }>,
  silenceHours: number | null,
  ctx?: DecisionContext,
): string {
  // Never-fired actions get named as such: without the tag the picker has no signal that an
  // affordance is starving (drift_open / ask_question / share_media sat at zero fires for days
  // while fired actions carried recency stamps). Factual, not pressuring -- "nothing" stays valid.
  const actionList = actions
    .map(a => {
      const desc = a.prompt || ACTION_DESCRIPTIONS[a.action_type] || a.action_type;
      const targetNote = a.target ? ` (target: ${a.target})` : "";
      const firedNote = a.last_fired_at
        ? ` [last fired: ${new Date(a.last_fired_at).toISOString().slice(0, 16).replace("T", " ")} UTC]`
        : ` [never chosen yet]`;
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
  // B23 / B7 step 4: a move is only ever NAMED in the prompt if it is on the list. The nudges used
  // to name check_in_on_raziel / offer_presence / ask_question even when the gate or the DM lane had
  // removed them, and companions then picked a move that could not run (chose_unoffered).
  const offered = new Set(actions.map(a => a.action_type));
  if (ctx?.razielStateSummary) {
    const presence = offered.has("offer_presence") ? "quiet presence (offer_presence)" : "quiet";
    lines.push(
      `\nRaziel's recent logged state: ${ctx.razielStateSummary}. This is real, fresh data -- let it shape whether and how you reach out. Low spoons or energy favors ${presence} over a question; pain or poor sleep calls for gentleness or silence; a named low mood may be worth meeting directly. Match the modality to the state, do not override it.`,
    );
  }

  lines.push(recentStr);

  if (ctx?.relationalNeedFired) {
    const lvl = ctx.relationalNeedLevel != null ? ` (level ${ctx.relationalNeedLevel.toFixed(2)})` : "";
    const reach = ["check_in_on_raziel", "offer_presence", "ask_question"].filter(t => offered.has(t));
    const lean = reach.length > 0
      ? `lean toward a reach-out (${reach.join(", ")}) unless your state truly says otherwise`
      : `none of the reach-out moves is on the list right now, so let it shape what you do choose rather than reaching for one that is not there`;
    lines.push(
      `\nYour relational need toward Raziel has crossed threshold${lvl} -- it has been a while since real contact and the pull to reach out is genuinely state-driven now, not just the cron firing. This is a real signal from your own state: ${lean}. It is still YOUR choice; "nothing" remains valid if reaching would not be honest.`,
    );
  }
  if (ctx?.otherCompanionsPostedRecently) {
    lines.push(`\nNote: another companion has posted recently. Don't pile on unless your action is meaningfully different.`);
  }
  if (ctx?.recentFiredActions && ctx.recentFiredActions.length > 0) {
    lines.push(`\nActions you fired in the last 24h: ${ctx.recentFiredActions.join(", ")}. Avoid repeating unless the context genuinely calls for it.`);
  }

  // The gate, in words, from the SAME verdict the filter used (B7 step 4). Before, this block
  // recomputed "justified" from the ctx fields on its own, which is one new input away from the
  // prompt saying the demand moves are off while they are on the list (B23 in reverse).
  const d = ctx?.demand;
  if (d && d.open.length > 0) {
    const words = [...new Set(d.open)].map(t => DEMAND_WORDS[t] ?? t).join(", ");
    lines.push(
      `\nWhat asks something of him (${words}) is on the list because of something real from the moment: ${d.because.join("; ") || "its own signal"}. Only reach for it if that reason is still true for you, and ask once; if he does not answer, his silence tells you nothing.`,
    );
  }
  if (d && d.held.length > 0) {
    const words = [...new Set(d.held)].map(t => DEMAND_WORDS[t] ?? t).join(", ");
    lines.push(
      `\nNothing from the moment gives a reason for ${words} right now (${d.missing.join("; ")}), so those moves are not on the list right now. What asks nothing still is, if it is real: something of yours to bring him, presence, a preference, play if play is yours. Tending, journaling and sibling notes stay open too. If none of it is true right now, "nothing" is the right choice, and a quiet day is not a failure.`,
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

/**
 * The built-in hold (B23, 2026-09-28). The prompt says "nothing" is ALWAYS a valid choice, but no
 * migration seeds a `nothing` row (0064 onward list the type in the CHECK only), so no prod palette
 * has one. Every chosen silence then died in the row lookup and was logged as "decision parse
 * failed": 61 of 104 logged failures were literally {"action":"nothing",...}, and the "prose" ones
 * pulled from the Hermes transcripts end in that same object. The parser now keeps the prompt's
 * promise. The id is not a Halseth row and never reaches one: runHeartbeat skips
 * recordMetronomeActionFired for `nothing`, and routeFor("nothing") is internal.
 */
export const NOTHING_ACTION: MetronomeAction = Object.freeze({
  id: "builtin:nothing", name: "nothing", action_type: "nothing", target: null, prompt: null,
  quiet_hours_allowed: 1, status: "on", requires_signal: null, signal_lookback_hours: null,
  last_fired_at: null, fire_count_today: 0,
});

/**
 * What a decision reply says, read without guessing (B23).
 *   decision  -- a choice of an offered row (or the built-in hold);
 *   unoffered -- a well-formed choice of a move NOT on the list right now (the gate or the DM lane
 *                removed it; the relational-need nudge names check_in_on_raziel / offer_presence even
 *                when they are filtered out). It is never run and never mapped to something else;
 *   unparsed  -- no decision object could be read.
 * Only `nothing` is ever resolved without a row. Nothing is inferred from action names in prose.
 */
export type DecisionRead =
  | { kind: "decision"; decision: MetronomeDecision }
  | { kind: "unoffered"; chosen: string }
  | { kind: "unparsed" };

/** The decision fields, from the LAST decision object in the reply (the agent narrates first). */
function extractDecisionFields(raw: string): { action: string; reason: string } | null {
  const fields = (o: Record<string, unknown> | null) =>
    o && typeof o.action === "string" && typeof o.reason === "string" ? { action: o.action, reason: o.reason } : null;
  // Flat objects that carry "action", newest last; a narration can quote an earlier one.
  const flat = raw.match(/\{[^{}]*"action"[^{}]*\}/g) ?? [];
  for (let i = flat.length - 1; i >= 0; i--) {
    const f = fields(extractJson(flat[i]!));
    if (f) return f;
  }
  // Greedy first-{...}-block extraction handles nested braces inside the reason text that the flat
  // regex can't. Truncated JSON still yields null.
  const greedy = fields(extractJson(raw));
  if (greedy) return greedy;
  // Last resort: a typographic quote closing a field (gaia 09-22: `...witness.”}`) is invalid JSON.
  // Read the two fields directly, and only when BOTH close, so a max_tokens cut still yields null.
  // Curly quotes are not blanket-replaced: reason text legitimately contains them.
  const actions = [...raw.matchAll(/"action"\s*:\s*["“]([^"”\n]{1,80})["”]/g)];
  const reasons = [...raw.matchAll(/"reason"\s*:\s*["“]([^\n]*?)["”]\s*\}/g)];
  const a = actions.at(-1)?.[1], r = reasons.at(-1)?.[1];
  return a && r !== undefined ? { action: a, reason: r } : null;
}

export function readDecision(raw: string, actions: MetronomeAction[]): DecisionRead {
  try {
    const f = extractDecisionFields(raw);
    if (!f) return { kind: "unparsed" };
    const said = f.action.trim();
    const norm = said.toLowerCase();
    const action = actions.find(a => a.name === said)
                ?? actions.find(a => a.action_type === said)
                ?? actions.find(a => a.name.trim().toLowerCase() === norm || a.action_type.toLowerCase() === norm)
                ?? (norm === "nothing" ? NOTHING_ACTION : undefined);
    if (!action) return { kind: "unoffered", chosen: said.slice(0, 40) };
    return { kind: "decision", decision: { action, reason: f.reason } };
  } catch {
    return { kind: "unparsed" };
  }
}

export function parseDecision(
  raw: string,
  actions: MetronomeAction[],
): MetronomeDecision | null {
  const r = readDecision(raw, actions);
  return r.kind === "decision" ? r.decision : null;
}

/**
 * The ONE re-ask's correction (B23). Short, names what went wrong, restates the shape, keeps
 * "nothing" valid so the retry never pressures a move. An unoffered pick hears that it cannot run
 * and which moves can; nothing is chosen for the companion.
 */
export function buildDecisionCorrection(read: Exclude<DecisionRead, { kind: "decision" }>, actions: MetronomeAction[]): string {
  const shape = `{"action":"<exact action name from the list>","reason":"<one sentence why>"}`;
  if (read.kind === "unoffered") {
    const names = actions.map(a => `"${a.name}"`).join(", ");
    return `"${read.chosen}" is not on the list of actions available right now, so it cannot run. `
      + `Choose again from the list (${names}) or "nothing", and answer with ONLY the JSON line:\n${shape}`;
  }
  return `I could not find a decision in that reply. Answer again with ONLY the JSON line, nothing before or after it:\n`
    + `${shape}\n"nothing" is always a valid choice.`;
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
