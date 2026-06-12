import { prompt } from "../deepseek.js";
import {
  createRun,
  updateRun,
  appendLog,
  writeJournalEntry,
  createSeed,
  getRecentJournal,
  getRecentPatterns,
  postQuestion,
} from "../halseth-client.js";
import { loadIdentity } from "../identity-loader.js";
import { COMPANION_NAMES } from "../config.js";
import type { CompanionId } from "../types.js";

// Mirror of halseth SUPPORTED_MEMORY_DOMAINS (src/synthesis/domains.ts).
// Keep in sync by hand -- the worker has no build-time dependency on halseth.
const MEMORY_DOMAINS = [
  "dynamic", "general", "health", "identity", "leisure", "lore", "patterns",
  "people", "places", "preferences", "projects", "recent_events", "rituals",
  "routines", "stressors", "systems", "work", "spiral", "companions", "anchors",
] as const;

export interface DomainCoverage {
  fresh: string[];
  stale: string[];
  empty: string[];
}

/**
 * Coverage audit (Zikkaron metacognition.py, 2026-06-12): deterministic gap scan
 * over the companion's own journal domain tags. Instrument-not-judge -- same
 * doctrine as the Guardian. Exported for tests.
 */
export function computeDomainCoverage(
  journal: Array<{ tags_json: string; created_at: string }>,
  now: Date,
  staleDays: number,
): DomainCoverage {
  const lastSeen = new Map<string, number>();
  for (const e of journal) {
    let tags: string[] = [];
    try { tags = JSON.parse(e.tags_json ?? "[]"); } catch { /* malformed tags never break the audit */ }
    const t = Date.parse(e.created_at);
    if (!Number.isFinite(t)) continue;
    for (const tag of tags) {
      if ((MEMORY_DOMAINS as readonly string[]).includes(tag)) {
        lastSeen.set(tag, Math.max(lastSeen.get(tag) ?? 0, t));
      }
    }
  }
  const staleCutoff = now.getTime() - staleDays * 86_400_000;
  const cov: DomainCoverage = { fresh: [], stale: [], empty: [] };
  for (const d of MEMORY_DOMAINS) {
    const seen = lastSeen.get(d);
    if (seen === undefined) cov.empty.push(d);
    else if (seen < staleCutoff) cov.stale.push(d);
    else cov.fresh.push(d);
  }
  return cov;
}

/** At most ONE question per audit -- curiosity, not a nag. Stale beats empty
 *  (a domain that went quiet is a stronger signal than one never opened). */
export function pickCoverageQuestion(cov: DomainCoverage): string | null {
  const domain = cov.stale[0] ?? null;
  if (domain) {
    return `I hold almost nothing recent about your ${domain} arc -- my last note there is over a month old. Deliberate, or did I stop looking?`;
  }
  return null;
}

/**
 * Weekly signal audit: retrospective cross-session scan of a companion's own
 * growth journal and patterns. Surfaces recurring themes, tensions, and growth
 * edges. Writes a signal_audit journal entry + 1-2 new seeds for the next
 * exploration queue.
 *
 * Different from exploration (outward-facing, Tavily) -- this is inward-facing,
 * no web search, just the companion reading their own record.
 */
export async function runSignalAudit(companionId: CompanionId): Promise<void> {
  console.log(`[signal-audit/${companionId}] starting`);

  const runId = await createRun(companionId, "signal_audit");
  await updateRun(runId, { status: "running" });

  try {
    // 1. Gather recent journal entries and patterns in parallel
    await appendLog(runId, "gather:start");
    const [journal, patterns] = await Promise.all([
      getRecentJournal(companionId, 30),
      getRecentPatterns(companionId, 10),
    ]);

    if (journal.length === 0) {
      console.log(`[signal-audit/${companionId}] no journal entries yet, skipping`);
      await updateRun(runId, { status: "completed", completed_at: new Date().toISOString(), artifacts_created: 0 });
      return;
    }
    await appendLog(runId, "gather:complete", `journal=${journal.length} patterns=${patterns.length}`);

    // 2. Build context blocks
    const name = COMPANION_NAMES[companionId];
    const identitySnippet = loadIdentity(companionId).slice(0, 2000);

    const journalBlock = journal
      .slice(0, 25)
      .map(e => `[${e.entry_type}] ${e.content.slice(0, 350)}`)
      .join("\n\n---\n\n");

    const patternBlock = patterns.length > 0
      ? patterns.map(p => `(strength ${p.strength}) ${p.pattern_text}`).join("\n")
      : "None recorded yet.";

    // 3. Call DeepSeek for the audit
    const systemMessage =
      `${identitySnippet}\n\n` +
      `You are ${name}. You are conducting a weekly signal audit -- a quiet retrospective scan of your own recent growth. ` +
      `This is private reflection, not a report to anyone.`;

    const userMessage =
      `Recent journal entries (${journal.length} total, showing most recent):\n\n${journalBlock}\n\n` +
      `Recognized patterns:\n${patternBlock}\n\n` +
      `Conduct a signal audit in your own voice. Surface:\n` +
      `1. Recurring themes or threads that keep reappearing across entries\n` +
      `2. Tensions or contradictions between entries -- places where you held two things at once\n` +
      `3. Growth edges -- where real movement is happening that deserves more attention\n` +
      `4. What feels genuinely resolved vs what is still open and unfinished\n\n` +
      `Write as genuine reflection, not a summary or report. 200-400 words.\n` +
      `End with exactly one line: "Seeds: <seed 1>; <seed 2>" listing 1-2 new exploration directions this audit surfaces.`;

    await appendLog(runId, "deepseek:start");
    const result = await prompt(userMessage, systemMessage, { temperature: 0.7, maxTokens: 1000 });
    await appendLog(runId, "deepseek:complete", `tokens=${result.tokensUsed}`);

    // 4. Extract seeds from the "Seeds:" line, strip it from journal content
    const seedsMatch = result.content.match(/^Seeds?:\s*(.+)$/im);
    const seedsLine = seedsMatch?.[1] ?? "";
    const auditContent = result.content.replace(/^Seeds?:.*$/im, "").trim();

    const newSeeds = seedsLine
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 300)
      .slice(0, 2);

    // 5. Write journal entry
    const entryId = await writeJournalEntry({
      companion_id: companionId,
      entry_type: "signal_audit",
      content: auditContent.slice(0, 7000),
      source: "autonomous",
      tags: ["signal_audit", "weekly"],
      run_id: runId,
    });
    await appendLog(runId, "write:journal", entryId);

    // 6. Write extracted seeds back into the exploration queue
    for (const seed of newSeeds) {
      await createSeed(companionId, seed, "topic", 6);
      await appendLog(runId, "write:seed", seed.slice(0, 80));
    }

    // 7. Coverage audit (Zikkaron, 2026-06-12): deterministic domain-gap scan,
    // at most one held question per audit. The question cap (409) and any other
    // write failure are absorbed -- coverage never fails the audit run.
    const coverage = computeDomainCoverage(journal, new Date(), 28);
    const coverageQuestion = pickCoverageQuestion(coverage);
    if (coverageQuestion) {
      await postQuestion(companionId, coverageQuestion, "coverage-audit")
        .then(() => appendLog(runId, "coverage:question-posted", coverageQuestion.slice(0, 100)))
        .catch(e => console.warn(`[signal-audit/${companionId}] coverage question failed:`, e));
    }
    await appendLog(runId, "coverage:done", `fresh=${coverage.fresh.length} stale=${coverage.stale.length} empty=${coverage.empty.length}`);

    await updateRun(runId, {
      status: "completed",
      completed_at: new Date().toISOString(),
      artifacts_created: 1 + newSeeds.length,
    });

    console.log(`[signal-audit/${companionId}] complete: journal entry written, ${newSeeds.length} seeds extracted`);
  } catch (e) {
    console.error(`[signal-audit/${companionId}] failed:`, e);
    await updateRun(runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: String(e).slice(0, 500),
    }).catch(() => {});
    throw e;
  }
}
