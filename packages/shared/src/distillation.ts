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
import { assertWriteAck } from "./librarian.js";
import type { WriteQueue } from "./write-queue.js";
import type { InferenceAdapter } from "./inference.js";
import { extractJson, rawPreview } from "./json-extract.js";
import { withOwnerPronounRule } from "./pronoun-rule.js";
import type { ChatMessage, CompanionId } from "./types.js";
import {
  ledgerDistillEnabled, LEDGER_CLERK_PROMPT, parseClerkResult, windowSource, postLedgerLines, ledgerSummary,
} from "./ledger-clerk.js";

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
  /** Direct toolless adapter for the ledger clerk (knob on). Absent -> `inference`. */
  clerk?: InferenceAdapter | null,
): Promise<void> {
  const tag = prompts.companionId;
  const history = stmStore.get(channelId);
  if (history.length === 0) return;
  console.log(`[${tag}] onChannelInactive: channel=${channelId} msgs=${history.length}`);

  // authorName, not role: every inbound message is stored role:"user", so a sibling's turn in an
  // inter_companion channel reduced to "user:" and the synthesis read it as Raziel speaking. The
  // output feeds witnessLog + synthesizeSession + writeHandoff + writeWmNote, so the fabrication
  // reached the handoff and every Claude.ai orient. runDistillation (below) already does this.
  const summaryInput = history.map((m) => `${m.authorName ?? m.role}: ${m.content}`).join("\n");

  // LEDGER_DISTILL (2026-09-26, imp lane tranche 2): the distiller becomes a clerk. The four
  // first-person writes stop; the clerk's record lines go to /ledger with a window source.
  if (ledgerDistillEnabled()) {
    await distillSessionToLedger(channelId, history, summaryInput, librarian, clerk ?? inference, inference, wq, prompts);
    stmStore.clear(channelId);
    return;
  }

  const synthResult = await inference.generate(withOwnerPronounRule(prompts.synthesisPrompt), [{ role: "user", content: summaryInput }]);
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
  const extractRaw = await inference.generate(withOwnerPronounRule(prompts.sessionExtractPrompt), [{ role: "user", content: summaryInput }]);
  if (extractRaw) {
    // Tolerant extraction: the model answers in prose or wraps/embeds the JSON often enough
    // that a raw JSON.parse threw daily on all three bots. Extract the first {...} block;
    // on failure warn + skip the structured writes (synthesis writes above already queued).
    const ext = extractJson(extractRaw) as SessionExtract | null;
    if (ext === null) {
      console.warn(`[${tag}] structured extract parse failed, skipping -- raw: ${rawPreview(extractRaw)}`);
    } else {
      const title = ext.title ?? "Discord session";
      const stateHint = deriveStateHint(ext.soma);
      wq.fireAndForget(`handoff:${channelId}`, async () => {
        // source: without it the server defaults to `system`, a lane readers may filter --
        // this handoff must stay attributable to the channel-inactive distillation path.
        await librarian.writeHandoff({ title, summary: synthResult, open_loops: ext.open_loops, state_hint: stateHint, next_steps: ext.next_steps, source: "distillation" });
      });
      if (hasSomaValue(ext.soma)) {
        wq.fireAndForget(`somaUpdate:${channelId}`, async () => {
          assertWriteAck(await librarian.ask("update my state", JSON.stringify(ext.soma)), "soma update");
        });
      }
      if (ext.emotion) {
        wq.fireAndForget(`feeling:${channelId}`, async () => {
          assertWriteAck(await librarian.ask("log a feeling", JSON.stringify({ emotion: ext.emotion, source: "discord_session", context: title })), "feeling log");
        });
      }
    }
  }

  stmStore.clear(channelId);
}

/**
 * The knob-on body of distillSessionOnInactive (2026-09-26).
 *
 * STOPPED: witnessLog, synthesizeSession, updatePromptContext, writeWmNote(synthResult) -- all
 * four wrote a first-person synth as the companion, with no source.
 *
 * KEPT: the handoff (Claude.ai's `latest_handoff` reads it), but its summary is now the ACCEPTED
 * ledger lines' server-rendered `content`, marks intact, and title/open_loops/next_steps come from
 * the clerk JSON. Nothing else may stand in for the summary: zero accepted lines means no handoff.
 *
 * KEPT UNCHANGED: the structured-extract call and the SOMA update + feeling log it drives (spec
 * section 6: Drevan and Raziel decide those). `state_hint` still derives from the extract's SOMA.
 */
async function distillSessionToLedger(
  channelId: string,
  history: ChatMessage[],
  summaryInput: string,
  librarian: LibrarianClient,
  clerk: InferenceAdapter,
  inference: InferenceAdapter,
  wq: WriteQueue,
  prompts: DistillationPrompts,
): Promise<void> {
  const tag = prompts.companionId;
  const companionId = prompts.companionId as CompanionId;

  const clerkRaw = await clerk.generate(LEDGER_CLERK_PROMPT, [{ role: "user", content: summaryInput }]);
  const clerkResult = parseClerkResult(clerkRaw);
  if (clerkResult === null) {
    console.warn(`[${tag}] onChannelInactive: clerk returned no JSON, no ledger lines -- raw: ${rawPreview(clerkRaw ?? "")}`);
  }

  // The ledger POSTs are awaited, not queued: the handoff needs their returned `content`.
  const win = windowSource(channelId, history);
  if (win.fallback) console.warn(`[${tag}] onChannelInactive: no STM timestamps, window source is the distillation instant`);
  const outcome = clerkResult && clerkResult.lines.length
    ? await postLedgerLines(librarian, {
        companionId, fn: "distiller", lines: clerkResult.lines,
        sourceKind: "window", sourceRef: win.ref,
        dedupPrefix: `distill:${companionId}:${channelId}:${win.firstTs}`,
        observedOn: win.observedOn, tag,
      })
    : null;
  const summary = outcome ? ledgerSummary(outcome) : "";

  // Structured extract: SOMA update + feeling log (unchanged) + the handoff's state_hint.
  const extractRaw = await inference.generate(withOwnerPronounRule(prompts.sessionExtractPrompt), [{ role: "user", content: summaryInput }]);
  const ext = extractRaw ? extractJson(extractRaw) as SessionExtract | null : null;
  if (extractRaw && ext === null) {
    console.warn(`[${tag}] structured extract parse failed, skipping -- raw: ${rawPreview(extractRaw)}`);
  }

  if (summary) {
    const title = clerkResult?.title ?? "Discord session";
    const stateHint = ext ? deriveStateHint(ext.soma) : undefined;
    wq.fireAndForget(`handoff:${channelId}`, async () => {
      await librarian.writeHandoff({
        title, summary, open_loops: clerkResult?.open_loops, state_hint: stateHint,
        next_steps: clerkResult?.next_steps, source: "distillation",
      });
    });
  } else {
    console.warn(`[${tag}] onChannelInactive: no ledger line accepted -- handoff skipped (nothing sourced to summarize) channel=${channelId}`);
  }

  if (ext) {
    const title = ext.title ?? "Discord session";
    if (hasSomaValue(ext.soma)) {
      wq.fireAndForget(`somaUpdate:${channelId}`, async () => {
        assertWriteAck(await librarian.ask("update my state", JSON.stringify(ext.soma)), "soma update");
      });
    }
    if (ext.emotion) {
      wq.fireAndForget(`feeling:${channelId}`, async () => {
        assertWriteAck(await librarian.ask("log a feeling", JSON.stringify({ emotion: ext.emotion, source: "discord_session", context: title })), "feeling log");
      });
    }
  }
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
  ownerDisplayName?: string,
  /** Subject for the knob-on ledger lines (this bot). */
  companionIdForLedger?: CompanionId,
  /** Direct toolless adapter for the ledger clerk (knob on). Absent -> `inference`. */
  clerk?: InferenceAdapter | null,
): Promise<void> {
  const history = stmStore.get(channelId);
  if (history.length < distillationInterval) return;

  const window = history.slice(-distillationInterval);
  const conversationText = window.map((m) => `${m.authorName ?? m.role}: ${m.content}`).join("\n");

  // The prompt always asks for human_blocks ("observations about the primary user"). In an
  // inter_companion window the owner never spoke, so any human block the model returns is
  // invented from a sibling's words. Only persist them when the owner is actually in the window.
  const ownerSpoke = !ownerDisplayName
    || window.some((m) => m.authorName === ownerDisplayName || m.authorName?.startsWith(`${ownerDisplayName} `));

  const result = await inference.generate(withOwnerPronounRule(distillationPrompt), [{ role: "user", content: conversationText }]);
  if (!result) return;

  // Tolerant extraction (same class as the structured-extract fix above): pull the first
  // {...} block so prose-wrapped JSON still lands; malformed output stays acceptable loss.
  const parsed = extractJson(result) as {
    persona_blocks?: Array<{ block_type: string; content: string }>;
    human_blocks?: Array<{ block_type: string; content: string }>;
  } | null;
  if (parsed !== null) {
    if (parsed.persona_blocks?.length) {
      wq.fireAndForget(`persona:${channelId}`, () => librarian.writePersonaBlocks(channelId, parsed.persona_blocks!));
    }
    if (parsed.human_blocks?.length && ownerSpoke) {
      wq.fireAndForget(`human:${channelId}`, () => librarian.writeHumanBlocks(channelId, parsed.human_blocks!));
      if (ledgerDistillEnabled()) {
        // LEDGER_DISTILL (2026-09-26): the mid-session orient bridge becomes ledger lines. The
        // human blocks are interpretive observations and cannot pass the ledger grammar, so the
        // clerk reads the same window instead -- fired under the SAME condition that used to write
        // the note, so the cadence is unchanged (one extra inference call per interval).
        const companionId = companionIdForLedger;
        if (companionId) {
          wq.fireAndForget(`ledger:distill:${channelId}`, async () => {
            const raw = await (clerk ?? inference).generate(LEDGER_CLERK_PROMPT, [{ role: "user", content: conversationText }]);
            const res = parseClerkResult(raw);
            if (!res || !res.lines.length) return;
            const win = windowSource(channelId, window);
            await postLedgerLines(librarian, {
              companionId, fn: "distiller", lines: res.lines,
              sourceKind: "window", sourceRef: win.ref,
              dedupPrefix: `distill-mid:${companionId}:${channelId}:${win.firstTs}`,
              observedOn: win.observedOn, tag: companionId,
            });
          });
        } else {
          console.warn(`[${channelId}] distillation: LEDGER_DISTILL on but no companion id passed -- ledger lines skipped`);
        }
      } else {
        // Bridge to Claude.ai orient: write human observations as wm_note so orient sees
        // Discord activity mid-conversation, not just after the 30-min channel-inactive timeout.
        const noteText = `[discord:distillation] ${parsed.human_blocks.map((b) => b.content).join(" ")}`;
        wq.fireAndForget(`wmNote:distill:${channelId}`, () => librarian.writeWmNote(noteText, channelId));
      }
    } else if (parsed.human_blocks?.length) {
      console.warn(`[${channelId}] distillation: dropped ${parsed.human_blocks.length} human block(s) -- owner absent from window`);
    }
  } // else: fail-silent -- malformed JSON from inference is acceptable loss
}
