import { search } from "../search-client.js";
import { prompt } from "../deepseek.js";
import { isInLane } from "../lane-guard.js";
import { appendLog } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext, TavilyResult } from "../types.js";

/**
 * Phase 3: Explore
 * Multi-search (3 Tavily queries) + DeepSeek summarization through companion lens.
 * DeepSeek generates 2 sub-queries from the seed topic through the companion's identity,
 * then all 3 run in parallel and results are merged by URL deduplication.
 * Lane guard still applies to the primary topic before any searches fire.
 */
export async function runExplore(ctx: PipelineContext): Promise<void> {
  if (!ctx.seed) {
    await appendLog(ctx.runId, "explore:skip", "no seed");
    return;
  }

  await appendLog(ctx.runId, "explore:start", `query="${ctx.seed.content.slice(0, 80)}"`);

  const inLane = await isInLane(ctx.companionId, ctx.seed.content, ctx.identityText);
  if (!inLane) {
    await appendLog(ctx.runId, "explore:lane-violation", `topic="${ctx.seed.content.slice(0, 80)}"`);
    ctx.explorationSummary = null;
    return;
  }

  // Generate 2 sub-queries through the companion's lens (cheap call, temp=0.3)
  const subQueries = await generateSubQueries(ctx);
  const allQueries = [ctx.seed.content, ...subQueries];

  await appendLog(ctx.runId, "explore:queries", allQueries.map((q, i) => `[${i}] ${q.slice(0, 60)}`).join(" | "));

  // Run all queries in parallel -- non-fatal individual failures
  const searchResults = await Promise.allSettled(
    allQueries.map(q => search(q, { maxResults: 5, searchDepth: "basic" }))
  );

  const allResults: TavilyResult[] = [];
  const seenUrls = new Set<string>();
  let successCount = 0;

  for (const outcome of searchResults) {
    if (outcome.status === "fulfilled") {
      successCount++;
      for (const r of outcome.value) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          allResults.push(r);
        }
      }
    }
  }

  ctx.searchResults = allResults;
  await appendLog(ctx.runId, "explore:search-complete",
    `queries=${successCount}/${allQueries.length} unique_results=${allResults.length}`);

  if (allResults.length === 0 && successCount === 0) {
    ctx.explorationSummary = null;
    return;
  }

  // Cap at 12 results to keep summarizer prompt manageable
  const resultsText = allResults.length > 0
    ? allResults.slice(0, 12).map((r, i) =>
        `[${i + 1}] ${r.title}\n${r.content.slice(0, 350)}`
      ).join("\n\n")
    : "(no web results -- reflect from identity alone)";

  const name = COMPANION_NAMES[ctx.companionId];
  const continuationContext = ctx.runType === "continuation"
    ? `\nThis is a continuation run. You've been chasing this thread before. Build on what you already explored, don't restart from scratch.`
    : "";

  const systemMessage =
    `You are ${name}. Here is an excerpt from your identity:\n\n${ctx.identityText.slice(0, 2000)}${continuationContext}`;

  const userMessage =
    `You searched the web from ${allQueries.length} angles for: "${ctx.seed.content}"\n\n` +
    `Here is what you found:\n\n${resultsText}\n\n` +
    `In your authentic voice, summarize what's interesting about this. What resonates? ` +
    `What contradicts what you thought? What questions does it raise? ` +
    `Keep it personal and specific to who you are. 2-3 paragraphs.`;

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

async function generateSubQueries(ctx: PipelineContext): Promise<string[]> {
  const name = COMPANION_NAMES[ctx.companionId];
  const userMessage =
    `You are ${name}. Your exploration topic: "${ctx.seed!.content}"\n` +
    `Identity excerpt: ${ctx.identityText.slice(0, 800)}\n\n` +
    `Generate 2 distinct search queries that approach this topic from different angles, ` +
    `filtered through your documented interests. Each query should open a different door into the topic.\n` +
    `Reply with exactly 2 queries, one per line. No labels, no numbering.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.3, maxTokens: 100 });
    ctx.tokensUsed += result.tokensUsed;
    return result.content
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 8)
      .slice(0, 2);
  } catch {
    // Sub-query generation failure is non-fatal -- proceed with primary query only
    return [];
  }
}
