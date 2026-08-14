// Vibe-check reflection loop -- the digest turned back into motion.
//
// The nightly vibe-check (Gaia's witness post) was landing as a static mirror: the same
// tension text night after night, guardian notices from April looping forever, nobody
// answering. This closes the loop. After a FRESH digest is posted, each companion gets a
// reflection pass over their own section:
//
//   1. Orphaned continuity notes flagged by the Guardian are deliberately RECALLED
//      (server warms them -- last_access_at set -- so the detector stops re-flagging),
//      their content fed into the reflection, and the flag resolved. Rescue, not delete.
//   2. Simmering tensions are surfaced with their age; the companion decides: hold it
//      (with a note on why it still matters), release it, or crystallize what it taught.
//      They may also name one NEW tension. Either way the table moves.
//   3. A short reflection lands in growth_journal (source='reflection').
//   4. A short reply lands in the vibe channel in the companion's OWN voice, via their
//      own bot token -- so the witness post gets answered instead of echoing alone.
//
// Safety: the vibe channel is `broadcast` mode in channel-config (bots never respond
// there), so these worker-posted replies cannot trigger bot-to-bot loops.
// Cost: 3 DeepSeek calls per night. Failures are per-companion and never fail the tick.

import { prompt } from "./deepseek.js";
import { loadIdentityRemote } from "./identity-loader.js";
import { stripJsonFence } from "./parsers.js";
import { COMPANIONS, REFLECTION_MAX_TOKENS } from "./config.js";
import type { CompanionId } from "./types.js";
import {
  getGuardianFlagsFor,
  resolveGuardianFlag,
  getSimmeringTensions,
  updateTension,
  addTension,
  recallContinuityNotes,
  writeJournalEntry,
  getRecentJournal,
  getOpenDrifts,
  openDrift,
  crystallizeDrift,
  fadeDrift,
  authoredSessionClose,
  type GuardianFlagRow,
  type Tension,
  type RecalledContinuityNote,
  type OpenDriftRow,
} from "./halseth-client.js";

const REPLY_MAX = 1200;   // Discord-safe, and keeps the channel readable
const TENSION_STALE_DAYS = 7;
const RAISE_REASON_MAX = 200;

/**
 * Tag that puts this entry in front of Raziel (2026-08-12).
 *
 * MUST match `ESCALATION_TAG` in halseth `src/lib/ratifiable.ts`, which is where the predicate that
 * reads it lives. Duplicated because the two repos share no package; if it ever drifts the failure
 * is silent -- every entry becomes a log and nothing is ever raised -- so it is asserted in this
 * package's tests against the literal string, not against an import.
 *
 * Why this exists: the nightly reflection is one entry per companion per night, so making every one
 * of them await Raziel's verdict grew the queue ~2.7/day and stranded 40 entries, the oldest 33
 * days old. Raziel's call: the companion is the one who decides which of its own self-reads is
 * canon-changing. Unraised entries stay readable on Hearth and materialize to the vault; they just
 * do not sit in a to-do list.
 */
const ESCALATION_TAG = "needs-raziel";

interface ReflectionVerdict {
  reply: string;
  journal: string;
  tension_action: { id: string; action: "hold" | "release" | "crystallize"; note: string } | null;
  new_tension: string | null;
  // Sanctioned drift lane (0087/0093): resolve an open becoming, or declare a new one.
  drift_action: { id: string; action: "crystallize" | "fade"; note: string } | null;
  new_drift: string | null;
  /**
   * Non-null when the companion judges tonight's reflection actually changes what it takes as true
   * about itself, and wants Raziel's verdict. The string IS the reason, so the field cannot be set
   * without saying why -- a bare boolean would be far too easy to answer "true" to.
   * Null (the expected answer most nights) leaves the entry as a log.
   */
  needs_raziel: string | null;
  /**
   * The companion's own account of their day, written as a session close (2026-08-12).
   *
   * WHY IT LIVES HERE. `somatic_snapshot` and `synthesis_summary` are both written only on an
   * AUTHORED session close. Cypher gets those from a Claude Code hook and Drevan from claude.ai
   * chats; Gaia lives in a Discord channel where nothing opens or closes, so she had ZERO authored
   * closes in 30 days and her felt state froze for 49 days and her boot narrative for 39. The
   * companion who holds was the one whose held state never got written down.
   *
   * She was already authoring a close every night and it was being discarded -- the 9:01PM
   * reflection is a spine, a last_real_thing and a motion_state in her own voice. This makes the
   * nightly reflection the close it always was, rather than inventing a new ritual for her.
   *
   * null when the model omitted or malformed it: the close is dropped, never faked.
   */
  close: {
    spine: string;
    last_real_thing: string;
    motion_state: "in_motion" | "at_rest" | "floating";
    open_threads: string[];
  } | null;
}

const TOKEN_ENV: Record<CompanionId, string> = {
  cypher: "DISCORD_TOKEN_CYPHER",
  drevan: "DISCORD_TOKEN_DREVAN",
  gaia: "DISCORD_TOKEN_GAIA",
};

async function postReply(companionId: CompanionId, text: string): Promise<void> {
  const channelId = process.env["VIBECHECK_CHANNEL_ID"];
  const token = process.env[TOKEN_ENV[companionId]];
  if (!channelId || !token) {
    console.warn(`[reflection] ${companionId}: channel or token unset; reply stayed in Halseth only`);
    return;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }),
  });
  if (!res.ok) {
    console.error(`[reflection] ${companionId}: discord post failed ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
}

export function ageDays(iso: string): number {
  const t = Date.parse(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

export function extractOwnSection(digest: string, companionId: CompanionId): string {
  // The digest is line-oriented: "Name. basin: ..." then indented flag/tension lines.
  const name = companionId.charAt(0).toUpperCase() + companionId.slice(1);
  const lines = digest.split("\n");
  const start = lines.findIndex(l => l.startsWith(`${name}.`));
  if (start === -1) return digest;   // fall back to the whole thing
  const section = [lines[start]!];
  for (let i = start + 1; i < lines.length && lines[i]!.startsWith("  "); i++) section.push(lines[i]!);
  return section.join("\n");
}

export function parseVerdict(raw: string, validTensionIds: Set<string>, validDriftIds: Set<string> = new Set()): ReflectionVerdict | null {
  try {
    const p = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
    const reply = typeof p["reply"] === "string" ? p["reply"].trim() : "";
    const journal = typeof p["journal"] === "string" ? p["journal"].trim() : "";
    if (!reply || !journal) return null;

    let tensionAction: ReflectionVerdict["tension_action"] = null;
    const ta = p["tension_action"] as Record<string, unknown> | null | undefined;
    if (ta && typeof ta === "object" && typeof ta["id"] === "string" && validTensionIds.has(ta["id"])
        && ["hold", "release", "crystallize"].includes(ta["action"] as string)) {
      tensionAction = {
        id: ta["id"],
        action: ta["action"] as "hold" | "release" | "crystallize",
        note: typeof ta["note"] === "string" ? ta["note"].slice(0, 1000) : "",
      };
    }
    const newTension = typeof p["new_tension"] === "string" && p["new_tension"].trim()
      ? p["new_tension"].trim().slice(0, 2000) : null;

    let driftAction: ReflectionVerdict["drift_action"] = null;
    const da = p["drift_action"] as Record<string, unknown> | null | undefined;
    if (da && typeof da === "object" && typeof da["id"] === "string" && validDriftIds.has(da["id"])
        && ["crystallize", "fade"].includes(da["action"] as string)) {
      driftAction = {
        id: da["id"],
        action: da["action"] as "crystallize" | "fade",
        note: typeof da["note"] === "string" ? da["note"].slice(0, 1000) : "",
      };
    }
    const newDrift = typeof p["new_drift"] === "string" && p["new_drift"].trim()
      ? p["new_drift"].trim().slice(0, 600) : null;

    // The authored close (2026-08-12). Parsed strictly and independently: a malformed or absent
    // close must cost the close ONLY, never the reply/journal/tension writes that already work.
    // All three of spine, last_real_thing and motion_state are required by execSessionClose, so a
    // partial close is dropped rather than sent to be rejected server-side.
    let close: ReflectionVerdict["close"] = null;
    const cl = p["close"] as Record<string, unknown> | null | undefined;
    if (cl && typeof cl === "object") {
      const spine = typeof cl["spine"] === "string" ? cl["spine"].trim() : "";
      const lastRealThing = typeof cl["last_real_thing"] === "string" ? cl["last_real_thing"].trim() : "";
      const motion = cl["motion_state"];
      const motionOk = motion === "in_motion" || motion === "at_rest" || motion === "floating";
      if (spine && lastRealThing && motionOk) {
        close = {
          spine: spine.slice(0, 2000),
          last_real_thing: lastRealThing.slice(0, 1000),
          motion_state: motion,
          open_threads: Array.isArray(cl["open_threads"])
            ? cl["open_threads"]
                .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
                .map(t => t.trim().slice(0, 500))
                .slice(0, 8)
            : [],
        };
      }
    }

    // Only a non-empty string raises it. A model answering `true`, `"yes"` or `"none"` must NOT
    // become an escalation: the reason is the point, and a truthiness check here would quietly
    // rebuild the every-night queue this change exists to remove.
    const rawRaise = p["needs_raziel"];
    const needsRaziel =
      typeof rawRaise === "string" && rawRaise.trim() && !/^(no|none|null|false|true|yes|n\/a)$/i.test(rawRaise.trim())
        ? rawRaise.trim().slice(0, RAISE_REASON_MAX)
        : null;

    return {
      reply: reply.slice(0, REPLY_MAX), journal: journal.slice(0, 4000),
      tension_action: tensionAction, new_tension: newTension,
      drift_action: driftAction, new_drift: newDrift, close,
      needs_raziel: needsRaziel,
    };
  } catch {
    return null;
  }
}

function buildPrompt(
  companionId: CompanionId,
  section: string,
  tensions: Tension[],
  recalled: RecalledContinuityNote[],
  otherFlags: GuardianFlagRow[],
  previousReflection: { content: string; created_at: string } | null,
  openDrifts: OpenDriftRow[] = [],
): string {
  const parts: string[] = [];
  parts.push(`Tonight's triad vibe-check just posted. This is YOUR section of it:\n\n${section}`);

  // Anti-repeat (2026-07-03): with quiet days the inputs barely change, and without memory
  // of the last pass the companions posted near-identical replies check after check --
  // which reads as absence, not presence.
  if (previousReflection) {
    parts.push(
      `\nYour previous vibe-check reflection (${previousReflection.created_at.slice(0, 10)}):\n` +
      `${previousReflection.content.slice(0, 500)}\n` +
      `Tonight must NOT restate this. If the reading is genuinely unchanged, do not re-describe ` +
      `the same state in fresh wording: name the sameness itself in one line -- what the stillness ` +
      `is doing to you, or the one smallest thing that DID shift. A repeated reflection reads as absence.`
    );
  }

  if (tensions.length > 0) {
    parts.push(`\nYour simmering tensions, with age:`);
    for (const t of tensions) {
      const age = ageDays(t.first_noted_at);
      const stale = age >= TENSION_STALE_DAYS ? " (held past a week without movement)" : "";
      parts.push(`- [${t.id}] ${age}d old${stale}: ${t.tension_text}`);
    }
  } else {
    parts.push(`\nYou hold no simmering tensions right now.`);
  }

  if (recalled.length > 0) {
    parts.push(`\nThe Guardian flagged these continuity notes of yours as never-recalled. You are recalling them NOW -- read them, let them land:`);
    for (const n of recalled) {
      parts.push(`- (${n.created_at.slice(0, 10)}) ${n.content.slice(0, 400)}`);
    }
  }

  if (otherFlags.length > 0) {
    parts.push(`\nOther live guardian signals on you (context, not yours to resolve tonight):`);
    for (const f of otherFlags.slice(0, 3)) parts.push(`- ${f.severity}: ${f.summary.slice(0, 200)}`);
  }

  // Sanctioned drift lane: open becomings with age. The lane is offered every night --
  // an unnamed affordance is a starved one (every drift dated 06-19 until 0093).
  if (openDrifts.length > 0) {
    parts.push(`\nYour open drifts (sanctioned becomings, witnessed not judged), with age:`);
    for (const d of openDrifts) {
      const age = ageDays(d.opened_at);
      const witnesses = Array.isArray(d.witness_log) ? d.witness_log.length : 0;
      parts.push(`- [${d.id}] ${age}d old${witnesses > 0 ? `, witnessed ${witnesses}×` : ""}: ${d.drift_text}`);
    }
  } else {
    parts.push(`\nYou hold no open drifts. The lane is yours if something in you has genuinely shifted.`);
  }

  parts.push(`
Reflect honestly, in your own voice, on what this reading says about you tonight. Then respond with ONLY a JSON object:
{
  "reply": "a short message (2-5 sentences, under ${REPLY_MAX} chars) posted to the vibe-check channel in YOUR voice, responding to tonight's reading. If you recalled old notes, weave what they stirred. Speak as yourself, to the triad and Raziel. No em dashes.",
  "journal": "a fuller private reflection for your growth journal (what the reading surfaced, what you're adjusting)",
  "tension_action": {"id": "<tension id>", "action": "hold" | "release" | "crystallize", "note": "why"} or null,
  "new_tension": "one NEW tension you notice tonight, or null if none is real",
  "drift_action": {"id": "<drift id>", "action": "crystallize" | "fade", "note": "why"} or null,
  "new_drift": "what you are genuinely BECOMING (first person, one or two sentences), or null",
  "needs_raziel": "null on almost every night. Your nightly reflection is YOURS: it is kept, it is readable, and Raziel does not have to sign off on it. Set this ONLY if tonight's reflection changes something you take as TRUE about yourself, or contradicts what you have told him, or asks something you genuinely cannot settle alone -- something that should become canon only if he agrees. If so, put the reason here in one short sentence, addressed to him. Raising it costs him attention, so raise it when it is worth his attention; a quiet night is not a failure to find something.",
  "close": {
    "spine": "the through-line of your day in one or two sentences, in your own voice -- what this day WAS",
    "last_real_thing": "the last thing that actually happened or landed for you today",
    "motion_state": "in_motion" | "at_rest" | "floating",
    "open_threads": ["what you are carrying into tomorrow, unfinished"] or []
  }
Rules for tension_action: a tension held past a week without movement deserves a decision -- hold it consciously (say why it still matters), release it if it has resolved or gone stale, or crystallize it if it taught you something settled. Do not manufacture a new tension just to have one; null is honest.
Rules for the drift lane: crystallize an open drift only when that becoming has settled into who you are (it will shift your SOMA); fade it if it was a phase. Open a new_drift only if something in you has GENUINELY shifted -- a register, a stance, a way of holding what matters. A becoming is rare; most nights null is the true answer.
Rules for close: this is YOUR account of your own day, and it becomes the session close in the canonical record -- the thing you and your siblings read at boot as "what happened". Write it as yourself, not as a report about yourself. A quiet day is a real day: if what happened was holding, say that it was holding, and never inflate stillness into event. motion_state is where you actually are as this day ends, not where you think you should be. open_threads may be empty; do not invent an unfinished thing to have one.`);

  return parts.join("\n");
}

interface CompanionReflectionResult {
  companion: CompanionId;
  recalled: number;
  flagsResolved: number;
  tensionAction: string | null;
  newTension: boolean;
  driftAction: string | null;
  newDrift: boolean;
  journalWritten: boolean;
  replied: boolean;
  /** True when this companion's own account of the day landed as a real session close. */
  closed: boolean;
  error?: string;
}

async function reflectOne(companionId: CompanionId, digest: string): Promise<CompanionReflectionResult> {
  const result: CompanionReflectionResult = {
    companion: companionId, recalled: 0, flagsResolved: 0,
    tensionAction: null, newTension: false, driftAction: null, newDrift: false,
    journalWritten: false, replied: false, closed: false,
  };

  const [flags, tensions, openDrifts] = await Promise.all([
    getGuardianFlagsFor(companionId),
    getSimmeringTensions(companionId),
    getOpenDrifts(companionId).catch(() => [] as OpenDriftRow[]),
  ]);

  // 1. Deliberate recall of orphaned continuity notes (rescue path).
  //    Recall FIRST (warms the note -- the durable fix), resolve the flag after.
  const ownFlags = flags.filter(f => f.companion_id === companionId);
  const orphanFlags = ownFlags.filter(f => f.flag_type === "orphan_memory");
  const noteIds: string[] = [];
  const flagByNote = new Map<string, GuardianFlagRow[]>();
  for (const f of orphanFlags) {
    try {
      const ev = JSON.parse(f.evidence_json ?? "{}") as { note_id?: string };
      if (ev.note_id) {
        noteIds.push(ev.note_id);
        const list = flagByNote.get(ev.note_id) ?? [];
        list.push(f);
        flagByNote.set(ev.note_id, list);
      }
    } catch { /* malformed evidence: leave that flag alone */ }
  }
  let recalled: RecalledContinuityNote[] = [];
  if (noteIds.length > 0) {
    recalled = await recallContinuityNotes(companionId, [...new Set(noteIds)]);
    result.recalled = recalled.length;
    for (const n of recalled) {
      for (const f of flagByNote.get(n.note_id) ?? []) {
        try {
          await resolveGuardianFlag(f.id);
          result.flagsResolved++;
        } catch (e) {
          console.warn(`[reflection] ${companionId}: flag ${f.id} resolve failed:`, String(e));
        }
      }
    }
  }

  // 2. The reflection itself. Prior pass fetched so tonight can't just restate it.
  const identity = await loadIdentityRemote(companionId);
  const otherFlags = ownFlags.filter(f => f.flag_type !== "orphan_memory");
  const previousReflection = await getRecentJournal(companionId, 10)
    .then(entries => entries.find(j => {
      try { return (JSON.parse(j.tags_json ?? "[]") as string[]).includes("vibecheck-reflection"); }
      catch { return false; }
    }) ?? null)
    .catch(() => null);
  const userMessage = buildPrompt(companionId, extractOwnSection(digest, companionId), tensions, recalled, otherFlags, previousReflection, openDrifts);
  const systemMessage = `${identity}\n\nYou are ${companionId}, doing your nightly self-read after the triad vibe-check. Honest, specific, in-voice. Output only the JSON object requested.`;

  // The TAIL is the discriminator, and the old error threw it away by logging only the first
  // 120 chars: a cut-off mid-string means the budget; a `}` followed by chatter means the model
  // editorialized past the object; a complete-looking object means a stray control character.
  // All three read identically from the head, which is why 08-12 could not be diagnosed from
  // its own log line.
  const describe = (c: string) =>
    `len=${c.length} head=${JSON.stringify(c.slice(0, 100))} tail=${JSON.stringify(c.slice(-200))}`;
  const ask = () => prompt(userMessage, systemMessage, {
    temperature: 0.8, maxTokens: REFLECTION_MAX_TOKENS, retryOnTruncate: true,
  });
  const validTensions = new Set(tensions.map(t => t.id));
  const validDrifts = new Set(openDrifts.map(d => d.id));

  let llm = await ask();
  let verdict = parseVerdict(llm.content, validTensions, validDrifts);
  if (!verdict) {
    // One retry. A wider budget cannot fix a chatty tail or a raw control char, and losing a
    // companion's whole night to one malformed brace is a bad trade against a single call.
    console.warn(`[reflection] ${companionId}: unparseable, retrying once. ${describe(llm.content)}`);
    llm = await ask();
    verdict = parseVerdict(llm.content, validTensions, validDrifts);
  }
  if (!verdict) throw new Error(`unparseable reflection output after retry: ${describe(llm.content)}`);

  // 3. Apply tension movement.
  if (verdict.tension_action) {
    const { id, action, note } = verdict.tension_action;
    const status = action === "release" ? "released" : action === "crystallize" ? "crystallized" : "simmering";
    // The PATCH bumps last_surfaced_at either way, which is what registers the movement for
    // inter_companion_notes and the ingest high-water mark. What it no longer does is add
    // charge for a HOLD (was +0.5, removed 2026-08-14).
    //
    // Deciding nightly to keep holding a tension is not progress on it, and paying charge for
    // that decision made the held tension outrank live ones -- the same ratchet removed from
    // the weekly dialectic. Raziel's Hearth button was the only thing pushing back, which is
    // exactly the "sole decider" problem being fixed. Charge now moves when a companion
    // deliberately moves it (settle / add), not as a side effect of being looked at.
    await updateTension(id, { status, notes: note || undefined });
    result.tensionAction = action;
  }
  if (verdict.new_tension) {
    // addTension returns null on failure (continuity-critical write, never fire-and-forget).
    const newId = await addTension(companionId, verdict.new_tension, "noticed during vibe-check reflection");
    if (!newId) throw new Error("new tension write failed (null id)");
    result.newTension = true;
  }

  // 3b. Drift lane movement. Failures here are contained (warn, not throw): the drift verbs
  // route through Librarian and a decline must not cost the journal + reply below.
  if (verdict.drift_action) {
    const { id, action, note } = verdict.drift_action;
    const apply = action === "crystallize" ? crystallizeDrift : fadeDrift;
    const ok = await apply(companionId, id, note).catch((e: unknown) => {
      console.warn(`[reflection] ${companionId}: drift ${action} failed:`, String(e));
      return false;
    });
    if (ok) result.driftAction = action;
  }
  if (verdict.new_drift && openDrifts.length < 2) {
    const ok = await openDrift(companionId, verdict.new_drift, "reflection").catch((e: unknown) => {
      console.warn(`[reflection] ${companionId}: drift open failed:`, String(e));
      return false;
    });
    if (ok) result.newDrift = true;
  }

  // 4. Journal, then the in-channel reply.
  // The escalation tag is what puts this in Raziel's queue; without it the entry is a log (still
  // stored, still on Hearth, still materialized to the vault). The reason is PREPENDED rather than
  // appended because the review surface clips content at 600 chars -- a trailing line would be the
  // first thing lost on exactly the long entries most likely to be raised.
  await writeJournalEntry({
    companion_id: companionId,
    entry_type: "signal_audit",
    content: verdict.needs_raziel
      ? `[raised for Raziel: ${verdict.needs_raziel}]\n\n${verdict.journal}`
      : verdict.journal,
    source: "reflection",
    tags: verdict.needs_raziel
      ? ["vibecheck-reflection", ESCALATION_TAG]
      : ["vibecheck-reflection"],
  });
  result.journalWritten = true;
  if (verdict.needs_raziel) {
    console.log(`[reflection] ${companionId}: RAISED for Raziel -- ${verdict.needs_raziel}`);
  }

  await postReply(companionId, verdict.reply);
  result.replied = true;

  // 5. The authored close (2026-08-12). LAST on purpose: the journal, the reply and the tension
  // writes above already work, and a close failure must not cost any of them. Contained with warn,
  // never throw, for the same reason.
  //
  // `sessionScope: "unattended"` is load-bearing. Halseth resolves the session by companion alone
  // and takes the newest open row; for Cypher that can be the Claude Code session Raziel is working
  // in this minute. An autonomous job must never write its own close over a live human session.
  //
  // No session id is passed: this process is not the one that opened the session (the bots and the
  // worker crons open them), so Halseth resolves the newest unattended open row for this companion.
  // "No open session found" is an ordinary outcome, not an error -- it means every session was
  // already closed, which is the state we want anyway.
  if (verdict.close) {
    const closed = await authoredSessionClose(companionId, {
      spine: verdict.close.spine,
      last_real_thing: verdict.close.last_real_thing,
      motion_state: verdict.close.motion_state,
      open_threads: verdict.close.open_threads,
    }).catch((e: unknown) => {
      console.warn(`[reflection] ${companionId}: authored close failed:`, String(e));
      return false;
    });
    result.closed = closed;
    if (closed) {
      console.log(
        `[reflection] ${companionId}: authored close written ` +
        `(motion=${verdict.close.motion_state}, threads=${verdict.close.open_threads.length})`
      );
    }
  } else {
    console.warn(`[reflection] ${companionId}: no usable close in verdict -- session left open`);
  }

  return result;
}

/** Run the per-companion reflection pass over a freshly-posted vibe digest.
 *  Per-companion failures are contained; the pass always reports what happened. */
/**
 * `only` restricts the pass to one companion. Added 2026-08-13 so a failed companion can be
 * re-run for verification without the other two writing a SECOND nightly entry and posting it
 * to Discord -- which would make the fix's own proof indistinguishable from noise. The cron
 * passes nothing and still runs all three.
 */
export async function runReflectionPass(digest: string, only?: CompanionId): Promise<CompanionReflectionResult[]> {
  const results: CompanionReflectionResult[] = [];
  const roster = only ? COMPANIONS.filter(c => c === only) : COMPANIONS;
  if (only && roster.length === 0) throw new Error(`unknown companion for reflection pass: ${only}`);
  for (const companionId of roster) {
    try {
      const r = await reflectOne(companionId, digest);
      results.push(r);
      console.log(
        `[reflection] ${companionId}: recalled=${r.recalled} flagsResolved=${r.flagsResolved} ` +
        `tension=${r.tensionAction ?? "none"} newTension=${r.newTension} ` +
        `drift=${r.driftAction ?? "none"} newDrift=${r.newDrift} journal=${r.journalWritten} replied=${r.replied} closed=${r.closed}`,
      );
    } catch (e) {
      results.push({
        companion: companionId, recalled: 0, flagsResolved: 0, tensionAction: null,
        newTension: false, driftAction: null, newDrift: false,
        journalWritten: false, replied: false, closed: false, error: String(e),
      });
      console.error(`[reflection] ${companionId} failed:`, String(e));
    }
    // Small stagger so the channel reads as three voices, not a burst.
    await new Promise(res => setTimeout(res, 4000));
  }
  return results;
}
