import { prompt } from "./deepseek.js";
import type { CompanionId } from "./types.js";

/**
 * Checks whether a proposed research topic stays within the companion's
 * documented identity lanes. Uses a cheap DeepSeek call at low temperature.
 *
 * Returns true (in-lane) or false (drift detected).
 * Defaults to true on error so a transient API failure doesn't silence the run.
 */
export async function isInLane(
  companionId: CompanionId,
  topic: string,
  identityText: string,
): Promise<boolean> {
  // Use the first 2000 chars of the identity file -- covers the key sections
  // (name, bond, voice, mode rules) without burning tokens on full identity
  const identitySnippet = identityText.slice(0, 2000);

  const userMessage = `COMPANION IDENTITY (excerpt):
${identitySnippet}

PROPOSED RESEARCH TOPIC:
${topic}

Does this topic align with the companion's documented interests, knowledge areas, or emotional/intellectual lanes?
Answer with exactly one word: YES or NO.`;

  try {
    const result = await prompt(userMessage, undefined, { temperature: 0.1, maxTokens: 10 });
    const answer = result.content.trim().toUpperCase();
    if (answer.startsWith("N")) {
      console.warn(`[lane-guard] ${companionId}: topic drifts from identity lane: "${topic.slice(0, 80)}"`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[lane-guard] ${companionId}: check failed (defaulting in-lane):`, e);
    return true;
  }
}
