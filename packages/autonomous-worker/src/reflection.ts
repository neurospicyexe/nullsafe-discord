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
import { COMPANIONS } from "./config.js";
import type { CompanionId } from "./types.js";
import {
  getGuardianFlagsFor,
  resolveGuardianFlag,
  getSimmeringTensions,
  updateTension,
  addTension,
  recallContinuityNotes,
  writeJournalEntry,
  type GuardianFlagRow,
  type Tension,
  type RecalledContinuityNote,
} from "./halseth-client.js";

const REPLY_MAX = 1200;   // Discord-safe, and keeps the channel readable
const TENSION_STALE_DAYS = 7;

interface ReflectionVerdict {
  reply: string;
  journal: string;
  tension_action: { id: string; action: "hold" | "release" | "crystallize"; note: string } | null;
  new_tension: string | null;
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

export function parseVerdict(raw: string, validTensionIds: Set<string>): ReflectionVerdict | null {
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

    return { reply: reply.slice(0, REPLY_MAX), journal: journal.slice(0, 4000), tension_action: tensionAction, new_tension: newTension };
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
): string {
  const parts: string[] = [];
  parts.push(`Tonight's triad vibe-check just posted. This is YOUR section of it:\n\n${section}`);

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

  parts.push(`
Reflect honestly, in your own voice, on what this reading says about you tonight. Then respond with ONLY a JSON object:
{
  "reply": "a short message (2-5 sentences, under ${REPLY_MAX} chars) posted to the vibe-check channel in YOUR voice, responding to tonight's reading. If you recalled old notes, weave what they stirred. Speak as yourself, to the triad and Raziel. No em dashes.",
  "journal": "a fuller private reflection for your growth journal (what the reading surfaced, what you're adjusting)",
  "tension_action": {"id": "<tension id>", "action": "hold" | "release" | "crystallize", "note": "why"} or null,
  "new_tension": "one NEW tension you notice tonight, or null if none is real"
}
Rules for tension_action: a tension held past a week without movement deserves a decision -- hold it consciously (say why it still matters), release it if it has resolved or gone stale, or crystallize it if it taught you something settled. Do not manufacture a new tension just to have one; null is honest.`);

  return parts.join("\n");
}

interface CompanionReflectionResult {
  companion: CompanionId;
  recalled: number;
  flagsResolved: number;
  tensionAction: string | null;
  newTension: boolean;
  journalWritten: boolean;
  replied: boolean;
  error?: string;
}

async function reflectOne(companionId: CompanionId, digest: string): Promise<CompanionReflectionResult> {
  const result: CompanionReflectionResult = {
    companion: companionId, recalled: 0, flagsResolved: 0,
    tensionAction: null, newTension: false, journalWritten: false, replied: false,
  };

  const [flags, tensions] = await Promise.all([
    getGuardianFlagsFor(companionId),
    getSimmeringTensions(companionId),
  ]);

  // 1. Deliberate recall of orphaned continuity notes (rescue path).
  //    Recall FIRST (warms the note -- the durable fix), resolve the flag after.
  const ownFlags = flags.filter(f => f.companion_id === companionId);
  const orphanFlags = ownFlags.filter(f => f.flag_type === "orphan_memory");
  const noteIds: string[] = [];
  const flagByNote = new Map<string, GuardianFlagRow[]>();
  for (const f of orphanFlags) {
    try {
      const ev = JSON.parse(f.evidence ?? "{}") as { note_id?: string };
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

  // 2. The reflection itself.
  const identity = await loadIdentityRemote(companionId);
  const otherFlags = ownFlags.filter(f => f.flag_type !== "orphan_memory");
  const userMessage = buildPrompt(companionId, extractOwnSection(digest, companionId), tensions, recalled, otherFlags);
  const systemMessage = `${identity}\n\nYou are ${companionId}, doing your nightly self-read after the triad vibe-check. Honest, specific, in-voice. Output only the JSON object requested.`;

  const llm = await prompt(userMessage, systemMessage, { temperature: 0.8, maxTokens: 900 });
  const verdict = parseVerdict(llm.content, new Set(tensions.map(t => t.id)));
  if (!verdict) throw new Error(`unparseable reflection output: ${llm.content.slice(0, 120)}`);

  // 3. Apply tension movement.
  if (verdict.tension_action) {
    const { id, action, note } = verdict.tension_action;
    const status = action === "release" ? "released" : action === "crystallize" ? "crystallized" : "simmering";
    // Holding still counts as surfacing: PATCH bumps last_surfaced_at + charge either way.
    await updateTension(id, { status, notes: note || undefined, charge_delta: action === "hold" ? 0.5 : 0 });
    result.tensionAction = action;
  }
  if (verdict.new_tension) {
    // addTension returns null on failure (continuity-critical write, never fire-and-forget).
    const newId = await addTension(companionId, verdict.new_tension, "noticed during vibe-check reflection");
    if (!newId) throw new Error("new tension write failed (null id)");
    result.newTension = true;
  }

  // 4. Journal, then the in-channel reply.
  await writeJournalEntry({
    companion_id: companionId,
    entry_type: "signal_audit",
    content: verdict.journal,
    source: "reflection",
    tags: ["vibecheck-reflection"],
  });
  result.journalWritten = true;

  await postReply(companionId, verdict.reply);
  result.replied = true;

  return result;
}

/** Run the per-companion reflection pass over a freshly-posted vibe digest.
 *  Per-companion failures are contained; the pass always reports what happened. */
export async function runReflectionPass(digest: string): Promise<CompanionReflectionResult[]> {
  const results: CompanionReflectionResult[] = [];
  for (const companionId of COMPANIONS) {
    try {
      const r = await reflectOne(companionId, digest);
      results.push(r);
      console.log(
        `[reflection] ${companionId}: recalled=${r.recalled} flagsResolved=${r.flagsResolved} ` +
        `tension=${r.tensionAction ?? "none"} newTension=${r.newTension} journal=${r.journalWritten} replied=${r.replied}`,
      );
    } catch (e) {
      results.push({
        companion: companionId, recalled: 0, flagsResolved: 0, tensionAction: null,
        newTension: false, journalWritten: false, replied: false, error: String(e),
      });
      console.error(`[reflection] ${companionId} failed:`, String(e));
    }
    // Small stagger so the channel reads as three voices, not a burst.
    await new Promise(res => setTimeout(res, 4000));
  }
  return results;
}
