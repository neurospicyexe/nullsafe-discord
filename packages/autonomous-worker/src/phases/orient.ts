import { LibrarianClient, formatRecentContext } from "@nullsafe/shared";
import { loadIdentity } from "../identity-loader.js";
import {
  appendLog, getActiveThreads, getPeerActivity, getRecentWmNotes,
  getRecentSessionNotes, getRecentFeelings, getRecentConclusions,
} from "../halseth-client.js";
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
  const [orient, activeThreads, peerActivity, recentWmNotes, recentSessionNotes, recentFeelings, recentConclusions] = await Promise.all([
    librarian.botOrient().catch(() => null),
    getActiveThreads(ctx.companionId),
    getPeerActivity(ctx.companionId, { journal: 5, patterns: 3, markers: 3 }),
    getRecentWmNotes(ctx.companionId, { sinceHours: 24, limit: 20 }),
    getRecentSessionNotes(ctx.companionId, 8),
    getRecentFeelings(ctx.companionId, 8),
    getRecentConclusions(ctx.companionId),
  ]);

  ctx.activeThreads = activeThreads;
  ctx.peerActivity = peerActivity;
  ctx.recentWmNotes = recentWmNotes;
  ctx.recentSessionNotes = recentSessionNotes;
  ctx.recentFeelings = recentFeelings;
  ctx.recentConclusions = recentConclusions;

  if (orient) {
    ctx.orientSummary = formatRecentContext(orient);
    ctx.recentGrowth = orient.recent_growth ?? [];
    ctx.activePatterns = orient.active_patterns ?? [];

    // Structured carried-between-sessions surfaces from bot_orient.
    // Previously this phase regex-scraped a `ready_prompt` field that bot_orient never
    // returns (it returns structured `data`), so dreams/loops/pressure were ALWAYS empty
    // and unexamined dreams never got cleared -- they accumulated and flooded every orient.
    // bot_orient now provides these as structured arrays; read them directly.
    ctx.unexaminedDreamIds = (orient.unexamined_dreams ?? []).map(d => d.id).filter(Boolean);
    ctx.openLoops = (orient.open_loops ?? [])
      .map(l => ({ id: l.id ?? "unknown", text: (l.loop_text ?? "").trim() }))
      .filter(l => l.text.length > 0);
    ctx.pressureFlags = (orient.pressure_flags ?? []).map(s => s.trim()).filter(Boolean);
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
    `peer_summary=${peerSummaryLen}chars wm_notes=${ctx.recentWmNotes.length} ` +
    `session_notes=${ctx.recentSessionNotes.length} feelings=${ctx.recentFeelings.length} conclusions=${ctx.recentConclusions.length}`,
  );
}
