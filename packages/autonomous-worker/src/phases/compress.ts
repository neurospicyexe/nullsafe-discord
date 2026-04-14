// phases/compress.ts
// Memory compression maintenance phase. Called by the scheduler after each
// companion's exploration run. NOT part of runPipeline.

import { prompt } from "../deepseek.js";
import { getEligibleNotes, archiveNotes, type CompressibleNote } from "../halseth-client.js";
import type { CompanionId } from "../types.js";

const MAX_CORPUS_CHARS = 8000;

function buildCompressionPrompt(companionId: string, notes: CompressibleNote[]): string {
  const corpus = notes
    .map(n => `[${n.created_at.slice(0, 10)}] ${n.content}`)
    .join("\n\n")
    .slice(0, MAX_CORPUS_CHARS);

  return `You are compressing ${companionId}'s continuity notes from ${notes[0].created_at.slice(0, 10)} to ${notes[notes.length - 1].created_at.slice(0, 10)}.

Write a compact summary (150-250 words) preserving:
- What was happening in this period
- Key threads, tensions, or states active at the time
- Anything that might be needed for long-term continuity

Be factual. Do not editorialize. Preserve specific names, dates, and events.

## Notes to compress

${corpus}`;
}

export async function runCompress(companionId: CompanionId): Promise<void> {
  try {
    const eligible = await getEligibleNotes(companionId);
    if (eligible.length === 0) {
      console.log(`[compress/${companionId}] no eligible notes, skipping`);
      return;
    }

    console.log(`[compress/${companionId}] compressing ${eligible.length} notes`);

    const userMessage = buildCompressionPrompt(companionId, eligible);
    const result = await prompt(userMessage, undefined, { temperature: 0.3, maxTokens: 400 });

    const summary = result.content.trim();
    const archiveResult = await archiveNotes(companionId, eligible, summary);
    console.log(`[compress/${companionId}] archived ${archiveResult.archived} notes`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[compress/${companionId}] error (non-fatal): ${msg}`);
  }
}
