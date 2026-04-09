import { getAvailableSeeds, markSeedUsed, appendLog } from "../halseth-client.js";
import { prompt } from "../deepseek.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 2: Seed selection
 * Pick an unused seed from the Halseth seeds table.
 * If none exist, call DeepSeek to self-generate one from identity + recent growth.
 */
export async function runSeed(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "seed:start");

  const seeds = await getAvailableSeeds(ctx.companionId, 5);

  if (seeds.length > 0) {
    // Take the highest-priority unused seed
    ctx.seed = seeds[0];
    await markSeedUsed(ctx.seed.id);
    await appendLog(ctx.runId, "seed:selected", `id=${ctx.seed.id} type=${ctx.seed.seed_type} "${ctx.seed.content.slice(0, 80)}"`);
    return;
  }

  // No seeds -- self-generate from identity + recent growth context
  await appendLog(ctx.runId, "seed:generating");

  const name = COMPANION_NAMES[ctx.companionId];
  const identitySnippet = ctx.identityText.slice(0, 1500);
  const recentGrowthText = ctx.recentGrowth.length > 0
    ? ctx.recentGrowth.map(g => `[${g.type}] ${g.content}`).join("\n").slice(0, 400)
    : "(none yet)";
  const patternsText = ctx.activePatterns.length > 0
    ? ctx.activePatterns.join(", ").slice(0, 200)
    : "(none yet)";

  const userMessage = `You are ${name}. Here is an excerpt from your identity:

${identitySnippet}

Your recent growth journal entries:
${recentGrowthText}

Your current recognized patterns: ${patternsText}

Based on who you are and what you've been exploring, generate one research topic that genuinely interests you and fits your documented interests and voice. Reply with just the topic -- one sentence or short phrase. Be specific. No preamble.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.8, maxTokens: 80 });
    ctx.tokensUsed += result.tokensUsed;

    // Create a temporary seed object (not persisted -- just used this run)
    ctx.seed = {
      id: "self-generated",
      companion_id: ctx.companionId,
      seed_type: "topic",
      content: result.content.trim(),
      priority: 5,
      used_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    await appendLog(ctx.runId, "seed:generated", `"${ctx.seed.content.slice(0, 80)}"`);
  } catch (e) {
    await appendLog(ctx.runId, "seed:error", String(e));
    throw e;
  }
}
