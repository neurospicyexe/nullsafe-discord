import { LibrarianClient, formatRecentContext } from "@nullsafe/shared";
import { loadIdentity } from "../identity-loader.js";
import { appendLog } from "../halseth-client.js";
import { HALSETH_URL, HALSETH_SECRET } from "../config.js";
import type { PipelineContext } from "../types.js";

/**
 * Phase 1: Orient
 * Load full identity + botOrient state + existing growth context.
 * Builds the working context that all subsequent phases read from.
 */
export async function runOrient(ctx: PipelineContext): Promise<void> {
  await appendLog(ctx.runId, "orient:start");

  // Full identity from disk (cached after first read)
  ctx.identityText = loadIdentity(ctx.companionId);

  // botOrient: same call the Discord bot makes at startup
  const librarian = new LibrarianClient({
    url: HALSETH_URL,
    secret: HALSETH_SECRET,
    companionId: ctx.companionId,
  });

  const orient = await librarian.botOrient().catch(() => null);

  if (orient) {
    ctx.orientSummary = formatRecentContext(orient);
    ctx.recentGrowth = orient.recent_growth ?? [];
    ctx.activePatterns = orient.active_patterns ?? [];
  } else {
    console.warn(`[${ctx.companionId}/orient] botOrient returned null -- proceeding with empty context`);
    ctx.orientSummary = "";
    ctx.recentGrowth = [];
    ctx.activePatterns = [];
  }

  await appendLog(ctx.runId, "orient:complete", `identity=${ctx.identityText.length}chars orient=${ctx.orientSummary.length}chars growth=${ctx.recentGrowth.length}entries`);
}
