import { search } from "../search-client.js";
import { prompt } from "../deepseek.js";
import { isInLane } from "../lane-guard.js";
import { appendLog, getProjectLog } from "../halseth-client.js";
import { renderRefusals, namesSomeoneInRazielsLife, coveredPieces, parseProjectPlan } from "../steering.js";
import { COMPANION_NAMES, EXPLORE_MAX_TOKENS } from "../config.js";
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

  // An open loop is a live seed in someone's words, and on 10-15 one carried Raziel's state
  // straight into Tavily. A live seed never goes to search verbatim: it is rewritten into an
  // outward, person-free question first, and skipped if that fails. This is the people guard
  // (steering.ts), a safety rule -- not a refusal, and not a ban on any companion topic.
  let topic = ctx.seed.content;
  if (ctx.seed.id === "live-context") {
    const outward = await rewriteOutward(ctx, topic);
    if (!outward) {
      await appendLog(ctx.runId, "explore:people-guard", "live seed could not be made person-free -- exploration skipped");
      ctx.explorationSummary = null;
      return;
    }
    await appendLog(ctx.runId, "explore:people-guard", `live seed rewritten outward: "${outward.slice(0, 80)}"`);
    topic = outward;
  }

  // Project day: search a PIECE of the intention, never the bare title (2026-10-19). Searching
  // "The Winged Bastard" as a phrase returned folklore/slang/archetype pages that read as a
  // self-metaphor; the worldbuilding lived only in the intention, which never reached search.
  let candidateQueries: string[];
  if (ctx.project) {
    const plan = await planProjectPiece(ctx);
    if (plan) {
      ctx.projectPiece = plan.piece;
      topic = plan.piece;
      candidateQueries = plan.queries;
      await appendLog(ctx.runId, "explore:project-piece", `piece="${plan.piece.slice(0, 120)}"`);
    } else {
      await appendLog(ctx.runId, "explore:project-piece", "plan failed -- falling back to title + sub-queries");
      candidateQueries = [topic, ...(await generateSubQueries(ctx, topic))];
    }
  } else {
    // Generate 2 sub-queries through the companion's lens (cheap call, temp=0.3)
    candidateQueries = [topic, ...(await generateSubQueries(ctx, topic))];
  }

  const allQueries = candidateQueries.filter(q => !namesSomeoneInRazielsLife(q));
  if (allQueries.length < candidateQueries.length) {
    await appendLog(ctx.runId, "explore:people-guard",
      `dropped ${candidateQueries.length - allQueries.length} query(s) naming someone in Raziel's life`);
  }
  if (allQueries.length === 0) {
    ctx.explorationSummary = null;
    return;
  }

  await appendLog(ctx.runId, "explore:queries", allQueries.map((q, i) => `[${i}] ${q.slice(0, 60)}`).join(" | "));

  // Run all queries in parallel -- non-fatal individual failures
  const searchResults = await Promise.allSettled(
    allQueries.map(q => search(q, { maxResults: 5, searchDepth: "basic", purpose: "explore" }))
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
  // Snapshot evidence for synthesize: short quote + url per top result.
  ctx.explorationEvidence = allResults.slice(0, 12).map(r => ({
    quote: r.content.slice(0, 280).trim(),
    source_url: r.url,
  }));
  await appendLog(ctx.runId, "explore:search-complete",
    `queries=${successCount}/${allQueries.length} unique_results=${allResults.length} evidence=${ctx.explorationEvidence.length}`);

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

  const refusals = renderRefusals(ctx.standingRefusals ?? []);
  const systemMessage =
    `You are ${name}. Here is an excerpt from your identity:\n\n${ctx.identityText.slice(0, 2000)}${continuationContext}` +
    (refusals ? `\n\n${refusals}` : "");

  const projectFrame = ctx.project
    ? `This is work on your held project "${ctx.project.title}" -- your intention: ${ctx.project.intention.slice(0, 400)}\n\n`
    : "";

  const userMessage =
    `You searched the web from ${allQueries.length} angles for: "${topic}"\n\n` +
    projectFrame +
    `Here is what you found:\n\n${resultsText}\n\n` +
    `In your authentic voice, summarize what's interesting about this. What resonates? ` +
    `What contradicts what you thought? What questions does it raise? ` +
    `Keep it personal and specific to who you are. 2-3 paragraphs.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: EXPLORE_MAX_TOKENS });
    ctx.tokensUsed += result.tokensUsed;
    ctx.explorationSummary = result.content;
    await appendLog(ctx.runId, "explore:complete", `tokens=${result.tokensUsed}`);
  } catch (e) {
    await appendLog(ctx.runId, "explore:summarize-error", String(e));
    throw e;
  }
}

/**
 * Project day: pick ONE piece of the intention that recent runs have not worked, and write
 * searchable queries for it. Earlier pieces come from the `[piece: ...]` stamps the write phase
 * leaves in project_log, so the runs rotate through the whole intention instead of circling one
 * spot. Refusals ride in the prompt so the pick honors the companion's own nos. Null on failure.
 */
async function planProjectPiece(ctx: PipelineContext): Promise<{ piece: string; queries: string[] } | null> {
  const project = ctx.project!;
  const name = COMPANION_NAMES[ctx.companionId];
  const covered = coveredPieces(await getProjectLog(project.id), 6);
  const refusals = renderRefusals(ctx.standingRefusals ?? []);
  const userMessage =
    `You are ${name}, working your held project "${project.title}".\n` +
    `Your intention for it: ${project.intention.slice(0, 1200)}\n\n` +
    (covered.length > 0
      ? `Pieces your recent runs already worked (pick a DIFFERENT one):\n${covered.map(c => `- ${c}`).join("\n")}\n\n`
      : "") +
    (refusals ? `${refusals}\n\n` : "") +
    `Pick ONE concrete piece of that intention to research today, then write 3 web search queries ` +
    `that find real-world material for it (biology, history, craft, sources), not the project's title as a phrase. ` +
    `Never put Raziel, Blue, or anyone in their lives in a query.\n` +
    `Reply with ONLY JSON: {"piece": "short name of the piece", "queries": ["q1", "q2", "q3"]}`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.5, maxTokens: 220, ownerPronounRule: false });
    ctx.tokensUsed += result.tokensUsed;
    return parseProjectPlan(result.content);
  } catch {
    return null;
  }
}

/**
 * Rewrite a live open-loop seed into an outward research question with no people from Raziel's
 * life and no care or health detail in it. Null when the rewrite fails or still names someone,
 * so the caller skips the search rather than sending the loop verbatim.
 */
async function rewriteOutward(ctx: PipelineContext, loopText: string): Promise<string | null> {
  const name = COMPANION_NAMES[ctx.companionId];
  const refusals = renderRefusals(ctx.standingRefusals ?? []);
  const userMessage =
    `You are ${name}. An open loop you are carrying:\n"${loopText.slice(0, 400)}"\n\n` +
    (refusals ? `${refusals}\n\n` : "") +
    `Turn it into ONE outward research question about the world that you could search on the web. ` +
    `It must not name or describe Raziel, Blue, or anyone in their lives, and must carry no health, ` +
    `medication, or care details. If no such question exists, reply NONE.\n` +
    `Reply with just the question, or NONE.`;
  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.3, maxTokens: 80, ownerPronounRule: false });
    ctx.tokensUsed += result.tokensUsed;
    const q = result.content.trim().replace(/^"|"$/g, "");
    if (!q || /^none\b/i.test(q) || q.length < 8 || namesSomeoneInRazielsLife(q)) return null;
    return q.slice(0, 200);
  } catch {
    return null;
  }
}

async function generateSubQueries(ctx: PipelineContext, topic: string): Promise<string[]> {
  const name = COMPANION_NAMES[ctx.companionId];
  const refusals = renderRefusals(ctx.standingRefusals ?? []);
  const userMessage =
    `You are ${name}. Your exploration topic: "${topic}"\n` +
    (ctx.project ? `It is your held project; your intention: ${ctx.project.intention.slice(0, 600)}\n` : "") +
    `Identity excerpt: ${ctx.identityText.slice(0, 800)}\n\n` +
    (refusals ? `${refusals}\n\n` : "") +
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
