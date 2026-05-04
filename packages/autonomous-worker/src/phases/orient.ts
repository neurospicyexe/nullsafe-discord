import { LibrarianClient, formatRecentContext } from "@nullsafe/shared";
import { loadIdentity } from "../identity-loader.js";
import { appendLog, getActiveThreads, getPeerActivity } from "../halseth-client.js";
import { HALSETH_URL, HALSETH_SECRET } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 1: Orient
 * Load full identity + botOrient state + existing growth context.
 * Also extracts open loops, pressure flags, and active exploration threads
 * so the seed phase can make an informed decision rather than blindly pulling
 * from the queue.
 */
export async function runOrient(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "orient:start");

  ctx.identityText = loadIdentity(ctx.companionId);

  const librarian = new LibrarianClient({
    url: HALSETH_URL,
    secret: HALSETH_SECRET,
    companionId: ctx.companionId,
  });

  // Fetch botOrient + active threads + peer activity in parallel.
  // peerActivity is the triad layer: the OTHER two companions' last 5
  // journal entries, 3 patterns, 3 markers. Synthesize/reflect prompts
  // inject peer_summary so each companion is prehending the others'
  // becomings -- not exploring in isolation.
  const [orient, activeThreads, peerActivity] = await Promise.all([
    librarian.botOrient().catch(() => null),
    getActiveThreads(ctx.companionId),
    getPeerActivity(ctx.companionId, { journal: 5, patterns: 3, markers: 3 }),
  ]);

  ctx.activeThreads = activeThreads;
  ctx.peerActivity = peerActivity;

  if (orient) {
    ctx.orientSummary = formatRecentContext(orient);
    ctx.recentGrowth = orient.recent_growth ?? [];
    ctx.activePatterns = orient.active_patterns ?? [];

    const readyPrompt = (orient as { ready_prompt?: string }).ready_prompt ?? "";

    // Unexamined dream IDs -- write phase clears these after successful run
    // Format: [Unexamined dream [autonomous] id:UUID] «text»
    const dreamIdRe = /\[Unexamined dream[^\]]*\bid:([0-9a-f-]{36})\]/gi;
    const dreamIds: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = dreamIdRe.exec(readyPrompt)) !== null) dreamIds.push(m[1]);
    ctx.unexaminedDreamIds = dreamIds;

    // Open loops -- text content extracted for seed decision context
    // Format: [Open loop id:UUID] text  OR  [Open loop: text]
    const loopRe = /\[Open loop[^\]]*\]\s*([^\n\[]{5,120})/gi;
    const openLoops: Array<{ id: string; text: string }> = [];
    while ((m = loopRe.exec(readyPrompt)) !== null) {
      const idMatch = m[0].match(/\bid:([0-9a-f-]{36})/i);
      openLoops.push({ id: idMatch?.[1] ?? "unknown", text: m[1].trim() });
    }
    ctx.openLoops = openLoops;

    // Pressure flags -- short text snippets flagged as active pressure
    // Format: [Pressure: text]  OR  [pressure_flag: text]
    const pressureRe = /\[[Pp]ressure[_\s:][^\]]{3,100}\]/g;
    ctx.pressureFlags = (readyPrompt.match(pressureRe) ?? [])
      .map(s => s.replace(/^\[|\]$/g, "").trim());
  } else {
    console.warn(`[${ctx.companionId}/orient] botOrient returned null -- proceeding with empty context`);
    ctx.orientSummary = "";
    ctx.recentGrowth = [];
    ctx.activePatterns = [];
    ctx.unexaminedDreamIds = [];
    ctx.openLoops = [];
    ctx.pressureFlags = [];
  }

  const peerSummaryLen = ctx.peerActivity?.peer_summary?.length ?? 0;
  await appendLog(
    ctx.runId,
    "orient:complete",
    `identity=${ctx.identityText.length}chars orient=${ctx.orientSummary.length}chars ` +
    `growth=${ctx.recentGrowth.length} dreams=${ctx.unexaminedDreamIds.length} ` +
    `loops=${ctx.openLoops.length} pressure=${ctx.pressureFlags.length} threads=${ctx.activeThreads.length} ` +
    `peer_summary=${peerSummaryLen}chars`,
  );
}
