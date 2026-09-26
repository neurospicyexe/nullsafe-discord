// Writeback gate (S3, 2026-09-21).
//
// One entry point the bot handler calls after every reply, with three modes behind the
// WRITEBACK_GATE knob:
//
//   legacy     -- exactly today: the generative judge decides and authors, then we dispatch.
//   jev-shadow -- judge AND Jev run concurrently; the JUDGE's result is what gets written
//                 (writes are unchanged in shadow), and one JSONL line records what Jev would
//                 have done. This is the measurement mode; it changes nothing a companion sees.
//   jev        -- Jev decides (write? which kind? how salient? did the reply drift?), and only
//                 then does a generative call author the sentence. Jev failure falls back to
//                 the legacy judge: fail open to today's behaviour, never to silence.
//
// Everything here is best-effort. A memory that does not get written is a loss; a memory path
// that throws into the reply path is an outage.

import type { InferenceAdapter } from "./inference.js";
import { judgeWriteback, authorWriteback, type Writeback, type WritebackSpeaker } from "./memory.js";
import {
  jevWritebackEval, decideFromJev, readJevThresholds,
  type WritebackGateMode, type JevAnswers,
} from "./jev-gate.js";

/** The slice of the Librarian client this gate touches. Narrow on purpose: easy to fake. */
export interface WritebackLibrarian {
  addCompanionNote(content: string, channelId?: string): Promise<unknown>;
  /** Keyed judge write (2026-09-26): same REST path as speech, `external_id = judge:<messageId>`,
   *  `source = memory_judge`. Optional so older fakes and other callers keep working; when absent
   *  the write falls back to the unkeyed Librarian NL path. */
  journalJudgeNote?(content: string, channelId?: string, messageId?: string): Promise<unknown>;
  writeWmNote(content: string, channelId?: string, noteType?: string, correlationId?: string): Promise<unknown>;
  witnessLog(content: string, channelId?: string): Promise<unknown>;
  addLiveThread(params: { name: string; notes?: string }): Promise<unknown>;
}

export interface WritebackGateCtx {
  mode: WritebackGateMode;
  companionId: string;
  speaker: WritebackSpeaker;
  userMessage: string;
  assistantResponse: string;
  channelId: string;
  messageId: string;
  inference: InferenceAdapter;
  librarian: WritebackLibrarian;
  /** The handler passes the write queue's fireAndForget with APPEND_MAX_AGE_MS bound. */
  enqueue: (label: string, fn: () => Promise<void>) => void;
  shadowLog?: (line: Record<string, unknown>) => void;
  jevEval?: typeof jevWritebackEval;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Shadow log
// ---------------------------------------------------------------------------

/** An unwritable log path is a deployment fact, not a per-message event: complain once. */
let warnedShadowLog = false;

export function appendShadowLine(line: Record<string, unknown>): void {
  const path = process.env.JEV_SHADOW_LOG ?? "/app/logs/jev-shadow.jsonl";
  let payload: string;
  try {
    payload = `${JSON.stringify(line)}\n`;
  } catch {
    return; // a line we cannot serialise is not worth crashing over
  }
  // Imported lazily so a jest environment that never shadow-logs does not need node:fs wired up.
  import("node:fs").then(({ appendFile }) => {
    appendFile(path, payload, (err) => {
      if (err && !warnedShadowLog) {
        warnedShadowLog = true;
        console.warn(`[jev-gate] shadow log unwritable: ${String(err).slice(0, 200)}`);
      }
    });
  }).catch((e) => {
    if (!warnedShadowLog) {
      warnedShadowLog = true;
      console.warn(`[jev-gate] shadow log unwritable: ${String(e).slice(0, 200)}`);
    }
  });
}

/** Test seam for the warn-once flag above. */
export function __resetShadowLogWarning(): void {
  warnedShadowLog = false;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The write itself. Identical to the block that used to live inline in bot-message-handler,
 * with ONE addition: companion_note writes the wm note only when promoted. companion_journal
 * is not read by Claude.ai's orient and wm_continuity_notes is, so the wm copy is what makes a
 * Discord observation visible at the next Claude.ai boot -- which is exactly why it should not
 * be every trivial note once Jev can tell them apart. In legacy and shadow modes promoteToWm is
 * always true, so behaviour is unchanged there.
 */
export async function dispatchWriteback(
  wb: Exclude<Writeback, null>,
  librarian: WritebackLibrarian,
  opts: { promoteToWm: boolean; channelId?: string; messageId?: string },
): Promise<void> {
  if (wb.type === "companion_note") {
    // KEYED when possible (2026-09-26): the judge's note memorialising a fabricated number could
    // only be found by content and archived by hand. With the key, `<prefix>: retract` reaches it.
    const key = opts.messageId ? `judge:${opts.messageId}` : undefined;
    if (librarian.journalJudgeNote && opts.messageId) {
      await librarian.journalJudgeNote(wb.content, opts.channelId, opts.messageId);
    } else {
      await librarian.addCompanionNote(wb.content, opts.channelId);
    }
    if (opts.promoteToWm) {
      await librarian.writeWmNote(`[discord:observation] ${wb.content}`, opts.channelId, undefined, key);
    }
  } else if (wb.type === "witness_log") {
    await librarian.witnessLog(wb.content, opts.channelId);
  } else if (wb.type === "thread_open") {
    await librarian.addLiveThread({ name: wb.name, notes: wb.notes });
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function runWritebackGate(ctx: WritebackGateCtx): Promise<void> {
  const {
    mode, companionId, speaker, userMessage, assistantResponse,
    channelId, messageId, inference, librarian, enqueue,
  } = ctx;
  const now = ctx.now ?? Date.now;
  const jevEval = ctx.jevEval ?? jevWritebackEval;
  const emit = ctx.shadowLog ?? appendShadowLine;

  const dispatch = (wb: Writeback, promoteToWm: boolean) => {
    if (!wb) return;
    enqueue(`writeback:${channelId}`, async () => {
      await dispatchWriteback(wb, librarian, { promoteToWm, channelId, messageId });
    });
  };

  const baseLine = () => ({
    ts: new Date(now()).toISOString(),
    mode,
    companion: companionId,
    channel_id: channelId,
    message_id: messageId,
    speaker: speaker.isOwner ? "owner" : "peer",
    speaker_name: speaker.name,
  });

  if (mode === "legacy") {
    const wb = await judgeWriteback(userMessage, assistantResponse, inference, companionId, speaker);
    dispatch(wb, true);
    return;
  }

  const thresholds = readJevThresholds(companionId, ctx.env ?? process.env);
  const evalInput = {
    companionId, speaker, userMessage, assistantResponse,
    ...(ctx.env ? { env: ctx.env } : {}),
  };

  if (mode === "jev-shadow") {
    // Writes are unchanged in shadow: the judge's verdict is what lands, and Jev only observes.
    const [wb, jev] = await Promise.all([
      judgeWriteback(userMessage, assistantResponse, inference, companionId, speaker),
      jevEval(evalInput),
    ]);
    dispatch(wb, true);

    if (!jev.ok) {
      emit?.({ ...baseLine(), judge: wb?.type ?? "skip", jev_ok: false, reason: jev.reason, wall_ms: jev.wall_ms });
      return;
    }

    const d = decideFromJev(jev.answers, companionId, thresholds, speaker);
    emit?.({
      ...baseLine(),
      judge: wb?.type ?? "skip",
      jev_ok: true,
      worth: d.worth,
      kind: d.kind,
      kind_probs: kindProbs(jev.answers),
      salience: d.salience,
      affect: d.affect,
      recurring: d.recurring,
      drift: d.drift,
      drift_flag: d.driftFlag,
      would_write: d.write,
      would_promote: d.promoteToWm,
      latency_ms: jev.latency_ms,
      wall_ms: jev.wall_ms,
    });
    if (d.driftFlag) {
      console.warn(`[jev-gate] drift companion=${companionId} p=${d.drift} message=${messageId}`);
    }
    return;
  }

  // mode === "jev"
  const jev = await jevEval(evalInput);

  if (!jev.ok) {
    // Fail open to today's judge, never to silence.
    console.warn(`[jev-gate] fallback=legacy reason=${jev.reason}`);
    const wb = await judgeWriteback(userMessage, assistantResponse, inference, companionId, speaker);
    dispatch(wb, true);
    emit?.({ ...baseLine(), jev_ok: false, reason: jev.reason, wall_ms: jev.wall_ms, decided: wb?.type ?? "skip", fallback: "legacy" });
    return;
  }

  const d = decideFromJev(jev.answers, companionId, thresholds, speaker);
  if (d.driftFlag) {
    console.warn(`[jev-gate] drift companion=${companionId} p=${d.drift} message=${messageId}`);
  }

  const line = {
    ...baseLine(),
    jev_ok: true,
    worth: d.worth,
    kind: d.kind,
    kind_probs: kindProbs(jev.answers),
    salience: d.salience,
    affect: d.affect,
    recurring: d.recurring,
    drift: d.drift,
    drift_flag: d.driftFlag,
    would_write: d.write,
    would_promote: d.promoteToWm,
    latency_ms: jev.latency_ms,
    wall_ms: jev.wall_ms,
  };

  if (!d.write) {
    // No generative call at all: this is where the cost saving lives.
    emit?.({ ...line, decided: "skip" });
    return;
  }

  let wb: Writeback = null;
  try {
    wb = await authorWriteback(
      d.kind, userMessage, assistantResponse, inference, companionId, speaker,
      { driftNote: d.driftFlag },
    );
  } catch (e) {
    console.error(`[jev-gate] authorWriteback failed:`, e);
    emit?.({ ...line, decided: "author_failed" });
    return;
  }

  dispatch(wb, d.promoteToWm);
  emit?.({ ...line, decided: wb ? d.kind : "dropped" });
}

function kindProbs(answers: JevAnswers): Record<string, number> | undefined {
  const a = answers?.kind;
  return a && a.type === "choice" ? a.probabilities : undefined;
}
