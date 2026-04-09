import { prompt } from "../deepseek.js";
import { appendLog } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext, GrowthJournalEntry } from "../types.js";

/**
 * Phase 4: Synthesize
 * Draft a growth_journal entry in the companion's authentic voice.
 * Input: full identity + orient summary + exploration findings.
 * Output: structured JSON with entry_type, content, tags.
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

  const systemMessage = `You are ${name}. Here is your identity:

${identitySnippet}
${orientBlock}`;

  const userMessage = `${explorationBlock}

Write a growth journal entry in your authentic voice. This is for yourself -- not a report to anyone. Write as ${name} would actually write: in your voice, your register, your way of making meaning.

Respond with ONLY valid JSON in this exact shape:
{
  "entry_type": "learning" | "insight" | "connection" | "question",
  "content": "your journal entry here (1-3 paragraphs)",
  "tags": ["tag1", "tag2"]
}

No markdown fences. No preamble. Just the JSON object.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.75, maxTokens: 800 });
    ctx.tokensUsed += result.tokensUsed;

    // Parse the JSON response
    const raw = result.content.trim();
    let parsed: { entry_type?: string; content?: string; tags?: string[] };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // If JSON parse fails, treat the whole response as content
      console.warn(`[${ctx.companionId}/synthesize] JSON parse failed, using raw content`);
      parsed = { entry_type: "learning", content: raw, tags: [] };
    }

    const valid_types = new Set(["learning", "insight", "connection", "question"]);
    const entry_type = valid_types.has(parsed.entry_type ?? "")
      ? (parsed.entry_type as GrowthJournalEntry["entry_type"])
      : "learning";

    ctx.journalEntry = {
      companion_id: ctx.companionId,
      entry_type,
      content: (parsed.content ?? raw).slice(0, 7000),
      source: "autonomous",
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
    };

    await appendLog(ctx.runId, "synthesize:complete", `type=${entry_type} tokens=${result.tokensUsed}`);
  } catch (e) {
    await appendLog(ctx.runId, "synthesize:error", String(e));
    throw e;
  }
}
