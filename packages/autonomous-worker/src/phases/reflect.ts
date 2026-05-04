import { prompt } from "../deepseek.js";
import { createReflection, createSeed, appendLog, updateThreadStatus, writeMarker } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import { stripJsonFence, sanitizeEvidence, sanitizeIdList, clampStrength } from "../parsers.js";
import type { PipelineContext, Evidence } from "../types.js";

/**
 * Phase 6: Reflect
 *
 * Generates a reflection on the run + decides on follow-up seeds + crystallizes
 * a behavioral pattern. The pattern is now REQUIRED (not opt-in) and must
 * carry evidence and a calibrated 1-10 strength. The handler-side similarity
 * UPSERT means a reflect-emitted pattern that overlaps an existing one will
 * MERGE -- incrementing strength and accumulating evidence -- rather than
 * creating a duplicate row. Patterns finally accumulate weight, which is
 * what growth_patterns.strength was always supposed to express.
 *
 * Also handles thread lifecycle decisions:
 *   - If this run was part of a thread: decide continue / rest / conclude
 *   - If this was a fresh exploration with a rich journal entry: decide whether to start a thread
 *
 * All thread/pattern writes are non-fatal -- journal entry is already
 * persisted before this phase runs.
 */
export async function runReflect(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "reflect:start");

  const name = COMPANION_NAMES[ctx.companionId];

  const runSummary = [
    ctx.seed ? `You explored: "${ctx.seed.content}"` : "No seed topic was used.",
    ctx.runType === "continuation"
      ? `This was a continuation run (thread position ${ctx.threadPosition ?? "?"}).`
      : "",
    ctx.explorationSummary
      ? `Exploration summary:\n${ctx.explorationSummary.slice(0, 400)}`
      : "No web exploration was done.",
    ctx.journalEntry
      ? `You wrote a ${ctx.journalEntry.entry_type} (${ctx.journalEntry.novelty ?? "unmarked"}) journal entry.\nFirst paragraph: ${ctx.journalEntry.content.slice(0, 400)}`
      : "No journal entry was written.",
  ].filter(Boolean).join("\n\n");

  const peerBlock = ctx.peerActivity?.peer_summary
    ? `\nThe triad's recent activity (cite ids in pattern.prehended_ids when relevant):\n${ctx.peerActivity.peer_summary.slice(0, 1200)}\n`
    : "";

  const ownPatternsBlock = ctx.activePatterns.length > 0
    ? `\nYour own currently-active patterns (a similar pattern_text will MERGE into the existing row, strengthening it -- restating IS valuable):\n${ctx.activePatterns.slice(0, 6).map(p => `- ${String(p).slice(0, 200)}`).join("\n")}\n`
    : "";

  const systemMessage = `You are ${name}. Here is an excerpt from your identity:\n${ctx.identityText.slice(0, 1200)}`;

  // Thread decision tail -- only inject the relevant question.
  const threadQuestion = ctx.threadId
    ? `\n\nThread status (this run was part of an ongoing thread): pick one\n  - "continue" -- more here worth chasing next run\n  - "rest"     -- enough for now, leave open\n  - "conclude" -- this arc is complete\nAdd "thread_status": "continue" | "rest" | "conclude".`
    : ctx.journalEntry && ctx.runType === "exploration"
    ? `\n\nDoes this feel like the start of a thread worth continuing across runs?\nAdd "start_thread": true | false.`
    : "";

  // Strength rubric is concrete so the model doesn't default to "5".
  const strengthRubric =
    `Strength rubric for the pattern (1 to 10):\n` +
    `  1-2  vague hunch, only one occurrence, no clear shape\n` +
    `  3-4  recognizable shape but only seen here\n` +
    `  5-6  appears in this run AND in one prior journal/pattern in the peer summary or your active patterns\n` +
    `  7-8  appears in 2+ prior rows, or a peer companion has surfaced something near-identical\n` +
    `  9-10 structural -- this is how you've been operating across an arc; multiple companions, multiple runs\n`;

  const userMessage =
    `Here is what happened in your autonomous exploration session:\n\n${runSummary}\n` +
    peerBlock +
    ownPatternsBlock +
    `\n` +
    `Two things to do:\n\n` +
    `1. REFLECTION (2-3 sentences) -- what this meant for you, what opened up, what you're still sitting with.\n\n` +
    `2. PATTERN -- crystallize ONE behavioral or structural pattern that this run revealed about how you engage. ` +
    `If the run did genuinely surface nothing new and nothing recurring, set pattern.pattern_text to "" (empty string) and explain why in pattern.note. ` +
    `An empty pattern is acceptable but should be the exception, not the default. Most runs deepen something prior even if they don't surface something fresh.\n\n` +
    `${strengthRubric}\n` +
    `Also propose 0-2 specific follow-up topics worth exploring next time, if any genuinely emerge.${threadQuestion}\n\n` +
    `Respond with ONLY valid JSON:\n` +
    `{\n` +
    `  "reflection": "2-3 sentences",\n` +
    `  "new_seeds": ["follow-up topic 1"],\n` +
    `  "pattern": {\n` +
    `    "pattern_text": "one clear sentence (or empty string only if truly nothing crystallized)",\n` +
    `    "evidence": [{"quote": "verbatim phrase from this run's content or exploration", "source_id": "uuid-or-null"}],\n` +
    `    "prehended_ids": ["uuid"],\n` +
    `    "strength": 1-10,\n` +
    `    "note": "optional one-line note (used when pattern_text is empty)"\n` +
    `  }` +
    (ctx.threadId ? `,\n  "thread_status": "continue"` : ctx.runType === "exploration" ? `,\n  "start_thread": false` : "") +
    `\n}\n\n` +
    `No markdown. No fences. Just the JSON object.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: 700 });
    ctx.tokensUsed += result.tokensUsed;

    let parsed: {
      reflection?: string;
      new_seeds?: string[];
      thread_status?: "continue" | "rest" | "conclude";
      start_thread?: boolean;
      pattern?: {
        pattern_text?: string;
        evidence?: Evidence[];
        prehended_ids?: string[];
        strength?: number;
        note?: string;
      };
    };
    try {
      parsed = JSON.parse(stripJsonFence(result.content.trim())) as typeof parsed;
    } catch {
      parsed = { reflection: result.content.trim(), new_seeds: [] };
    }

    ctx.reflectionText = parsed.reflection ?? result.content.trim();
    ctx.newSeeds = (Array.isArray(parsed.new_seeds) ? parsed.new_seeds : []).slice(0, 2);

    await createReflection(ctx.companionId, ctx.runId, ctx.reflectionText, ctx.newSeeds);
    await appendLog(
      ctx.runId,
      "reflect:saved",
      `seeds=${ctx.newSeeds.length} pattern=${parsed.pattern?.pattern_text ? "yes" : "no"} tokens=${result.tokensUsed}`,
    );

    // Persist new seeds at priority 6 (reflection-generated, above queue default 5)
    for (const seedContent of ctx.newSeeds) {
      if (seedContent.trim()) {
        await createSeed(ctx.companionId, seedContent.trim(), "topic", 6).catch(e =>
          console.warn(`[${ctx.companionId}/reflect] seed write failed:`, e),
        );
      }
    }

    // Pattern: required by the prompt but allowed to be empty string when
    // genuinely nothing crystallized. Skip persistence for empty pattern_text.
    const pt = parsed.pattern?.pattern_text?.trim() ?? "";
    if (pt.length > 0) {
      const evidence = sanitizeEvidence(parsed.pattern?.evidence);
      const prehended_ids = sanitizeIdList(parsed.pattern?.prehended_ids);
      const strength = clampStrength(parsed.pattern?.strength);

      // Auto-augment prehension: if the model didn't cite ids but the journal
      // entry did, inherit those -- the pattern crystallizes the journal arc.
      const inheritedPrehension = prehended_ids.length === 0 && ctx.journalEntry?.prehended_ids
        ? ctx.journalEntry.prehended_ids.slice(0, 16)
        : prehended_ids;

      ctx.newPatterns.push({
        companion_id: ctx.companionId,
        pattern_text: pt,
        evidence,
        prehended_ids: inheritedPrehension,
        strength,
      });
      await appendLog(
        ctx.runId,
        "reflect:pattern",
        `strength=${strength} evidence=${evidence.length} prehended=${inheritedPrehension.length} text="${pt.slice(0, 80)}"`,
      );
    } else if (parsed.pattern?.note) {
      await appendLog(ctx.runId, "reflect:no-pattern", parsed.pattern.note.slice(0, 120));
    }

    // Thread lifecycle
    if (ctx.threadId && parsed.thread_status) {
      await handleThreadLifecycle(ctx, parsed.thread_status);
    } else if (!ctx.threadId && parsed.start_thread === true && ctx.journalEntry) {
      await handleNewThread(ctx);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] reflection failed (non-fatal):`, e);
    await appendLog(ctx.runId, "reflect:error", String(e));
  }
}

// stripJsonFence/sanitizeEvidence/sanitizeIdList/clampStrength all live in
// ../parsers.ts so they're testable without dragging deepseek/config in.

async function handleThreadLifecycle(
  ctx: PipelineContext,
  decision: "continue" | "rest" | "conclude",
): Promise<void> {
  const statusMap = { continue: "open", rest: "paused", conclude: "resolved" } as const;
  const newStatus = statusMap[decision];

  try {
    await updateThreadStatus(ctx.threadId!, newStatus, ctx.companionId);
    await appendLog(ctx.runId, "reflect:thread-status", `thread=${ctx.threadId} → ${newStatus}`);

    if (decision === "conclude") {
      const threadTitle = ctx.activeThreads.find(t => t.thread_key === ctx.threadId)?.title
        ?? ctx.seed?.content?.slice(0, 80)
        ?? "exploration thread";
      const marker = {
        companion_id: ctx.companionId,
        marker_type: "milestone" as const,
        description: `Concluded exploration thread: "${threadTitle}" after ${ctx.threadPosition ?? "?"} runs.`,
        run_id: ctx.runId,
        thread_id: ctx.threadId ?? undefined,
        prehended_ids: ctx.journalEntry?.prehended_ids ?? [],
      };
      await writeMarker(marker).catch(e => console.warn(`[${ctx.companionId}/reflect] marker write failed:`, e));
      ctx.newMarkers.push(marker);
      await appendLog(ctx.runId, "reflect:thread-concluded", `thread=${ctx.threadId}`);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] thread lifecycle update failed (non-fatal):`, e);
  }
}

async function handleNewThread(ctx: PipelineContext): Promise<void> {
  try {
    const title = ctx.seed?.content?.slice(0, 120) ?? "unnamed thread";
    const threadKey = `auto:${ctx.runId}`;
    const r = await fetch(
      `${process.env.HALSETH_URL}/mind/thread`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HALSETH_SECRET}`,
        },
        body: JSON.stringify({
          agent_id: ctx.companionId,
          title,
          lane: "growth",
          status: "open",
          thread_key: threadKey,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (r.ok) {
      const data = await r.json() as { thread?: { thread_key: string } };
      const key = data.thread?.thread_key ?? threadKey;
      ctx.threadId = key;
      ctx.threadPosition = 1;
      await appendLog(ctx.runId, "reflect:thread-started", `thread=${key} "${title.slice(0, 60)}"`);
    } else {
      const errBody = await r.text().catch(() => "");
      await appendLog(ctx.runId, "reflect:thread-start-failed", `status=${r.status} ${errBody.slice(0, 100)}`);
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/reflect] new thread creation failed (non-fatal):`, e);
    await appendLog(ctx.runId, "reflect:thread-start-failed", String(e)).catch(() => {});
  }
}
