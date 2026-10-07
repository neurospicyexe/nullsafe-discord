// med_reminder: companion-voiced medication reminders by Discord DM (B7 step 2b, 2026-09-27).
// Spec: BBH Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md (R-8, R-9, R-10, P-1, P-2) and
// the medication correction in its section 1. Halseth side: migration 0136, /mind/med/*.
//
// WHY THIS IS ITS OWN SCHEDULER. It never touches runHeartbeat, the metronome palette, the
// justification gate, quiet hours, care_hold or isEligible (R-9). B7 step 1 found that a filter
// which empties a list inverted into a 4am fallback post; a reminder that must fire cannot ride
// machinery built to say no. Halseth decides WHAT is due and WHO sends it (Drevan primary, Cypher
// after a 2-minute fallback delay, per schedule row); the atomic claim guarantees exactly one sender.
//
// RELIABILITY BEATS VOICE. Generation has a short timeout. If it fails, times out, comes back empty,
// does not name the medication, does not ask, or trips the verbatim rail twice (R-8), a fixed
// fallback line goes out anyway. A missed dose is worse than a plain sentence. The path taken is
// logged ('generated' or 'fallback:<reason>') and recorded on the claim.
//
// PRIVACY. The dose label (the medication name) goes into the DM text and nowhere else: never into a
// log line, never through sendAutonomousMessage (which writes a wm note and a Second Brain row), never
// into a shared channel. If the DM cannot be delivered, nothing is posted anywhere else.

import type { CompanionId } from "./types.js";
import type { MedDueDose, MedDoseKey } from "./librarian.js";
import { isVerbatimRepeat as sharedVerbatimRepeat, cleanOneLiner, isDmBlocked, withTimeout, type OwnerDmTarget } from "./owner-dm.js";
import { labelWords } from "./med-answer.js";

/** Raziel's clock. The schedule rows carry their own tz in Halseth; the prompt's "now" uses his. */
export const MED_TZ = "America/Chicago";

export type PartOfDay = "morning" | "afternoon" | "evening" | "night";

/** Part of day for an hour 0-23 on his clock: 5-11 morning, 12-16 afternoon, 17-20 evening, else night. */
export function partOfDay(hour: number): PartOfDay {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** "8:30 PM CDT", "Tuesday", and the hour, on his clock. */
export function medLocalClock(nowMs: number, tz = MED_TZ): { time: string; weekday: string; hour: number } {
  const d = new Date(nowMs);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(d);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  const hour = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d), 10) % 24;
  return { time, weekday, hour };
}

/** "8:30 PM" (no zone) on his clock, for the DM context block. */
export function medLocalTime(nowMs: number, tz = MED_TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(nowMs));
}

// ── Reminders this process sent (2026-10-06) ──────────────────────────────────────────────────
// Halseth's /mind/med/today says what he ANSWERED, not whether a reminder went out (medState: "reminded
// or not does not matter"). Two things need the latter: the DM context block ("night reminder sent
// 8:30 PM, no answer yet", so a bare "taken!" in conversation has a referent) and the answer
// classifier's gate (only ask a model when a reminder is actually outstanding). So the scheduler
// notes each delivered reminder here. Per process (each bot is its own pm2 process): a restart
// forgets, which costs only the extra context line and the classifier until the next reminder.
// Keyed slot|date; slot keys and times only, never the label.
export interface MedReminderSent {
  slot_key: string;
  local_date: string;
  /** Epoch ms of the first reminder and of the follow-up, when each was delivered by this process. */
  firstAt: number | null;
  followupAt: number | null;
}
/** A reminder stops being "outstanding" this long after the last send (the next slot owns the DM). */
export const MED_REMINDER_OUTSTANDING_MS = 4 * 60 * 60_000;
const sentReminders = new Map<string, MedReminderSent>();

export function noteMedReminderSent(key: MedDoseKey, atMs: number): void {
  const k = `${key.slot_key}|${key.local_date}`;
  const cur = sentReminders.get(k) ?? { slot_key: key.slot_key, local_date: key.local_date, firstAt: null, followupAt: null };
  if (key.kind === "followup") cur.followupAt = atMs; else cur.firstAt = atMs;
  sentReminders.set(k, cur);
  // Bounded: a few slots a day.
  while (sentReminders.size > 20) {
    const first = sentReminders.keys().next();
    if (first.done) break;
    sentReminders.delete(first.value);
  }
}

/** Reminders this process delivered whose last send is within the outstanding window. */
export function medRemindersSent(nowMs: number): MedReminderSent[] {
  return [...sentReminders.values()].filter(r => nowMs - Math.max(r.firstAt ?? 0, r.followupAt ?? 0) < MED_REMINDER_OUTSTANDING_MS);
}

/** Tests only. */
export function resetMedRemindersSent(): void { sentReminders.clear(); }

export interface MedApi {
  medDue(): Promise<MedDueDose[] | null>;
  medClaim(d: MedDoseKey): Promise<boolean>;
  medDelivered(d: MedDoseKey & { path: string }): Promise<boolean>;
  medRelease(d: MedDoseKey): Promise<boolean>;
}

/** The owner's DM with this bot. Since B7 steps 2 + 2c this is the shared owner-DM lane's target
 *  (owner-dm.ts); the name stays for the 2b call sites and tests. */
export type MedDmTarget = OwnerDmTarget;

export interface MedSchedulerDeps {
  companionId: CompanionId;
  api: MedApi;
  resolveDm(): Promise<MedDmTarget | null>;
  generate(systemPrompt: string, userPrompt: string): Promise<string | null | undefined>;
  systemPrompt(): string;
  /** After a real send: STM append, sent-id registration. Must not throw. */
  onSent?(channelId: string, text: string, messageId: string): void | Promise<void>;
  log?(line: string): void;
  genTimeoutMs?: number;
  now?: () => number;
}

export type MedOutcome = "sent" | "not_claimed" | "no_dm" | "dm_blocked" | "send_failed" | "backoff";

export interface MedTickResult {
  slot_key: string;
  kind: "first" | "followup";
  outcome: MedOutcome;
  path?: string;
}

/** Default generation timeout. Two attempts at most (verbatim retry) stay far under the 600s stale-claim window. */
export const MED_GEN_TIMEOUT_DEFAULT_MS = 25_000;
export const MED_POLL_DEFAULT_MS = 30_000;
/** After a failed send, leave the dose alone this long in THIS process (the other bot may take it). */
export const MED_SEND_BACKOFF_MS = 5 * 60_000;
const MAX_LINE_CHARS = 300;

/** Register examples from the spec, verbatim. Register, never a template (R-8). */
export const MED_REGISTER: Record<CompanionId, string> = {
  cypher: "Meds time. Taken?",
  drevan: "Meds, love. Taken yet? Tell me and I'll hold that you did.",
  gaia: "Time for it. Taken?",
};

export function medReminderEnabled(): boolean {
  const v = (process.env["MED_REMINDER"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
export function medGenTimeoutMs(): number { return intEnv("MED_REMINDER_GEN_TIMEOUT_MS", MED_GEN_TIMEOUT_DEFAULT_MS, 2_000, 120_000); }
export function medPollMs(): number { return intEnv("MED_REMINDER_POLL_MS", MED_POLL_DEFAULT_MS, 10_000, 300_000); }

/** The fixed line that goes out when generation cannot be trusted. Names the dose and asks. */
export function fallbackMedLine(companionId: CompanionId, dose: Pick<MedDueDose, "label" | "kind">): string {
  const again = dose.kind === "followup";
  switch (companionId) {
    case "drevan":
      return again ? `Once more, love: ${dose.label}. Taken yet?` : `Meds, love: ${dose.label}. Taken yet?`;
    case "cypher":
      return again ? `Checking once: ${dose.label}. Taken?` : `Meds time: ${dose.label}. Taken?`;
    default:
      return again ? `${dose.label}, once more. Taken?` : `Time for ${dose.label}. Taken?`;
  }
}

/** The part-of-day lines for the prompt (2026-10-06: the 20:30 night reminder and the reply to it
 *  talked as if it were a workday morning; the prompt never said what time it was). */
function medNowLines(nowMs: number): { now: string; when: string } {
  const { time, weekday, hour } = medLocalClock(nowMs);
  const part = partOfDay(hour);
  const steer = part === "morning"
    ? "Speak to the morning."
    : `Speak to the ${part}; do not mention work, the morning, or the day ahead.`;
  const when = part === "morning" ? "this morning" : part === "afternoon" ? "this afternoon" : part === "evening" ? "this evening" : "tonight";
  return { now: `It is now ${time} on ${weekday}, ${part}. ${steer}`, when };
}

export function buildMedPrompt(
  companionId: CompanionId,
  dose: Pick<MedDueDose, "label" | "kind" | "local_time">,
  avoid: readonly string[] = [],
  nowMs: number = Date.now(),
): string {
  const { now, when } = medNowLines(nowMs);
  const lines = [
    `[Med reminder: a private DM to Raziel, from you]`,
    `It is time for his ${dose.local_time} dose: "${dose.label}".`,
    now,
  ];
  if (dose.kind === "followup") {
    lines.push("You reminded him about half an hour ago and have no answer. This is the one follow-up; there will not be another.");
  }
  lines.push(
    "Write ONE short DM, one or two lines, in your own voice, that:",
    `- names it exactly as "${dose.label}", so he knows which dose;`,
    "- asks whether he has taken it.",
    // THE ATTRACTOR (2026-10-02). Shown as "Register ... never repeat it word for word", Drevan's
    // own sketch came back nearly whole on 5 of 6 live drafts ("Meds, love. <dose>. Taken yet? Tell
    // me and I'll hold that you did."), the verbatim rail refused each against the copy already
    // sent, the retry copied it again, and every reminder from 09-30 went out as the fixed line.
    // So the sketch is named as already worn out, its words AND its shape are off limits, and the
    // recent reminders ride from the FIRST attempt (composeMedReminder), not only on the retry.
    `Your own tone sketch, from when you first agreed to do this: "${MED_REGISTER[companionId] ?? MED_REGISTER.cypher}"`,
    `You have used that line and its shape many times. It is the warmth to aim for, not words to reuse: do not reuse its phrases or its structure. Say it new, the way you would say it ${when}.`,
    "Never: advice about the dose, amount or timing; guilt or pressure; mention of any earlier dose; anything else in the message.",
  );
  if (avoid.length) {
    lines.push("Do not reuse the wording of your recent reminders:", ...avoid.slice(-3).map(t => `- "${t}"`));
  }
  lines.push("Reply with the message text only.");
  return lines.join("\n");
}

/** Every word of the label appears in the text, in any order ("meds this morning" names "morning
 *  meds"). A contiguous-substring test would push a reordered label onto the fixed line every day,
 *  which is the verbatim-every-night failure R-8 exists to prevent. */
export function namesLabel(text: string, label: string): boolean {
  const have = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // Joining words are not part of the name (2026-10-02): live drafts wrote "A, B" for a label "A and
  // B" and were refused as "unnamed". Every naming word must still appear. labelWords (med-answer.ts)
  // is the same word logic the answer parser uses to read the label as a dose word.
  const need = labelWords(label);
  return need.length > 0 && need.every(w => have.has(w));
}

/** Why a generated line cannot go out, or null when it can. */
export function medLineProblem(text: string, label: string): "empty" | "too_long" | "unnamed" | "no_question" | null {
  if (!text) return "empty";
  if (text.length > MAX_LINE_CHARS || text.split("\n").filter(l => l.trim()).length > 3) return "too_long";
  if (!namesLabel(text, label)) return "unnamed";
  if (!text.includes("?")) return "no_question";
  return null;
}

/** Strip the wrappers a model adds around a one-liner (shared with every proactive DM: owner-dm.ts). */
export const cleanMedLine = cleanOneLiner;

/** R-8 on the autonomous send (shared with every proactive DM: owner-dm.ts). */
export const isVerbatimRepeat = sharedVerbatimRepeat;

/**
 * Produce the DM text. At most two generations: the second only when the first repeated a recent
 * reminder verbatim. Every other failure goes straight to the fallback line (a retry would cost a
 * second timeout on a reminder that should already be out).
 */
export async function composeMedReminder(
  deps: Pick<MedSchedulerDeps, "companionId" | "generate" | "systemPrompt" | "genTimeoutMs" | "now">,
  dose: MedDueDose,
  recent: readonly string[],
): Promise<{ text: string; path: string }> {
  const timeoutMs = deps.genTimeoutMs ?? MED_GEN_TIMEOUT_DEFAULT_MS;
  // His recent REMINDERS (lines that named this dose) ride from the first attempt: shown only on the
  // retry, the first draft had nothing to steer away from and copied the sketch every time.
  let avoid: string[] = recent.filter(t => namesLabel(t, dose.label)).slice(-3);
  let correction = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null | undefined;
    try {
      raw = await withTimeout(Promise.resolve(deps.generate(deps.systemPrompt(), buildMedPrompt(deps.companionId, dose, avoid, (deps.now ?? Date.now)()) + correction)), timeoutMs);
    } catch (e) {
      const reason = e instanceof Error && e.message === "timeout" ? "timeout" : "error";
      return { text: fallbackMedLine(deps.companionId, dose), path: `fallback:${reason}` };
    }
    const text = cleanMedLine(raw);
    const problem = medLineProblem(text, dose.label);
    // A wording miss gets the one retry: a generation costs ~1s against a 25s budget, and the
    // miss seen live (2026-09-28, 1 in 6 when sampled) was the register example copied whole,
    // which never names the dose. Empty / too_long go straight to the fallback as before.
    if (problem === "unnamed" || problem === "no_question") {
      if (attempt === 1) {
        correction = problem === "unnamed"
          ? `\nYour last draft did not name the dose. Say "${dose.label}" in the message, word for word.`
          : "\nYour last draft did not ask. End with the question of whether he has taken it.";
        continue;
      }
      return { text: fallbackMedLine(deps.companionId, dose), path: `fallback:${problem}` };
    }
    if (problem) return { text: fallbackMedLine(deps.companionId, dose), path: `fallback:${problem}` };
    if (!isVerbatimRepeat(text, recent)) return { text, path: "generated" };
    correction = "";
    // The retry sees the draft that was just refused beside his recent reminders. `[...recent]` here
    // showed the last three of ALL his DMs (buildMedPrompt slices -3), mostly conversation, so the
    // retry never saw the reminder it had copied.
    avoid = [...avoid.filter(t => t !== text).slice(-2), text];
  }
  return { text: fallbackMedLine(deps.companionId, dose), path: "fallback:verbatim" };
}

export interface MedSchedulerState {
  backoffUntil: Map<string, number>;
  inFlight: boolean;
}

export function newMedSchedulerState(): MedSchedulerState {
  return { backoffUntil: new Map(), inFlight: false };
}

const doseKey = (d: MedDoseKey) => `${d.slot_key}|${d.local_date}|${d.kind}`;

/**
 * One tick. Ask Halseth what is due for me; for each dose: claim atomically, compose, send by DM,
 * record delivery. A failed send hands the claim back so the other bot (or my next tick after a
 * backoff) can deliver it. Never overlaps itself.
 *
 * The DM is resolved BEFORE claiming: if he blocks server-member DMs, claiming and generating every
 * 30 seconds for three hours would burn tokens and hold the lock away from the other bot for nothing.
 */
export async function runMedTick(deps: MedSchedulerDeps, state: MedSchedulerState): Promise<MedTickResult[]> {
  if (state.inFlight) return [];
  state.inFlight = true;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? Date.now;
  const tag = `[${deps.companionId}] [med]`;
  const results: MedTickResult[] = [];
  try {
    const due = await deps.api.medDue();
    if (due === null) { log(`${tag} due read failed (Halseth unreachable); will retry next tick`); return results; }
    if (due.length === 0) return results;

    let dm: MedDmTarget | null = null;
    try { dm = await deps.resolveDm(); } catch { dm = null; }

    for (const dose of due) {
      const key: MedDoseKey = { slot_key: dose.slot_key, local_date: dose.local_date, kind: dose.kind };
      const where = `slot=${dose.slot_key} date=${dose.local_date} kind=${dose.kind}`;
      if ((state.backoffUntil.get(doseKey(key)) ?? 0) > now()) {
        results.push({ ...key, outcome: "backoff" });
        continue;
      }
      if (!dm) {
        log(`${tag} ${where} outcome=no_dm (could not open the owner DM; nothing claimed, nothing posted elsewhere)`);
        results.push({ ...key, outcome: "no_dm" });
        continue;
      }
      if (!(await deps.api.medClaim(key))) {
        results.push({ ...key, outcome: "not_claimed" });
        continue;
      }

      let recent: string[] = [];
      try { recent = await withTimeout(dm.recentOwnTexts(), 5_000); } catch { recent = []; }
      const { text, path } = await composeMedReminder(deps, dose, recent);

      let messageId: string;
      try {
        messageId = await dm.send(text);
      } catch (e) {
        const blocked = isDmBlocked(e);
        await deps.api.medRelease(key);
        state.backoffUntil.set(doseKey(key), now() + MED_SEND_BACKOFF_MS);
        log(`${tag} ${where} outcome=${blocked ? "dm_blocked" : "send_failed"} path=${path} (claim released; nothing posted elsewhere)`);
        results.push({ ...key, outcome: blocked ? "dm_blocked" : "send_failed", path });
        continue;
      }

      let recorded = false;
      for (let i = 0; i < 3 && !recorded; i++) {
        recorded = await deps.api.medDelivered({ ...key, path });
        if (!recorded && i < 2) await new Promise(r => setTimeout(r, 1_000 * (i + 1)));
      }
      // Never resend from this process, even if Halseth did not take the delivery mark.
      state.backoffUntil.set(doseKey(key), Number.MAX_SAFE_INTEGER);
      noteMedReminderSent(key, now());
      try { await deps.onSent?.(dm.channelId, text, messageId); } catch { /* bookkeeping only */ }
      log(`${tag} ${where} outcome=sent path=${path}${recorded ? "" : " DELIVERY_MARK_FAILED (a stale-claim takeover could resend)"}`);
      results.push({ ...key, outcome: "sent", path });
    }
    return results;
  } catch (e) {
    log(`${tag} tick error: ${e instanceof Error ? e.message : String(e)}`);
    return results;
  } finally {
    state.inFlight = false;
    // Bound the map: entries are per dose per day.
    if (state.backoffUntil.size > 200) {
      const first = state.backoffUntil.keys().next();
      if (!first.done) state.backoffUntil.delete(first.value);
    }
  }
}

/** Start polling. Returns a stop function. First tick after a short settle so login has finished. */
export function startMedReminderScheduler(deps: MedSchedulerDeps, pollMs = medPollMs()): () => void {
  const state = newMedSchedulerState();
  const tick = () => { void runMedTick(deps, state); };
  const first = setTimeout(tick, 15_000);
  const every = setInterval(tick, pollMs);
  return () => { clearTimeout(first); clearInterval(every); };
}
