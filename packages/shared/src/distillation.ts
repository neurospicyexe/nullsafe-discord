// Shared session-distillation orchestration for the companion bots.
//
// onChannelInactive (end-of-session synthesis + handoff + SOMA update) and runDistillation
// (mid-session persona/human memory blocks) were copy-pasted identically into all three bots.
// The only per-bot variation is the prompt text: each companion summarizes in its own voice and
// reports its own SOMA schema (Cypher acuity/presence/warmth, Drevan heat/reach/weight, Gaia
// stillness/density/perimeter). Those prompt strings live in each bot's config.ts as identity
// content; this module owns the identical orchestration around them.

import type { StmStore } from "./stm.js";
import type { LibrarianClient } from "./librarian.js";
import type { WriteQueue } from "./write-queue.js";
import type { InferenceAdapter } from "./inference.js";

/**
 * Per-bot prompt text for end-of-session distillation. The companion's voice and SOMA schema are
 * identity, so they live in config. (runDistillation's mid-session prompt is passed separately.)
 */
export interface DistillationPrompts {
  /** Companion id, for log tagging. */
  companionId: string;
  /** Session-summary prompt ("Summarize/Witness this conversation in X's voice ..."). */
  synthesisPrompt: string;
  /** Structured-extract prompt: JSON skeleton + per-bot SOMA descriptor line. */
  sessionExtractPrompt: string;
}

interface SessionExtract {
  title?: string;
  open_loops?: string[];
  soma?: Record<string, string>;
  emotion?: string | null;
  next_steps?: string[];
}

/**
 * Build the handoff `state_hint` from a SOMA object: non-empty "key: value" pairs joined by ", ".
 * Generic over field names so each companion's distinct SOMA schema works unchanged.
 * Returns undefined when soma is absent (preserving the original `ext.soma ? ... : undefined`).
 */
export function deriveStateHint(soma: Record<string, string> | undefined): string | undefined {
  return soma
    ? Object.entries(soma).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ")
    : undefined;
}

/** Whether a SOMA object carries at least one truthy field (gate for queuing a state update). */
export function hasSomaValue(soma: Record<string, string> | undefined): boolean {
  return !!soma && Object.values(soma).some((v) => v);
}

/**
 * End-of-session distillation: synthesize the conversation, queue continuity writes, then extract
 * structured metadata (handoff + SOMA update + feeling). Byte-for-byte the bots' onChannelInactive.
 */
export async function distillSessionOnInactive(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  wq: WriteQueue,
  prompts: DistillationPrompts,
): Promise<void> {
  const tag = prompts.companionId;
  const history = stmStore.get(channelId);
  if (history.length === 0) return;
  console.log(`[${tag}] onChannelInactive: channel=${channelId} msgs=${history.length}`);

  const summaryInput = history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const synthResult = await inference.generate(prompts.synthesisPrompt, [{ role: "user", content: summaryInput }]);
  if (!synthResult) {
    console.warn(`[${tag}] onChannelInactive: synthesis null, skipping all writes channel=${channelId}`);
    return;
  }

  wq.fireAndForget(`witnessLog:${channelId}`, async () => { await librarian.witnessLog(synthResult, channelId); });
  wq.fireAndForget(`synthesize:${channelId}`, async () => { await librarian.synthesizeSession(synthResult, channelId); });
  wq.fireAndForget(`promptCtx:${channelId}`, async () => { await librarian.updatePromptContext(synthResult); });
  // Bridge to Claude.ai orient: wm_continuity_notes (salience=high) IS read by orient;
  // companion_journal is NOT. This closes the Discord → Claude.ai visibility gap.
  wq.fireAndForget(`wmNote:${channelId}`, async () => { await librarian.writeWmNote(synthResult, channelId); });
  console.log(`[${tag}] onChannelInactive: 4 writes queued channel=${channelId}`);

  // Structured extract: handoff record + SOMA update + feeling log
  const extractRaw = await inference.generate(prompts.sessionExtractPrompt, [{ role: "user", content: summaryInput }]);
  if (extractRaw) {
    try {
      const ext = JSON.parse(extractRaw) as SessionExtract;
      const title = ext.title ?? "Discord session";
      const stateHint = deriveStateHint(ext.soma);
      wq.fireAndForget(`handoff:${channelId}`, async () => {
        await librarian.writeHandoff({ title, summary: synthResult, open_loops: ext.open_loops, state_hint: stateHint, next_steps: ext.next_steps });
      });
      if (hasSomaValue(ext.soma)) {
        wq.fireAndForget(`somaUpdate:${channelId}`, async () => {
          await librarian.ask("update my state", JSON.stringify(ext.soma));
        });
      }
      if (ext.emotion) {
        wq.fireAndForget(`feeling:${channelId}`, async () => {
          await librarian.ask("log a feeling", JSON.stringify({ emotion: ext.emotion, source: "discord_session", context: title }));
        });
      }
    } catch { console.warn(`[${tag}] structured extract parse failed`); }
  }

  stmStore.clear(channelId);
}

/**
 * Mid-session distillation: every `distillationInterval` messages, extract typed persona/human
 * memory blocks and bridge human observations to orient. Byte-for-byte the bots' runDistillation.
 */
export async function runDistillation(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: InferenceAdapter,
  wq: WriteQueue,
  distillationPrompt: string,
  distillationInterval: number,
): Promise<void> {
  const history = stmStore.get(channelId);
  if (history.length < distillationInterval) return;

  const window = history.slice(-distillationInterval);
  const conversationText = window.map((m) => `${m.authorName ?? m.role}: ${m.content}`).join("\n");

  const result = await inference.generate(distillationPrompt, [{ role: "user", content: conversationText }]);
  if (!result) return;

  try {
    const parsed = JSON.parse(result) as {
      persona_blocks?: Array<{ block_type: string; content: string }>;
      human_blocks?: Array<{ block_type: string; content: string }>;
    };
    if (parsed.persona_blocks?.length) {
      wq.fireAndForget(`persona:${channelId}`, () => librarian.writePersonaBlocks(channelId, parsed.persona_blocks!));
    }
    if (parsed.human_blocks?.length) {
      wq.fireAndForget(`human:${channelId}`, () => librarian.writeHumanBlocks(channelId, parsed.human_blocks!));
      // Bridge to Claude.ai orient: write human observations as wm_note so orient sees
      // Discord activity mid-conversation, not just after the 30-min channel-inactive timeout.
      const noteText = `[discord:distillation] ${parsed.human_blocks.map((b) => b.content).join(" ")}`;
      wq.fireAndForget(`wmNote:distill:${channelId}`, () => librarian.writeWmNote(noteText, channelId));
    }
  } catch { /* fail-silent -- malformed JSON from inference is acceptable loss */ }
}
