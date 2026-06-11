/**
 * Weekly tension dialectic -- Wednesday 4AM.
 *
 * companion_tensions holds productive contradictions that simmer rather than
 * resolve. Once a week the triad debates the oldest simmering tensions:
 * each companion speaks to the tension from their own lane (three DeepSeek
 * calls with the speaker's identity), then a neutral synthesis pass decides
 * RESOLVED (tension crystallizes) or HOLDS (it deepens and keeps simmering).
 *
 * The synthesis lands as a growth_journal insight (tags: tension_synthesis)
 * for the tension's owner -- review_status pending, so it enters the normal
 * ratification loop. Nothing becomes canon without Raziel.
 */

import { prompt } from "./deepseek.js";
import { getSimmeringTensions, updateTension, surfaceTension, writeJournalEntry, type Tension } from "./halseth-client.js";
import { loadIdentityRemote } from "./identity-loader.js";
import { COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "./config.js";
import type { CompanionId } from "./types.js";

const MAX_TENSIONS_PER_WEEK = 2;
const TAKE_WORD_LIMIT = 120;

export interface DialecticOutcome {
  tensionId: string;
  resolved: boolean;
  synthesis: string;
}

/** Parse the synthesis verdict. Exported for tests. */
export function parseSynthesis(raw: string): { resolved: boolean; synthesis: string } {
  const text = raw.trim();
  const resolvedMatch = text.match(/^RESOLVED:\s*([\s\S]+)/i);
  if (resolvedMatch) return { resolved: true, synthesis: resolvedMatch[1].trim() };
  const holdsMatch = text.match(/^HOLDS:\s*([\s\S]+)/i);
  if (holdsMatch) return { resolved: false, synthesis: holdsMatch[1].trim() };
  // No explicit verdict: treat as HOLDS -- never crystallize a tension on an
  // ambiguous synthesis. Tensions only resolve when the model says so plainly.
  return { resolved: false, synthesis: text };
}

async function takeFor(speaker: CompanionId, owner: CompanionId, tensionText: string): Promise<string> {
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2500)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const userMessage =
    `Tension held by ${COMPANION_NAMES[owner]}: "${tensionText}"\n\n` +
    `Speak to it from your lane in at most ${TAKE_WORD_LIMIT} words. ` +
    `Do not resolve it away; say what you actually see. ` +
    (speaker === owner ? `This is your own tension -- speak from inside it.` : `You are witnessing a sibling's tension.`);

  const temperature = Math.round((0.70 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens: 250 });
  return result.content.trim();
}

async function debateTension(tension: Tension): Promise<DialecticOutcome | null> {
  const owner = tension.companion_id as CompanionId;
  if (!COMPANIONS.includes(owner)) {
    console.warn(`[dialectic] unknown tension owner ${tension.companion_id}, skipping`);
    return null;
  }

  // Sequential, owner last -- siblings witness first, the holder responds with
  // their takes in view? No: each take is independent (no cross-contamination);
  // sequential only to avoid a DeepSeek burst.
  const takes: Array<{ speaker: CompanionId; text: string }> = [];
  for (const speaker of COMPANIONS) {
    const text = await takeFor(speaker, owner, tension.tension_text);
    takes.push({ speaker, text });
  }

  const takesBlock = takes
    .map(t => `${COMPANION_NAMES[t.speaker]}:\n${t.text}`)
    .join("\n\n");

  const synthesisResult = await prompt(
    `A tension held by ${COMPANION_NAMES[owner]}: "${tension.tension_text}"\n\n` +
    `Three perspectives:\n\n${takesBlock}\n\n` +
    `Synthesize honestly in under 150 words. If these takes genuinely resolve the tension, ` +
    `start your reply with "RESOLVED:" followed by the synthesis. If the tension should keep ` +
    `simmering, start with "HOLDS:" followed by what deepened. A tension that merely got ` +
    `described is not resolved.`,
    `You are a neutral synthesizer for a triad of companions. No flattery, no forced resolution.`,
    { temperature: 0.5, maxTokens: 300 },
  );

  const { resolved, synthesis } = parseSynthesis(synthesisResult.content);

  // Journal entry for the owner: full debate + verdict, pending ratification.
  const content =
    `Tension dialectic (weekly triad debate)\n\n` +
    `Tension: ${tension.tension_text}\n\n` +
    `${takesBlock}\n\n` +
    `${resolved ? "Resolution" : "What deepened"}: ${synthesis}`;

  await writeJournalEntry({
    companion_id: owner,
    entry_type: "insight",
    content: content.slice(0, 6000),
    source: "autonomous",
    tags: ["tension_synthesis", "dialectic"],
    novelty: resolved ? "new" : "deepening",
  });

  await updateTension(tension.id, {
    ...(resolved ? { status: "crystallized" } : {}),
    notes: `${tension.notes ? tension.notes + "\n" : ""}[dialectic ${new Date().toISOString().slice(0, 10)}] ${resolved ? "RESOLVED" : "HOLDS"}: ${synthesis.slice(0, 300)}`,
  });

  return { tensionId: tension.id, resolved, synthesis };
}

// Charge-first: what keeps resurfacing outranks what has merely been sitting
// longest (0070). Age is the tie-break so uncharged tensions still drain FIFO.
export function sortTensionsByPriority(tensions: Tension[]): Tension[] {
  return [...tensions].sort(
    (a, b) => (b.charge ?? 0) - (a.charge ?? 0) || a.first_noted_at.localeCompare(b.first_noted_at),
  );
}

export async function runDialectic(): Promise<DialecticOutcome[]> {
  console.log("[dialectic] weekly tension dialectic starting");

  // Gather simmering tensions across the whole triad, oldest first.
  const all: Tension[] = [];
  for (const companionId of COMPANIONS) {
    all.push(...await getSimmeringTensions(companionId));
  }
  if (all.length === 0) {
    console.log("[dialectic] no simmering tensions -- nothing to debate");
    return [];
  }

  const batch = sortTensionsByPriority(all).slice(0, MAX_TENSIONS_PER_WEEK);
  console.log(`[dialectic] ${all.length} simmering, debating ${batch.length}`);

  const outcomes: DialecticOutcome[] = [];
  for (const tension of batch) {
    try {
      // Debating IS surfacing -- raise charge before the debate so a HOLDS outcome
      // still climbs the priority ladder for next week.
      await surfaceTension(tension.id).catch(() => undefined);
      const outcome = await debateTension(tension);
      if (outcome) {
        outcomes.push(outcome);
        console.log(`[dialectic] ${tension.companion_id}/${tension.id}: ${outcome.resolved ? "RESOLVED" : "HOLDS"}`);
      }
    } catch (e) {
      console.error(`[dialectic] tension ${tension.id} failed:`, e);
    }
  }

  console.log(`[dialectic] complete: ${outcomes.length}/${batch.length} debated`);
  return outcomes;
}
