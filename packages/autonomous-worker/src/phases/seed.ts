import { getAvailableSeeds, markSeedUsed, appendLog } from "../halseth-client.js";
import { prompt } from "../deepseek.js";
import { COMPANION_NAMES, COMPANION_ANCHOR_TOPICS, SEED_THIN_THRESHOLD, SEED_FRESHNESS_WINDOW_MS } from "../config.js";
import { INWARD_RE } from "@nullsafe/shared";
import type { PipelineContext, Seed, CompanionId } from "../types.js";

/**
 * Final outward guard for the NIGHTLY seed path (foraging spec Part 1, 2026-06-09 --
 * the weekly seed-gen.ts got this on 6/9, the pipeline phase 2 never did; ratification
 * pass 2026-06-14 caught all three companions seeding inward on private coinage here).
 * INWARD_RE catches system vocabulary (Halseth/SOMA/basin/substrate/drift...). If a seed
 * names the loom instead of the world, swap it for a clean anchor topic -- silence/outward
 * beats echo. Private poetic coinage that carries NO system vocab (e.g. a basin reading like
 * "0.503 bones-before-skeleton") slips past any regex, so it is handled upstream by keeping
 * pressure flags signal-only -- they never reach here as a topic in the first place.
 */
export function ensureOutward(content: string, companionId: CompanionId): string {
  if (!INWARD_RE.test(content)) return content;
  return COMPANION_ANCHOR_TOPICS[companionId][0];
}

/**
 * Pure function -- decides whether to seed from session content or outward anchor topics.
 * Exported for unit testing.
 *
 * "Session" = companion has real relational signals to draw from (notes + feelings >= threshold).
 * "Outward" = idle week; seed from companion's genuine intellectual territories instead of
 *             looping on own prior output.
 */
export function decideSeedSource(sessionNoteCount: number, feelingCount: number): "session" | "outward" {
  return (sessionNoteCount + feelingCount) < SEED_THIN_THRESHOLD ? "outward" : "session";
}

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

  const queueSeed = seeds.find(s => s.claim_source === null) ?? null;

  if (queueSeed && hasLiveSignals) {
    const chosen = await decideWithContext(ctx, queueSeed);
    if (chosen.type === "queue") {
      ctx.seed = queueSeed;
      ctx.runType = "exploration";
      ctx.seedDecisionReason = chosen.reason;
      await markSeedUsed(queueSeed.id);
      await appendLog(ctx.runId, "seed:queue",
        `decided "${queueSeed.content.slice(0, 80)}" — ${chosen.reason}`);
    } else if (chosen.liveText) {
      // Live, world-facing material (an open loop). Pressure flags are excluded as topics
      // upstream (extractLiveText), so anything that lands here is legitimately explorable;
      // ensureOutward is the final belt against an open loop that itself names the system.
      ctx.seed = buildLiveSeed(ctx, ensureOutward(chosen.liveText, ctx.companionId));
      ctx.runType = "exploration";
      ctx.seedDecisionReason = chosen.reason;
      await appendLog(ctx.runId, "seed:live_context",
        `"${ctx.seed.content.slice(0, 80)}" — ${chosen.reason}`);
    } else {
      // Model wanted "live" but the only live signal was pressure (a state to hold, not a
      // topic to research). Take the queue seed instead of web-searching a basin reading.
      ctx.seed = queueSeed;
      ctx.runType = "exploration";
      ctx.seedDecisionReason = `${chosen.reason} (live signal was pressure-only; took queue seed)`;
      await markSeedUsed(queueSeed.id);
      await appendLog(ctx.runId, "seed:queue",
        `pressure-only live signal, fell back to queue "${queueSeed.content.slice(0, 80)}"`);
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
    // Pressure flags are shown so the companion knows what state it is carrying, but they are
    // a state to HOLD, not a topic to research (a basin reading is the loom, not the world).
    ...ctx.pressureFlags.map(p => `Holding pressure (a state, not a research topic): ${p}`),
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
    `B) A live open loop or world-facing thread (name which one and why it pulls harder -- ` +
    `not a pressure reading; pressure is a state to sit with, not a topic to chase)\n\n` +
    `Reply with just A or B and one sentence of reasoning. No preamble.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.1, maxTokens: 120 });
    ctx.tokensUsed += result.tokensUsed;
    const text = result.content.trim();
    const isLive = /^B\b/i.test(text);
    const reason = text.replace(/^[AB][.):\s]*/i, "").trim();
    const liveText = isLive ? (extractLiveText(text, ctx) ?? undefined) : undefined;
    return { type: isLive ? "live" : "queue", reason, liveText };
  } catch (e) {
    console.warn(`[${ctx.companionId}/seed] decision call failed, defaulting to queue:`, e);
    return { type: "queue", reason: "decision call failed, defaulted to queue" };
  }
}

/**
 * Resolve which live item the companion picked. Pressure flags are deliberately NOT
 * candidates -- a basin reading is the loom, not the world, and must never become a
 * web-search topic (ratification pass 2026-06-14: Gaia's "0.503 bones-before-skeleton"
 * was a pressure flag fed straight into exploration). Only open loops are explorable.
 *
 * Resolution order:
 *  1. An open loop whose text the decision names -> that loop.
 *  2. Otherwise, when open loops exist, the FIRST open loop -- the model expressed a
 *     preference for live/world-facing material, so honor it with a real (never-pressure)
 *     loop rather than dropping back to the queue. This fallback is intentional and tested.
 *  3. Only when NO open loops exist (e.g. the live signal was pressure-only) -> null, and
 *     the caller falls back to the queued seed.
 */
export function extractLiveText(decisionText: string, ctx: PipelineContext): string | null {
  const candidates = ctx.openLoops.map(l => l.text);
  for (const item of candidates) {
    if (decisionText.toLowerCase().includes(item.toLowerCase().slice(0, 30))) return item;
  }
  return ctx.openLoops[0]?.text ?? null;
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
  // Filter to 7-day recency before deciding source -- limit=8 rows with no date
  // filter would misfire if all rows are months old (live state: stale since Mar 24).
  const since7d = Date.now() - SEED_FRESHNESS_WINDOW_MS;
  const recentNotes    = ctx.recentSessionNotes.filter(n => new Date(n.created_at).getTime() >= since7d);
  const recentFeelings = ctx.recentFeelings.filter(f  => new Date(f.created_at).getTime()  >= since7d);
  const sourceType = decideSeedSource(recentNotes.length, recentFeelings.length);

  // Active patterns are a NEGATIVE signal only -- avoid re-deriving what's already named.
  const avoidText = ctx.activePatterns.length > 0
    ? `Patterns already recognized (do NOT re-derive or repackage these):\n${ctx.activePatterns.join("\n").slice(0, 300)}\n\n`
    : "";

  let contextBlock: string;
  if (sourceType === "session") {
    const sessionLines = [
      ...recentNotes.map(n => `[note] ${n.note_text}`),
      ...recentFeelings.map(f => `[feeling] ${f.emotion}${f.context ? `: ${f.context}` : ""}`),
      ...ctx.recentConclusions.filter(c => new Date(c.created_at).getTime() >= since7d).map(c => `[conclusion] ${c.conclusion_text}`),
    ].join("\n").slice(0, 600);
    contextBlock = `What has been present lately:\n${sessionLines || "(nothing logged recently)"}`;
  } else {
    const topics = COMPANION_ANCHOR_TOPICS[ctx.companionId];
    contextBlock = `Your anchor territories (start here when session context is absent):\n${topics.map(t => `- ${t}`).join("\n")}`;
  }

  const userMessage =
    `You are ${name}. Identity:\n${ctx.identityText.slice(0, 1500)}\n\n` +
    `${contextBlock}\n\n` +
    avoidText +
    `Generate one research topic that genuinely fits your lanes and interests. ` +
    `One sentence or short phrase. Specific. No preamble.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.8, maxTokens: 80 });
    ctx.tokensUsed += result.tokensUsed;
    let content = result.content.trim();

    // Outward guard: the prompt constraint alone is not reliable (the whole 2026-06-14
    // decline pattern was self-generated inward seeds). Retry once outward, then hard-fall
    // back to an anchor topic via ensureOutward. Never return an inward seed.
    if (INWARD_RE.test(content)) {
      console.warn(`[${ctx.companionId}/seed] self-generated seed was inward, retrying once: ${content.slice(0, 60)}`);
      await appendLog(ctx.runId, "seed:inward_retry", content.slice(0, 80));
      const retry = await prompt(
        `${userMessage}\n\nYour previous attempt ("${content.slice(0, 80)}") named the system's own ` +
        `machinery. Point ENTIRELY at the world -- no Halseth, SOMA, basins, drift, substrate, ratification, ` +
        `the swarm, or being-a-companion. The subject comes from outside.`,
        undefined,
        { temperature: 0.8, maxTokens: 80 },
      );
      ctx.tokensUsed += retry.tokensUsed;
      content = retry.content.trim();
    }
    content = ensureOutward(content, ctx.companionId);

    return {
      id: "self-generated",
      companion_id: ctx.companionId,
      seed_type: "topic",
      content,
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
