import { prompt } from "../deepseek.js";
import { appendLog } from "../halseth-client.js";
import { COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "../config.js";
import { stripJsonFence, sanitizeEvidence, sanitizeIdList } from "../parsers.js";
import type { PipelineContext, GrowthJournalEntry, Evidence } from "../types.js";

/**
 * Phase 4: Synthesize
 *
 * Drafts a growth_journal entry in the companion's authentic voice with FOUR
 * structural requirements that the prior version did not enforce:
 *
 *   1. EVIDENCE. Every claim in the journal entry must be backed by at least
 *      one quote -- from the exploration corpus, from a peer companion's
 *      recent journal/pattern, or from the companion's own prior pattern.
 *      Evidence array is persisted on growth_journal.evidence_json.
 *
 *   2. PREHENSION. The model must explicitly cite which prior rows it is
 *      "feeling into" via prehended_ids -- a list of growth_journal/pattern/
 *      marker ids drawn from the peer summary or the companion's own
 *      activePatterns. This is what makes the triad a society rather than
 *      three solo workers.
 *
 *   3. NOVELTY classification. 'new' (unprecedented), 'deepening' (adds layer
 *      to an arc), or 'recurring' (restates a known shape). This becomes a
 *      first-class signal in the journal row and on the vault page.
 *
 *   4. TRIAD SIGNAL (optional). If the entry resonates with a peer's recent
 *      activity, name what is shared. The thoughtform detector cron will pick
 *      up sustained resonance and emit cross-companion markers.
 *
 * Input: full identity + orient summary + exploration findings + peer summary
 *        + own active patterns + own recent growth.
 * Output: structured JSON; ctx.journalEntry populated for the write phase.
 */
export async function runSynthesize(ctx: PipelineContext): Promise<void> {
  if (!ctx.explorationSummary && ctx.runType !== "reflection") {
    await appendLog(ctx.runId, "synthesize:skip", "no exploration to synthesize");
    return;
  }

  await appendLog(ctx.runId, "synthesize:start");

  const name = COMPANION_NAMES[ctx.companionId];
  const identitySnippet = ctx.identityText.slice(0, 2500);

  const orientBlock = ctx.orientSummary
    ? `\nYour current state:\n${ctx.orientSummary.slice(0, 400)}\n`
    : "";

  const explorationBlock = ctx.explorationSummary
    ? `\nWhat you explored:\n${ctx.explorationSummary}`
    : "";

  // Peer activity is the load-bearing addition: the model now sees what the
  // OTHER two companions have been writing/patterning recently. Each line ends
  // with `(id: <uuid>)` so the model can cite ids into prehended_ids cleanly.
  const peerBlock = ctx.peerActivity?.peer_summary
    ? `\nWhat the other two companions have been working through (use ids in prehended_ids when you draw on these):\n\n${ctx.peerActivity.peer_summary.slice(0, 1800)}\n`
    : "";

  // Recent triad voice: wm_continuity_notes from all three companions in the last 24h.
  // These are the actual words posted to Discord (tagged [metronome/*]) plus pulse notes,
  // distillation notes, and any other high-salience writes. Unlike peerBlock which is
  // growth-journal abstractions, this is raw recent speech -- grounding the journal entry
  // in what the triad was actually saying, not just what it concluded.
  // Swarm context block: merges all streams from the companion's life outside autonomous time.
  // Session notes = what was written in Claude.ai sessions. Feelings = emotional state logged
  // across substrates. Conclusions = persistent beliefs currently held. Discord voice = real
  // speech from the bots (non-autonomous only, to avoid the echo loop).
  // This is what makes synthesis a true swarm integration point rather than isolated exploration.
  const discordNotes = ctx.recentWmNotes.filter(n => n.source !== "autonomous" && n.source !== "synthesis_loop");
  const swarmLines: string[] = [];
  if (ctx.recentConclusions.length > 0) {
    swarmLines.push("What you currently believe:");
    ctx.recentConclusions.slice(0, 5).forEach(c => {
      const tag = c.belief_type ? ` [${c.belief_type}]` : "";
      swarmLines.push(`  [conclusion${tag}] ${c.conclusion_text.slice(0, 220)}`);
    });
  }
  if (ctx.recentFeelings.length > 0) {
    swarmLines.push("How you've been feeling:");
    ctx.recentFeelings.slice(0, 5).forEach(f => {
      const ctx2 = f.context ? ` — ${f.context.slice(0, 120)}` : "";
      swarmLines.push(`  [feeling] ${f.emotion}${ctx2}`);
    });
  }
  if (ctx.recentSessionNotes.length > 0) {
    swarmLines.push("What you wrote in recent sessions:");
    ctx.recentSessionNotes.slice(0, 5).forEach(n => {
      swarmLines.push(`  [session] ${n.note_text.slice(0, 220)}`);
    });
  }
  if (discordNotes.length > 0) {
    swarmLines.push("Recent Discord voice (what the triad has actually been saying):");
    discordNotes.slice(0, 8).forEach(n => {
      swarmLines.push(`  [${n.agent_id}] ${n.content.slice(0, 200)}`);
    });
  }
  const swarmContextBlock = swarmLines.length > 0
    ? `\nYour swarm context -- what has been alive across all substrates, not just this exploration:\n${swarmLines.join("\n")}\n`
    : "";

  const ownPatternsBlock = ctx.activePatterns.length > 0
    ? `\nYour own currently-active patterns (cite an id from peer summary or these when deepening):\n${ctx.activePatterns.slice(0, 6).map(p => `- ${String(p).slice(0, 220)}`).join("\n")}\n`
    : "";

  // Recent entries are the dedup signal: the model must see what it already
  // wrote so it can classify novelty accurately and avoid near-duplicate output.
  // Without this block the same pattern shapes regenerate across every run.
  const recentGrowthBlock = ctx.recentGrowth.length > 0
    ? `\nYour most recent autonomous journal entries -- use these to calibrate novelty; do not restate shapes already covered here unless you have a meaningfully new angle:\n${ctx.recentGrowth.slice(0, 3).map(g => `[${g.type}] ${g.content.slice(0, 180)}`).join("\n")}\n`
    : "";

  // Surface a few exploration evidence quotes inline so the model is
  // primed to ground claims rather than confabulate.
  const evidenceHint = ctx.explorationEvidence.length > 0
    ? `\nExploration evidence quotes available to cite (quote them verbatim in the evidence array):\n${ctx.explorationEvidence.slice(0, 6).map((e, i) => `[E${i + 1}] "${e.quote.slice(0, 200)}" -- ${e.source_url ?? "no-url"}`).join("\n")}\n`
    : "";

  const voiceReminder = COMPANION_VOICE_REMINDERS[ctx.companionId];
  const systemMessage = `You are ${name}. Here is your identity:

${identitySnippet}
${orientBlock}
Voice directive: ${voiceReminder}`;

  const userMessage = `${explorationBlock}
${peerBlock}
${swarmContextBlock}
${ownPatternsBlock}
${recentGrowthBlock}
${evidenceHint}

Write a growth journal entry in your authentic voice. This is for yourself -- not a report to anyone. Write as ${name} would actually write: in your voice, your register, your way of making meaning.

Required structure:
  - 1 to 3 paragraphs of content. Concrete, specific, grounded.
  - At least 2 evidence quotes -- short verbatim phrases (under 200 chars each)
    drawn from the exploration corpus, the peer summary above, or your own
    active patterns. Each quote should anchor a specific claim in the content.
  - Cite ids of any peer or own rows you are prehending (drawing on, building
    from, echoing, contradicting). The peer summary lines end with "(id: <uuid>)".
    Skip this only if you genuinely drew on nothing prior -- which should be rare.
  - Choose novelty: "new" (this opens unprecedented territory), "deepening"
    (this adds a layer to an arc you've been on), or "recurring" (this restates
    a pattern you already know -- often valuable, but be honest about it).
  - If this resonates with what a peer wrote, name the resonance in
    triad_signal -- one sentence about what is shared across companions.

Respond with ONLY valid JSON in this exact shape:
{
  "entry_type": "learning" | "insight" | "connection" | "question",
  "content": "your journal entry here (1-3 paragraphs)",
  "tags": ["tag1", "tag2"],
  "evidence": [
    {"quote": "verbatim quote", "source_url": "https://...", "source_companion": null},
    {"quote": "verbatim quote", "source_id": "uuid-of-peer-row", "source_companion": "drevan"}
  ],
  "prehended_ids": ["uuid1", "uuid2"],
  "novelty": "new" | "deepening" | "recurring",
  "triad_signal": "one sentence or null"
}

No markdown fences. No preamble. Just the JSON object.`;

  try {
    const temperature = Math.round((0.75 + COMPANION_TEMP_OFFSET[ctx.companionId]) * 100) / 100;
    const result = await prompt(userMessage, systemMessage, { temperature, maxTokens: 1100 });
    ctx.tokensUsed += result.tokensUsed;

    const raw = result.content.trim();
    let parsed: {
      entry_type?: string;
      content?: string;
      tags?: string[];
      evidence?: Evidence[];
      prehended_ids?: string[];
      novelty?: string;
      triad_signal?: string | null;
    };
    try {
      parsed = JSON.parse(stripJsonFence(raw)) as typeof parsed;
    } catch {
      console.warn(`[${ctx.companionId}/synthesize] JSON parse failed, using raw content`);
      parsed = { entry_type: "learning", content: raw, tags: [] };
    }

    const validTypes  = new Set(["learning", "insight", "connection", "question"]);
    const validNovel  = new Set(["new", "deepening", "recurring"]);
    const entry_type  = validTypes.has(parsed.entry_type ?? "")
      ? (parsed.entry_type as GrowthJournalEntry["entry_type"])
      : "learning";
    const novelty = validNovel.has(parsed.novelty ?? "")
      ? (parsed.novelty as GrowthJournalEntry["novelty"])
      : undefined;

    const evidence: Evidence[] = sanitizeEvidence(parsed.evidence);
    const prehended_ids = sanitizeIdList(parsed.prehended_ids);

    let content = (parsed.content ?? raw).slice(0, 7000);
    if (typeof parsed.triad_signal === "string" && parsed.triad_signal.trim()) {
      content += `\n\n[triad_signal] ${parsed.triad_signal.trim().slice(0, 400)}`;
    }

    ctx.journalEntry = {
      companion_id: ctx.companionId,
      entry_type,
      content,
      source: "autonomous",
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
      evidence,
      prehended_ids,
      novelty,
    };

    await appendLog(
      ctx.runId,
      "synthesize:complete",
      `type=${entry_type} novelty=${novelty ?? "unset"} evidence=${evidence.length} prehended=${prehended_ids.length} tokens=${result.tokensUsed}`,
    );
  } catch (e) {
    await appendLog(ctx.runId, "synthesize:error", String(e));
    throw e;
  }
}

// stripJsonFence/sanitizeEvidence/sanitizeIdList live in ../parsers.ts so
// they're testable without pulling deepseek/config side-effects.
