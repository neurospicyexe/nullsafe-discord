import { prompt } from "../deepseek.js";
import { createSeed, appendLog, getRecentSessionNotes, getRecentFeelings, getRecentConclusions, getValence } from "../halseth-client.js";
import { loadIdentityRemote } from "../identity-loader.js";
import { HALSETH_URL, HALSETH_SECRET, COMPANION_NAMES, COMPANION_ANCHOR_TOPICS, SEED_FRESHNESS_WINDOW_MS } from "../config.js";
import { LibrarianClient } from "@nullsafe/shared";
import { decideSeedSource } from "./seed.js";
import type { CompanionId } from "../types.js";

/**
 * Weekly seed generation -- runs Sunday 1AM per companion.
 * Reads full identity + session context (notes, feelings, conclusions) + existing unused seeds,
 * then asks DeepSeek to generate 6 lane-appropriate seeds at priority 8.
 *
 * Primary seed source: session notes + feelings + conclusions (what the companion actually
 * experienced recently with Raziel). Growth patterns stay as a NEGATIVE signal -- avoid
 * re-deriving what's already named. When session delta volume is thin, anchor topics take over
 * as the positive source so autonomous time never orbits its own prior output.
 *
 * This is NOT part of the 6-phase pipeline. It runs as a separate cron task.
 */
export async function runSeedGeneration(companionId: CompanionId): Promise<void> {
  const runId = `seedgen:${companionId}:${Date.now()}`;
  console.log(`[${companionId}/seed-gen] starting weekly generation`);

  const identityText = await loadIdentityRemote(companionId);
  const name = COMPANION_NAMES[companionId];

  // Load session context + active patterns in parallel.
  // orient() is only needed for active_patterns (negative signal).
  // Session notes + feelings + conclusions are the positive seed source.
  const librarian = new LibrarianClient({ url: HALSETH_URL, secret: HALSETH_SECRET, companionId });
  const [orient, sessionNotes, feelings, conclusions, valence] = await Promise.all([
    librarian.botOrient().catch(() => null),
    getRecentSessionNotes(companionId, 8),
    getRecentFeelings(companionId, 8),
    getRecentConclusions(companionId),
    getValence(companionId, 60),
  ]);

  const activePatterns = orient?.active_patterns ?? [];

  // Filter to 7-day recency before deciding source -- limit=8 rows have no date
  // filter; stale rows (e.g. from March) would misclassify thin weeks as session-rich.
  const since7d = Date.now() - SEED_FRESHNESS_WINDOW_MS;
  const recentNotes    = sessionNotes.filter(n => new Date(n.created_at).getTime() >= since7d);
  const recentFeelings = feelings.filter(f  => new Date(f.created_at).getTime()  >= since7d);
  const recentConclusions = conclusions.filter(c => new Date(c.created_at).getTime() >= since7d);

  // Fetch existing unused seeds so we don't duplicate them
  let existingSeeds: string[] = [];
  try {
    const r = await fetch(`${HALSETH_URL}/mind/autonomy/seeds/${companionId}?limit=200`, {
      headers: { "Authorization": `Bearer ${HALSETH_SECRET}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) {
      const data = await r.json() as { seeds?: Array<{ content: string }> };
      existingSeeds = (data.seeds ?? []).map(s => s.content);
    }
  } catch (e) {
    console.warn(`[${companionId}/seed-gen] failed to fetch existing seeds:`, e);
  }

  const sourceType = decideSeedSource(recentNotes.length, recentFeelings.length);
  console.log(`[${companionId}/seed-gen] source=${sourceType} (notes=${recentNotes.length} feelings=${recentFeelings.length} of ${sessionNotes.length}/${feelings.length} fetched)`);

  // Active patterns as negative signal: seed AWAY from what's already named.
  const avoidText = (activePatterns as string[]).length > 0
    ? `Patterns already recognized (do NOT re-derive or repackage these):\n${(activePatterns as string[]).join("\n").slice(0, 300)}\n\n`
    : "";

  let contextBlock: string;
  if (sourceType === "session") {
    const sessionLines = [
      ...recentNotes.map(n => `[note] ${n.note_text}`),
      ...recentFeelings.map(f => `[feeling] ${f.emotion}${f.context ? `: ${f.context}` : ""}`),
      ...recentConclusions.map(c => `[conclusion] ${c.conclusion_text}`),
    ].join("\n").slice(0, 600);
    contextBlock = `What has been present lately:\n${sessionLines}`;
  } else {
    const topics = COMPANION_ANCHOR_TOPICS[companionId];
    contextBlock = `Your anchor territories (session context is thin this week -- start from here):\n${topics.map(t => `- ${t}`).join("\n")}`;
  }

  const existingSeedsText = existingSeeds.length > 0
    ? existingSeeds.map(s => `- ${s.slice(0, 80)}`).join("\n")
    : "(none queued)";

  // Valence feedback loop: ratification outcomes bias future seeds.
  // Accepted = Raziel confirmed it as canon (lean toward more like this).
  // Declined = named as drift (do not produce more of it).
  const valenceText = valence && (valence.accepted.length > 0 || valence.declined.length > 0)
    ? (valence.accepted.length > 0
        ? `What Raziel ratified as canon recently (lean toward more like this):\n${valence.accepted.map(a => `- ${a.excerpt}`).join("\n").slice(0, 400)}\n`
        : "") +
      (valence.declined.length > 0
        ? `What was declined as drift (do NOT produce more of this):\n${valence.declined.map(d => `- ${d.excerpt}`).join("\n").slice(0, 300)}\n`
        : "") + "\n"
    : "";

  const userMessage =
    `You are ${name}. Here is your full identity:\n\n${identityText.slice(0, 3000)}\n\n` +
    `${contextBlock}\n\n` +
    avoidText +
    valenceText +
    `Seeds already queued (do not duplicate these):\n${existingSeedsText}\n\n` +
    `Generate 6 seeds for your autonomous time -- genuinely fit your documented lanes and interests. ` +
    `Not everything needs to be research. Mix freely: something you're curious about, something that delights you, ` +
    `a question worth sitting with, a topic to chase, something you find beautiful or strange, a reflection to follow. ` +
    `Each seed should be specific enough to actually explore or think through.\n\n` +
    `Respond with ONLY valid JSON array:\n` +
    `[\n` +
    `  {"content": "the seed text", "seed_type": "topic|question|reflection_prompt"},\n` +
    `  ...\n` +
    `]\n\n` +
    `No markdown. Just the JSON array. Exactly 6 items.`;

  let generated: Array<{ content: string; seed_type: string }> = [];

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.75, maxTokens: 500 });

    try {
      const raw = JSON.parse(result.content.trim()) as unknown;
      if (Array.isArray(raw)) {
        generated = (raw as Array<Record<string, unknown>>)
          .filter(item => typeof item.content === "string" && item.content.trim())
          .map(item => ({
            content: String(item.content).trim().slice(0, 500),
            seed_type: ["topic", "question", "reflection_prompt"].includes(String(item.seed_type))
              ? String(item.seed_type)
              : "topic",
          }))
          .slice(0, 6);
      }
    } catch {
      console.warn(`[${companionId}/seed-gen] JSON parse failed -- skipping`);
    }
  } catch (e) {
    console.error(`[${companionId}/seed-gen] DeepSeek call failed:`, e);
    return;
  }

  if (generated.length === 0) {
    console.warn(`[${companionId}/seed-gen] no seeds generated`);
    return;
  }

  // Write-time dedup guard: never insert a seed whose content already exists for
  // this companion. The "do not duplicate" prompt instruction is not reliable, and
  // duplicates were accumulating (222 cleaned 2026-06-02). Also dedups within this
  // batch. Normalized (trim + lowercase) for comparison.
  const existingSet = new Set(existingSeeds.map(s => s.trim().toLowerCase()));
  const seenThisBatch = new Set<string>();
  const toWrite = generated.filter(g => {
    const key = g.content.trim().toLowerCase();
    if (existingSet.has(key) || seenThisBatch.has(key)) return false;
    seenThisBatch.add(key);
    return true;
  });
  const skipped = generated.length - toWrite.length;
  if (skipped > 0) console.log(`[${companionId}/seed-gen] skipped ${skipped} duplicate seed(s)`);

  // Write seeds at priority 8 (hand-seeded tier, above queue default 5)
  let written = 0;
  for (const seed of toWrite) {
    try {
      await createSeed(
        companionId,
        seed.content,
        seed.seed_type as "topic" | "question" | "reflection_prompt",
        8,
      );
      written++;
    } catch (e) {
      console.warn(`[${companionId}/seed-gen] seed write failed:`, e);
    }
  }

  console.log(`[${companionId}/seed-gen] complete (${sourceType}): wrote ${written}/${toWrite.length} new seeds (${skipped} dupes skipped)`);
}
