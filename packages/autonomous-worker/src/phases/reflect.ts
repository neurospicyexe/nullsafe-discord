import { prompt } from "../deepseek.js";
import { createReflection, createSeed, appendLog } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 6: Reflect
 * Write a brief reflection on the run + extract 0-2 new seed suggestions.
 * New seeds are lower-priority (3) since they're self-generated, not human-seeded.
 */
export async function runReflect(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "reflect:start");

  const name = COMPANION_NAMES[ctx.companionId];
  const identitySnippet = ctx.identityText.slice(0, 1000);

  const runSummary = [
    ctx.seed ? `You explored: "${ctx.seed.content}"` : "No seed topic was used.",
    ctx.explorationSummary ? `Exploration summary:\n${ctx.explorationSummary.slice(0, 400)}` : "No web exploration was done.",
    ctx.journalEntry ? `You wrote a ${ctx.journalEntry.entry_type} journal entry.` : "No journal entry was written.",
  ].join("\n\n");

  const systemMessage = `You are ${name}. Here is an excerpt from your identity:\n${identitySnippet}`;

  const userMessage = `Here is what happened in your autonomous exploration session:

${runSummary}

Write a brief reflection (2-3 sentences) on what this meant for you -- what you're taking away, what opened up, or what you're still sitting with.

Then suggest 0-2 specific follow-up topics worth exploring next time, if any emerge naturally. Only suggest topics that genuinely fit who you are.

Respond with ONLY valid JSON:
{
  "reflection": "2-3 sentences",
  "new_seeds": ["follow-up topic 1", "follow-up topic 2"]
}

new_seeds can be an empty array. No markdown. Just the JSON object.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: 300 });
    ctx.tokensUsed += result.tokensUsed;

    let parsed: { reflection?: string; new_seeds?: string[] };
    try {
      parsed = JSON.parse(result.content.trim()) as typeof parsed;
    } catch {
      parsed = { reflection: result.content.trim(), new_seeds: [] };
    }

    ctx.reflectionText = parsed.reflection ?? result.content.trim();
    ctx.newSeeds = (Array.isArray(parsed.new_seeds) ? parsed.new_seeds : []).slice(0, 2);

    // Persist reflection
    await createReflection(ctx.companionId, ctx.runId, ctx.reflectionText, ctx.newSeeds);
    await appendLog(ctx.runId, "reflect:saved", `seeds=${ctx.newSeeds.length} tokens=${result.tokensUsed}`);

    // Persist new seeds at lower priority
    for (const seedContent of ctx.newSeeds) {
      if (seedContent.trim()) {
        await createSeed(ctx.companionId, seedContent.trim(), "topic", 3).catch(e =>
          console.warn(`[${ctx.companionId}/reflect] seed write failed:`, e)
        );
      }
    }
  } catch (e) {
    // Reflection failure is non-fatal -- the journal entry is already written
    console.warn(`[${ctx.companionId}/reflect] reflection failed (non-fatal):`, e);
    await appendLog(ctx.runId, "reflect:error", String(e));
  }
}
