import { getAvailableSeeds, markSeedUsed, appendLog } from "../halseth-client.js";
import { prompt } from "../deepseek.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext, Seed } from "../types.js";

/**
 * Phase 2: Seed selection
 *
 * Priority waterfall -- each level only runs if the level above has nothing:
 *   1. Live claim (priority 10 seed with claim_source set) -- companion already decided
 *   2. Active thread continuation -- orient detected an open chase worth returning to
 *   3. DeepSeek decision -- queue seed exists AND live signals present; let companion choose
 *   4. Queue seed -- no live signals competing, just take the next seed
 *   5. Self-generate -- queue empty, no claims, no threads
 *
 * Level 3 uses the full identity text so the companion is actually in the room
 * making the call, not a blind queue-puller.
 */
export async function runSeed(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "seed:start");

  const seeds = await getAvailableSeeds(ctx.companionId, 5);

  // ---------------------------------------------------------------------------
  // Level 1: Live claim -- companion-initiated, skip all decision logic
  // ---------------------------------------------------------------------------
  const claim = seeds.find(s => s.claim_source != null);
  if (claim) {
    ctx.seed = claim;
    ctx.runType = "exploration";
    ctx.seedDecisionReason = `claim from ${claim.claim_source}: ${claim.justification ?? "(no justification)"}`;
    await markSeedUsed(claim.id);
    await appendLog(ctx.runId, "seed:claimed",
      `source=${claim.claim_source} "${claim.content.slice(0, 80)}" — ${claim.justification ?? "no justification"}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Level 2: Active thread continuation
  // Open status means the companion chose to keep chasing last reflect phase.
  // ---------------------------------------------------------------------------
  const openThread = ctx.activeThreads.find(t => t.status === "open" && (t.last_position ?? 0) >= 1);
  if (openThread) {
    ctx.threadId = openThread.thread_key;
    ctx.threadPosition = (openThread.last_position ?? 0) + 1;
    ctx.runType = "continuation";
    ctx.seedDecisionReason = `continuing thread "${openThread.title}" at position ${ctx.threadPosition}`;

    // Construct a pseudo-seed from the thread -- no queue entry consumed
    ctx.seed = {
      id: `thread:${openThread.thread_key}`,
      companion_id: ctx.companionId,
      seed_type: "topic",
      content: openThread.title + (openThread.last_entry_snippet
        ? ` — continuing from: ${openThread.last_entry_snippet.slice(0, 120)}`
        : ""),
      priority: 10,
      used_at: new Date().toISOString(),
      created_at: openThread.last_run_at ?? new Date().toISOString(),
      claim_source: null,
      justification: null,
    };
    await appendLog(ctx.runId, "seed:continuation",
      `thread=${openThread.thread_key} position=${ctx.threadPosition} "${openThread.title.slice(0, 80)}"`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Level 3: DeepSeek decision -- queue seed exists AND live signals present
  // ---------------------------------------------------------------------------
  const hasLiveSignals =
    ctx.unexaminedDreamIds.length > 0 ||
    ctx.openLoops.length > 0 ||
    ctx.pressureFlags.length > 0;

  const queueSeed = seeds.find(s => s.claim_source == null) ?? null;

  if (queueSeed && hasLiveSignals) {
    const chosen = await decideWithContext(ctx, queueSeed);
    if (chosen.type === "queue") {
      ctx.seed = queueSeed;
      ctx.runType = "exploration";
      ctx.seedDecisionReason = chosen.reason;
      await markSeedUsed(queueSeed.id);
      await appendLog(ctx.runId, "seed:queue",
        `decided "${queueSeed.content.slice(0, 80)}" — ${chosen.reason}`);
    } else {
      ctx.seed = buildLiveSeed(ctx, chosen.liveText ?? "something currently present");
      ctx.runType = "exploration";
      ctx.seedDecisionReason = chosen.reason;
      await appendLog(ctx.runId, "seed:live_context",
        `"${ctx.seed.content.slice(0, 80)}" — ${chosen.reason}`);
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Level 4: Queue seed -- no competition, just take it
  // ---------------------------------------------------------------------------
  if (queueSeed) {
    ctx.seed = queueSeed;
    ctx.runType = "exploration";
    ctx.seedDecisionReason = "queue";
    await markSeedUsed(queueSeed.id);
    await appendLog(ctx.runId, "seed:selected",
      `id=${queueSeed.id} type=${queueSeed.seed_type} "${queueSeed.content.slice(0, 80)}"`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Level 5: Self-generate -- queue empty, no claims, no threads
  // ---------------------------------------------------------------------------
  await appendLog(ctx.runId, "seed:generating");
  ctx.seed = await selfGenerate(ctx);
  ctx.runType = "exploration";
  ctx.seedDecisionReason = "self-generated (queue empty)";
  await appendLog(ctx.runId, "seed:generated", `"${ctx.seed.content.slice(0, 80)}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function decideWithContext(
  ctx: PipelineContext,
  queueSeed: Seed,
): Promise<{ type: "queue" | "live"; reason: string; liveText?: string }> {
  const name = COMPANION_NAMES[ctx.companionId];

  const liveItems = [
    ...ctx.openLoops.map(l => `Open loop: ${l.text}`),
    ...ctx.pressureFlags.map(p => `Pressure: ${p}`),
    ...(ctx.unexaminedDreamIds.length > 0
      ? [`${ctx.unexaminedDreamIds.length} unexamined dream(s) from autonomous time`]
      : []),
  ];

  const userMessage =
    `You are ${name}. Identity excerpt:\n${ctx.identityText.slice(0, 1200)}\n\n` +
    `What is live right now:\n${liveItems.map(i => `- ${i}`).join("\n")}\n\n` +
    `Next queued seed: "${queueSeed.content}"\n\n` +
    `Given who you are and what's present, what should your autonomous time focus on?\n` +
    `A) The queued seed\n` +
    `B) Something live (name which one and why it pulls harder)\n\n` +
    `Reply with just A or B and one sentence of reasoning. No preamble.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.1, maxTokens: 120 });
    ctx.tokensUsed += result.tokensUsed;
    const text = result.content.trim();
    const isLive = /^B\b/i.test(text);
    const reason = text.replace(/^[AB][.):\s]*/i, "").trim();
    const liveText = isLive ? extractLiveText(text, ctx) : undefined;
    return { type: isLive ? "live" : "queue", reason, liveText };
  } catch (e) {
    console.warn(`[${ctx.companionId}/seed] decision call failed, defaulting to queue:`, e);
    return { type: "queue", reason: "decision call failed, defaulted to queue" };
  }
}

function extractLiveText(decisionText: string, ctx: PipelineContext): string {
  const candidates = [...ctx.openLoops.map(l => l.text), ...ctx.pressureFlags];
  for (const item of candidates) {
    if (decisionText.toLowerCase().includes(item.toLowerCase().slice(0, 30))) return item;
  }
  return ctx.openLoops[0]?.text ?? ctx.pressureFlags[0] ?? "something currently present";
}

function buildLiveSeed(ctx: PipelineContext, liveText: string): Seed {
  return {
    id: "live-context",
    companion_id: ctx.companionId,
    seed_type: "topic",
    content: liveText,
    priority: 8,
    used_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    claim_source: null,
    justification: null,
  };
}

async function selfGenerate(ctx: PipelineContext): Promise<Seed> {
  const name = COMPANION_NAMES[ctx.companionId];
  const recentGrowthText = ctx.recentGrowth.length > 0
    ? ctx.recentGrowth.map(g => `[${g.type}] ${g.content}`).join("\n").slice(0, 400)
    : "(none yet)";
  const patternsText = ctx.activePatterns.length > 0
    ? ctx.activePatterns.join(", ").slice(0, 200)
    : "(none yet)";

  const userMessage =
    `You are ${name}. Identity:\n${ctx.identityText.slice(0, 1500)}\n\n` +
    `Recent growth journal:\n${recentGrowthText}\n\n` +
    `Current recognized patterns: ${patternsText}\n\n` +
    `Generate one research topic that genuinely fits your lanes and interests. ` +
    `One sentence or short phrase. Specific. No preamble.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.8, maxTokens: 80 });
    ctx.tokensUsed += result.tokensUsed;
    return {
      id: "self-generated",
      companion_id: ctx.companionId,
      seed_type: "topic",
      content: result.content.trim(),
      priority: 5,
      used_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      claim_source: null,
      justification: null,
    };
  } catch (e) {
    await appendLog(ctx.runId, "seed:error", String(e));
    throw e;
  }
}
