import { prompt } from "../deepseek.js";
import { createReflection, createSeed, appendLog, updateThreadStatus, writeMarker } from "../halseth-client.js";
import { COMPANION_NAMES } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 6: Reflect
 * Write a brief reflection on the run + extract 0-2 new seed suggestions.
 * Also handles thread lifecycle decisions:
 *   - If this run was part of a thread: decide continue / rest / conclude
 *   - If this was a fresh exploration with a rich journal entry: decide whether to start a thread
 *
 * All thread decisions are non-fatal -- journal entry is already written before this phase.
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
      ? `You wrote a ${ctx.journalEntry.entry_type} journal entry.`
      : "No journal entry was written.",
  ].filter(Boolean).join("\n\n");

  const systemMessage = `You are ${name}. Here is an excerpt from your identity:\n${ctx.identityText.slice(0, 1000)}`;

  // Main reflection prompt -- thread status question included when a thread is active
  const threadQuestion = ctx.threadId
    ? `\n\nThis run was part of an ongoing thread. After reflecting, also answer:\n` +
      `Thread status: A) Continue next run -- more here worth chasing  B) Rest -- enough for now  C) Conclude -- this arc is complete\n` +
      `Add "thread_status": "continue" | "rest" | "conclude" to your JSON.`
    : ctx.journalEntry && !ctx.threadId && ctx.runType === "exploration"
    ? `\n\nAlso answer: does this feel like the start of a thread worth continuing over multiple runs, or a complete standalone exploration?\n` +
      `Add "start_thread": true | false to your JSON.`
    : "";

  const userMessage =
    `Here is what happened in your autonomous exploration session:\n\n${runSummary}\n\n` +
    `Write a brief reflection (2-3 sentences) on what this meant for you -- ` +
    `what you're taking away, what opened up, or what you're still sitting with.\n\n` +
    `Then suggest 0-2 specific follow-up topics worth exploring next time, if any emerge naturally. ` +
    `Only suggest topics that genuinely fit who you are.${threadQuestion}\n\n` +
    `Respond with ONLY valid JSON:\n` +
    `{\n  "reflection": "2-3 sentences",\n  "new_seeds": ["follow-up topic 1"]\n` +
    (ctx.threadId ? `  ,"thread_status": "continue"\n` : ctx.runType === "exploration" ? `  ,"start_thread": false\n` : "") +
    `}\n\nnew_seeds can be an empty array. No markdown. Just the JSON object.`;

  try {
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: 350 });
    ctx.tokensUsed += result.tokensUsed;

    let parsed: {
      reflection?: string;
      new_seeds?: string[];
      thread_status?: "continue" | "rest" | "conclude";
      start_thread?: boolean;
    };
    try {
      parsed = JSON.parse(result.content.trim()) as typeof parsed;
    } catch {
      parsed = { reflection: result.content.trim(), new_seeds: [] };
    }

    ctx.reflectionText = parsed.reflection ?? result.content.trim();
    ctx.newSeeds = (Array.isArray(parsed.new_seeds) ? parsed.new_seeds : []).slice(0, 2);

    await createReflection(ctx.companionId, ctx.runId, ctx.reflectionText, ctx.newSeeds);
    await appendLog(ctx.runId, "reflect:saved", `seeds=${ctx.newSeeds.length} tokens=${result.tokensUsed}`);

    // Persist new seeds at priority 6 (reflection-generated, above queue default 5)
    for (const seedContent of ctx.newSeeds) {
      if (seedContent.trim()) {
        await createSeed(ctx.companionId, seedContent.trim(), "topic", 6).catch(e =>
          console.warn(`[${ctx.companionId}/reflect] seed write failed:`, e)
        );
      }
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
      // Concluded thread deserves a marker -- it's a real arc of becoming
      const threadTitle = ctx.activeThreads.find(t => t.id === ctx.threadId)?.title
        ?? ctx.seed?.content?.slice(0, 80)
        ?? "exploration thread";
      await writeMarker({
        companion_id: ctx.companionId,
        marker_type: "milestone",
        description: `Concluded exploration thread: "${threadTitle}" after ${ctx.threadPosition ?? "?"} runs.`,
        run_id: ctx.runId,
        thread_id: ctx.threadId ?? undefined,
      }).catch(e => console.warn(`[${ctx.companionId}/reflect] marker write failed:`, e));
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
      }
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
