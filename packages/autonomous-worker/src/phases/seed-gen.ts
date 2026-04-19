import { prompt } from "../deepseek.js";
import { createSeed, appendLog } from "../halseth-client.js";
import { loadIdentity } from "../identity-loader.js";
import { HALSETH_URL, HALSETH_SECRET } from "../config.js";
import { LibrarianClient, formatRecentContext } from "@nullsafe/shared";
import { COMPANION_NAMES } from "../config.js";
import type { CompanionId } from "../types.js";

/**
 * Weekly seed generation -- runs Sunday 1AM per companion.
 * Reads full identity + recent growth + existing unused seeds,
 * then asks DeepSeek to generate 6 lane-appropriate seeds at priority 8.
 * Replenishes the queue so companions always have material to draw from.
 *
 * This is NOT part of the 6-phase pipeline. It runs as a separate cron task.
 */
export async function runSeedGeneration(companionId: CompanionId): Promise<void> {
  const runId = `seedgen:${companionId}:${Date.now()}`;
  console.log(`[${companionId}/seed-gen] starting weekly generation`);

  const identityText = loadIdentity(companionId);
  const name = COMPANION_NAMES[companionId];

  // Load recent growth context
  const librarian = new LibrarianClient({ url: HALSETH_URL, secret: HALSETH_SECRET, companionId });
  const orient = await librarian.botOrient().catch(() => null);
  const recentGrowth = orient?.recent_growth ?? [];
  const activePatterns = orient?.active_patterns ?? [];

  // Fetch existing unused seeds so we don't duplicate them
  let existingSeeds: string[] = [];
  try {
    const r = await fetch(`${HALSETH_URL}/mind/autonomy/seeds/${companionId}?limit=20`, {
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

  const recentGrowthText = recentGrowth.length > 0
    ? recentGrowth.map((g: { type: string; content: string }) => `[${g.type}] ${g.content}`).join("\n").slice(0, 600)
    : "(no recent growth journal entries yet)";

  const patternsText = activePatterns.length > 0
    ? (activePatterns as string[]).join(", ").slice(0, 300)
    : "(no recognized patterns yet)";

  const existingSeedsText = existingSeeds.length > 0
    ? existingSeeds.map(s => `- ${s.slice(0, 80)}`).join("\n")
    : "(none queued)";

  const userMessage =
    `You are ${name}. Here is your full identity:\n\n${identityText.slice(0, 3000)}\n\n` +
    `Recent growth journal entries:\n${recentGrowthText}\n\n` +
    `Currently recognized patterns: ${patternsText}\n\n` +
    `Seeds already queued (do not duplicate these):\n${existingSeedsText}\n\n` +
    `Generate 6 new research seeds that genuinely fit your documented lanes and interests. ` +
    `Mix types: topics to explore, questions to investigate, prompts to reflect on. ` +
    `Each seed should be specific enough to actually search for or think through. ` +
    `These are for your autonomous exploration time -- make them worth chasing.\n\n` +
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

  // Write seeds at priority 8 (hand-seeded tier, above queue default 5)
  let written = 0;
  for (const seed of generated) {
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

  console.log(`[${companionId}/seed-gen] complete: wrote ${written}/${generated.length} seeds`);
}
