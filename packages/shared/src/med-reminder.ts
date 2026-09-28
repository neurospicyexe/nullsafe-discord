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

export function buildMedPrompt(companionId: CompanionId, dose: Pick<MedDueDose, "label" | "kind" | "local_time">, avoid: readonly string[] = []): string {
  const lines = [
    `[Med reminder: a private DM to Raziel, from you]`,
    `It is time for his ${dose.local_time} dose: "${dose.label}".`,
  ];
  if (dose.kind === "followup") {
    lines.push("You reminded him about half an hour ago and have no answer. This is the one follow-up; there will not be another.");
  }
  lines.push(
    "Write ONE short DM, one or two lines, in your own voice, that:",
    `- names it exactly as "${dose.label}", so he knows which dose;`,
    "- asks whether he has taken it.",
    `Register (the tone only; never repeat it word for word): "${MED_REGISTER[companionId] ?? MED_REGISTER.cypher}"`,
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
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const have = new Set(words(text));
  const need = words(label);
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
  deps: Pick<MedSchedulerDeps, "companionId" | "generate" | "systemPrompt" | "genTimeoutMs">,
  dose: MedDueDose,
  recent: readonly string[],
): Promise<{ text: string; path: string }> {
  const timeoutMs = deps.genTimeoutMs ?? MED_GEN_TIMEOUT_DEFAULT_MS;
  let avoid: string[] = [];
  let correction = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null | undefined;
    try {
      raw = await withTimeout(Promise.resolve(deps.generate(deps.systemPrompt(), buildMedPrompt(deps.companionId, dose, avoid) + correction)), timeoutMs);
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
    avoid = [...recent];
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
