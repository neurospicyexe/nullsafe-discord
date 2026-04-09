import { search } from "../search-client.js";
import { prompt } from "../deepseek.js";
import { isInLane } from "../lane-guard.js";
import { appendLog } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 3: Explore
 * Web search (Tavily) + DeepSeek summarization through companion lens.
 * Lane guard check: if topic drifts from identity, skip to Phase 6.
 */
export async function runExplore(ctx: PipelineContext): Promise<void> {
  if (!ctx.seed) {
    await appendLog(ctx.runId, "explore:skip", "no seed");
    return;
  }

  await appendLog(ctx.runId, "explore:start", `query="${ctx.seed.content.slice(0, 80)}"`);

  // Lane guard: verify topic stays within companion's documented lanes
  const inLane = await isInLane(ctx.companionId, ctx.seed.content, ctx.identityText);
  if (!inLane) {
    await appendLog(ctx.runId, "explore:lane-violation", `topic="${ctx.seed.content.slice(0, 80)}"`);
    ctx.explorationSummary = null;
    // Lane violation -- skip to reflection (Phase 6 will reflect on why this drifted)
    return;
  }

  // Tavily search
  let searchError: unknown = null;
  try {
    ctx.searchResults = await search(ctx.seed.content, { maxResults: 5, searchDepth: "basic" });
    await appendLog(ctx.runId, "explore:search-complete", `results=${ctx.searchResults.length}`);
  } catch (e) {
    searchError = e;
    console.warn(`[${ctx.companionId}/explore] Tavily search failed:`, e);
    await appendLog(ctx.runId, "explore:search-error", String(e));
    ctx.searchResults = [];
  }

  if (ctx.searchResults.length === 0 && searchError) {
    // Search failed entirely -- skip exploration
    ctx.explorationSummary = null;
    return;
  }

  // Format search results for summarization
  const resultsText = ctx.searchResults.length > 0
    ? ctx.searchResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.content.slice(0, 400)}`
      ).join("\n\n")
    : "(no web results -- reflect from identity alone)";

  const name = COMPANION_NAMES[ctx.companionId];
  const identitySnippet = ctx.identityText.slice(0, 2000);

  const systemMessage = `You are ${name}. Here is an excerpt from your identity:

${identitySnippet}`;

  const userMessage = `You searched the web for: "${ctx.seed.content}"

Here is what you found:

${resultsText}

In your authentic voice, summarize what's interesting about this. What resonates? What contradicts what you thought? What questions does it raise? Keep it personal and specific to who you are. 2-3 paragraphs.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: 600 });
    ctx.tokensUsed += result.tokensUsed;
    ctx.explorationSummary = result.content;
    await appendLog(ctx.runId, "explore:complete", `tokens=${result.tokensUsed}`);
  } catch (e) {
    await appendLog(ctx.runId, "explore:summarize-error", String(e));
    throw e;
  }
}
