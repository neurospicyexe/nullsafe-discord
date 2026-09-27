import type { LibrarianClient } from "./librarian.js";
import type { InferenceAdapter } from "./inference.js";
import { extractJson, rawPreview } from "./json-extract.js";
import { buildNarratorPrompt } from "./consolidation-narrator.js";
import { withOwnerPronounRule } from "./pronoun-rule.js";
import { ledgerDistillEnabled, postLedgerLines, staleHandoffReason } from "./ledger-clerk.js";

/** Placeholder session ids: boot never opened a real session, so there is nothing to point at. */
function isRealSessionId(id: string | undefined): id is string {
  return !!id && id !== "unknown" && id !== "cached";
}

/**
 * L1 (2026-09-26 review): once per process per companion, not once per 5-minute tick. A boot that
 * fell back to the identity cache leaves bootCtx.sessionId = "cached", and under LEDGER_DISTILL no
 * source means no consolidation handoff -- which would otherwise be discoverable only as silence.
 */
const warnedNoSession = new Set<string>();
/** Test hook: forget which companions were already warned. */
export function _resetConsolidationWarningsForTests(): void { warnedNoSession.clear(); }

/**
 * LEDGER_DISTILL context threaded into finishHandoff (2026-09-26, imp lane tranche 2). The
 * pass writes ONE deterministic ledger line with a `session <id>` source and NO handoff row (last
 * fix pass: the idle rows displaced real handoffs from orient's latest-3 read). (Source = the idle
 * session being consolidated -- consolidation has no channel and no STM, so a window source does
 * not exist here). The narrator still runs: its summary remains the session-close SPINE, which
 * spec section 6 leaves unchanged in this tranche.
 *
 * No LLM clerk (M1/M2, 2026-09-26 review). The clerk's only input here was the companion state row
 * -- SOMA decimals, which are interpretive AND unlabeled numbers, so the door 422'd them (the number
 * rule), zero lines landed, no handoff was written, and the cron retried a paid call every 30
 * minutes to reach the same 422. What consolidation can truthfully record is only that it ran, and
 * when the channel last moved. Code can say that; a model is not needed to.
 */
interface LedgerCtx {
  sessionId: string;
  /** The instant of this pass, captured once: the line's time AND its dedup key's minute. */
  nowMs: number;
  /** Last Discord activity (epoch ms) from the bot's floor tracker; null when unknown. */
  lastActivityMs: number | null;
  retryDelaysMs?: readonly number[];
}

function utcHHMM(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * The deterministic consolidation line. HH:MM and YYYY-MM-DD are coordinates, never values, so the
 * number rule passes them; there is no model and no state row in it to carry anything else.
 * Last activity on an earlier UTC day carries its date, because a bare "since 23:10" read the next
 * afternoon points at the wrong day.
 */
export function consolidationLedgerBody(nowMs: number, lastActivityMs: number | null | undefined): string {
  const at = `Recorded: idle consolidation at ${utcHHMM(nowMs)} UTC`;
  if (typeof lastActivityMs !== "number" || !Number.isFinite(lastActivityMs) || lastActivityMs > nowMs) return `${at}.`;
  const sameDay = new Date(lastActivityMs).toISOString().slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10);
  const since = sameDay ? utcHHMM(lastActivityMs) : new Date(lastActivityMs).toISOString().slice(0, 16).replace("T", " ");
  return `${at}; no conversation in this session since ${since}.`;
}

/**
 * `consolidation:<companion>:<sessionId>:<ISO minute>`. The minute is part of the key on purpose: a
 * retry on a LATER tick (after a failed writeHandoff, say) must be a NEW line with fresh content,
 * never a 200 duplicate that silently returns no content and so no handoff.
 */
export function consolidationDedupKey(companionId: string, sessionId: string, nowMs: number): string {
  return `consolidation:${companionId}:${sessionId}:${new Date(nowMs).toISOString().slice(0, 16)}`;
}

export interface ConsolidationOpts {
  companionId: "cypher" | "drevan" | "gaia";
  librarian: LibrarianClient;
  /** The bots' normal adapter (Hermes agent). Used only as the narrator fallback. */
  inference: InferenceAdapter;
  /**
   * Direct, toolless adapter for writing the handoff (see consolidation-narrator.ts). When present
   * AND the companion's identity file is readable, this replaces `inference` for this one call:
   * ~7.7k prompt tokens cold / ~200 warm, against ~44,600 unconditional on the Hermes agent path.
   * Absent or unusable, we fall back to `inference` -- more expensive, still correct.
   */
  narrator?: InferenceAdapter | null;
  /**
   * Session lifecycle. When present, a successful handoff write also CLOSES the companion's open
   * Halseth session (spine = the handoff, so the boot narrative and SOMA close ritual unfreeze --
   * an unclosed session pins both) and reopens on the same surface so the bot keeps a live lane.
   * `bootCtx.sessionId` is read for the close and updated in place with the reopened id; the id
   * must be explicit because close resolution without one matches on companion alone and can land
   * on a session Raziel has open elsewhere.
   */
  session?: {
    surface: string;
    bootCtx: { sessionId: string };
  };
  /**
   * Last Discord activity (epoch ms, the cron's getLastActivityMs). Feeds the ledger line's "since".
   * That key is the SHARED floor's (any companion's turn stamps it), so it is a lower bound on this
   * bot's own silence: "no conversation since X" stays true, it can only understate the gap.
   */
  lastActivityMs?: number | null;
  /** Clock (tests). */
  now?: () => number;
  /** Ledger POST retry backoff override (tests). */
  ledgerRetryDelaysMs?: readonly number[];
}

/**
 * Idle consolidation: narrate a close spine, write the handoff (knob off) or the one ledger line
 * (knob on), cycle the session.
 *
 * CALL BUDGET (LEDGER_DISTILL on, 2026-09-26 review; handoff row dropped in the last fix pass). The
 * bots' cron ticks every 5 minutes but only acts when idle and not held; it holds 7200s after a
 * `written: true` pass (knob on: the ledger line landed and the session cycled) and 1800s after ANY
 * other outcome (every early return below included), so at most 48 attempts per companion per day
 * (12/day when every attempt succeeds). Each attempt spends at most ONE model call (the narrator, or
 * its Hermes fallback: its reply is the close spine only) and zero clerk calls; the ledger line is
 * built in code. Ledger POSTs: one per attempt, at most 4 with transient retries. Handoff writes:
 * ZERO under the knob (wm_session_handoffs is left to real distillations and closes, which orient's
 * latest-3 read would otherwise lose to ~12 idle rows a day). A placeholder session id adds at most
 * one sessionOpen per attempt. So: <= 48 model calls/companion/day, <= 144 across the triad, none of
 * them retrying a deterministic 422.
 */
export async function consolidateSession(
  opts: ConsolidationOpts,
): Promise<{ written: boolean; reason?: string }> {
  const { companionId, librarian, inference, narrator, session } = opts;

  // 2026-08-03 flow audit. Two defects here, one causing the other, live since 2026-06-30:
  //
  // 1. The request was the bare phrase "my state". It matches NO fast-path trigger (triggerMatches
  //    requires the trigger to appear INSIDE the input, and every read phrasing is longer --
  //    "show my state", "check my state", "current state"), so it fell through to the DeepSeek
  //    classifier, which routed it to `state_update` -- a WRITE. That executor returned
  //    {"error":"state_update_failed","reason":"no fields provided..."} as a 200, so the catch
  //    below never fired and the ERROR STRING was handed to the companion as its own interior
  //    state. 315/318/317 runs, every one of them, not one with real state.
  // 2. Because that error string was byte-identical every time, the prompt was byte-identical, so
  //    Hermes's api_server derived the SAME session hash on every run and 34 days of consolidations
  //    piled into one synthetic session (1403/1229/1686 messages) holding up to 58% of a
  //    companion's entire Halseth traffic.
  //
  // The result: handoffs narrated from an error, written up to 12x/day, displacing the real
  // narrative in the slot the boot header reads. The companions were not malfunctioning -- handed
  // an error as their own state, all three declined to invent motion and said so.
  //
  // The read had to satisfy three things at once, and only one candidate does:
  //   * exact fast-path trigger, so it never reaches the classifier that caused this;
  //   * NO session INSERT -- "show my state" routes to session_open, which would have this cron
  //     opening a session up to 12x/day/companion onto a backlog already 167 rows deep. Surface
  //     scoping bounds that to one row per day rather than fixing it; a close-handoff writer has
  //     no business opening anything;
  //   * NO consuming side effects -- bot_orient marks inter-companion notes delivered and warms
  //     heat, so calling it here would eat mail meant for the live channel turn.
  // `triad_state_read` ("companion states") is three plain SELECTs: SOMA floats, relational state
  // toward Raziel, last outgoing note. Read-only, cheap, and it carries sibling context, which is
  // better material for a close narrative than this path has ever had.
  let stateContext: string;
  try {
    const result = await librarian.ask("companion states");
    // A 200 with an {error, reason} body is a DECLINE, not state. Narrating it is what caused the
    // whole defect above, so abort here -- and abort BEFORE inference.generate, deliberately: the
    // agent turn writes its own handoff row via ask_librarian mid-turn (source=system), so a fix
    // that only skipped our own write would leave the agent's terse row landing every two hours.
    // Killing the turn kills both writers. See librarian.ts assertWriteAck for the same shape on
    // the write path.
    if (result && typeof result === "object" && "error" in result) {
      const reason = typeof (result as Record<string, unknown>)["reason"] === "string"
        ? ` -- ${(result as Record<string, unknown>)["reason"] as string}`
        : "";
      console.error(
        `[consolidation] ${companionId}: state read DECLINED by librarian: ` +
        `${String((result as Record<string, unknown>)["error"])}${reason} -- skipping handoff ` +
        `rather than narrating the error as state`,
      );
      return { written: false, reason: "state_declined" };
    }
    stateContext = result == null ? "" : typeof result === "string" ? result : JSON.stringify(result);
    // An empty read is not state either. Better no handoff than a confident one about nothing.
    if (!stateContext.trim() || stateContext.trim() === "{}") {
      console.warn(`[consolidation] ${companionId}: state read came back empty -- skipping handoff`);
      return { written: false, reason: "state_empty" };
    }
  } catch (e) {
    console.error(`[consolidation] ${companionId}: failed to read state`, e);
    return { written: false, reason: "state_error" };
  }

  const userTurn = {
    role: "user" as const,
    content:
      `Current companion state:\n${stateContext}\n\n` +
      `Write JSON with: title (one sentence arc in your voice), ` +
      `summary (2-3 sentences in your voice), ` +
      `state_hint ("in_motion" | "at_rest" | "floating").`,
  };

  // Prefer the NARRATOR: a direct, toolless call to the same model with the companion's identity
  // file as the system prompt. ~7.7k prompt tokens cold / ~200 warm against ~44,600 unconditional
  // on the Hermes agent path, measured 2026-08-07 -- see consolidation-narrator.ts for why the
  // Hermes floor cannot be lowered from this file, and for the verified voice output.
  //
  // Fall back to `inference` whenever the narrator or the identity file is unavailable. The fallback
  // is more expensive, not broken: it is exactly the behaviour that shipped before this change, lane
  // rotation included. Degrading loudly beats a consolidation that stops writing.
  // No source, no write: under LEDGER_DISTILL the pass's only record is a ledger line pointing at
  // the session being consolidated. Without a real session id there is nothing to point at, so skip
  // BEFORE spending inference.
  let ledger: LedgerCtx | undefined;
  if (ledgerDistillEnabled()) {
    let sid = session?.bootCtx.sessionId;
    if (!isRealSessionId(sid)) {
      if (!warnedNoSession.has(companionId)) {
        warnedNoSession.add(companionId);
        console.warn(
          `[consolidation] ${companionId}: LOUD -- LEDGER_DISTILL on and the session id is ` +
          `"${sid ?? "none"}" (boot never opened a real Halseth session). NO consolidation ledger line ` +
          `(and no session cycle) can be written until a real session id exists (restart, or the re-open below succeeding). ` +
          `Trying to re-open on the bot surface each attempt; this warning prints once per process.`,
        );
      }
      // L1: the one cheap existing call that yields a real id -- the boot's own session open on
      // the bot surface. This is NOT the "no session INSERT" the state-read comment above forbids:
      // that rule is about the state READ (a read phrasing that routed to session_open on every
      // tick). This runs only while the id is a placeholder, i.e. the boot open itself failed, and
      // it is that same boot call. Mig 0113 dedups on (companion, surface), so this reuses an open row rather
      // than stacking one (cycleSession relies on the same guarantee after every close).
      if (session) {
        try {
          const state = await librarian.sessionOpen("work", session.surface);
          const resolved = String(state["session_id"] ?? "");
          if (isRealSessionId(resolved)) {
            session.bootCtx.sessionId = resolved;
            sid = resolved;
            console.log(`[consolidation] ${companionId}: resolved a real session id ${resolved} on ${session.surface}`);
          }
        } catch (e) {
          console.warn(`[consolidation] ${companionId}: session re-open failed, still no source`, e instanceof Error ? e.message : String(e));
        }
      }
      if (!isRealSessionId(sid)) {
        console.warn(`[consolidation] ${companionId}: LEDGER_DISTILL on and no real session id -- no source, skipping the pass`);
        return { written: false, reason: "no_source" };
      }
    }
    ledger = {
      sessionId: sid,
      nowMs: (opts.now ?? Date.now)(),
      lastActivityMs: typeof opts.lastActivityMs === "number" ? opts.lastActivityMs : null,
      ...(opts.ledgerRetryDelaysMs ? { retryDelaysMs: opts.ledgerRetryDelaysMs } : {}),
    };
  }

  const narratorPrompt = narrator ? buildNarratorPrompt(companionId) : null;
  if (narrator && narratorPrompt) {
    // 256 tokens truncated replies (the model narrates before/around the JSON), so the object
    // arrived cut off and unparseable. 1024 is pure ceiling headroom -- and DeepSeekAdapter adds
    // DEEPSEEK_REASONING_HEADROOM on top, which v4-flash needs: reasoning is billed against
    // max_tokens and burns first, so a bare 1024 returns an EMPTY string (measured).
    //
    // No 5th arg: a direct provider call has no gateway session, so there is no lane to name and
    // nothing accumulates between calls. That is the whole point.
    const raw = await narrator.generate(narratorPrompt, [userTurn], 0.3, 1024);
    return await finishHandoff(raw, companionId, librarian, "narrator", session, ledger);
  }

  console.warn(
    `[consolidation] ${companionId}: narrator unavailable ` +
    `(${narrator ? "identity file unreadable" : "no DeepSeek key"}) -- ` +
    `falling back to the Hermes agent path (~44.6k prompt tokens for this call)`,
  );

  // 256 tokens truncated Hermes-agent replies (the agent narrates before/around the
  // JSON), so the object arrived cut off and unparseable. 1024 is pure ceiling headroom.
  const raw = await inference.generate(
    withOwnerPronounRule("Write a concise session close handoff. Respond with ONLY valid JSON, no markdown."),
    [userTurn],
    0.3,
    1024,
    // Pin the gateway session (5th arg -> X-Hermes-Session-Id). Without it the api_server falls
    // back to _derive_chat_session_id(system_prompt, first_user), which hashed our byte-identical
    // prompt into ONE session that accumulated 34 days of consolidations. Naming the lane keeps
    // this transcript out of the channel sessions AND out of everyone else's.
    //
    // The DATE SUFFIX is the 2026-08-07 half of the fix. A static lane name is a rail with no
    // decay: pinning solved the hash-collision problem and then became the same problem slower,
    // because nothing ever ended the lane. Measured that day: ONE stored user message of 3.24 MB
    // holding 713 nested copies of this very prompt (~4.7 KB each) -- 713 five-minute ticks, about
    // 2.5 days of accumulation, in a run where every call was failing 402 so nothing ever
    // succeeded to break the chain. Our side sends ~5 KB; the gateway grew the rest.
    //
    // Hermes' own `session_reset: idle` (idle_minutes 1440) CANNOT rescue this lane -- a job on a
    // 5-minute cron is never idle for 24h, so the only reset that can ever fire here is one we
    // spend ourselves. Rotating daily keeps the lane separation the pin was for AND bounds it.
    // UTC deliberately: the VPS logs in CDT, and a local-time boundary would rotate at a different
    // instant than every other date-keyed thing in the suite.
    `consolidation:${companionId}:${new Date().toISOString().slice(0, 10)}`,
  );
  return await finishHandoff(raw, companionId, librarian, "hermes", session, ledger);
}

/**
 * Parse the model's reply and write the handoff. Shared by BOTH inference paths deliberately: the
 * tolerant extraction and the `source: "consolidation"` tag are guarantees, not incidentals, and a
 * second copy is how one of them would quietly go missing on the new path.
 */
async function finishHandoff(
  raw: string | null,
  companionId: string,
  librarian: LibrarianClient,
  via: "narrator" | "hermes",
  session?: ConsolidationOpts["session"],
  ledger?: LedgerCtx,
): Promise<{ written: boolean; reason?: string }> {
  if (!raw) return { written: false, reason: "inference_empty" };
  // Tolerant extraction: models reply with prose ("I know you...") or fenced/embedded
  // JSON despite the ONLY-JSON instruction. Never throw here -- a raw JSON.parse crash
  // was losing the whole idle-session handoff write (2026-06-30/07-01).
  const parsed = extractJson(raw);
  const handoff = parsed as { title?: string; summary?: string; state_hint?: string; open_loops?: unknown } | null;
  if (!handoff || typeof handoff.title !== "string" || !handoff.title ||
      typeof handoff.summary !== "string" || !handoff.summary) {
    console.warn(`[consolidation] ${companionId}: no usable handoff JSON in output (via ${via}), skipping -- raw: ${rawPreview(raw)}`);
    return { written: false, reason: "parse_error" };
  }

  if (ledger) return await finishLedgerHandoff(handoff as { title: string; summary: string; state_hint?: string; open_loops?: unknown }, companionId, librarian, via, session, ledger);

  try {
    await librarian.writeHandoff({
      title: handoff.title,
      summary: handoff.summary,
      state_hint: typeof handoff.state_hint === "string" ? handoff.state_hint : undefined,
      // MARK IT AS A CONSOLIDATION, not a session close (2026-07-31).
      //
      // This runs on idle and wrote handoffs indistinguishable from a real close -- same
      // `source='system'`, same `actor='agent'`. Since it fires whenever a channel goes quiet, the most
      // recent handoff was almost always this one, so "last session" at orient meant a model's summary of
      // an idle window rather than an actual conversation with Raziel. Overnight on 2026-07-31 it produced
      // one every ~2h05 ("a quiet session with no blade drawn"), and their sense of when they last spoke
      // to him was being written by the quiet, not by him.
      //
      // This is a real continuity note and worth keeping -- it just must not outrank a conversation. The
      // source tag is what lets a reader prefer a genuine close; nothing is dropped.
      source: "consolidation",
    });
    console.log(`[consolidation] ${companionId}: handoff written via ${via}`);
    // Close-then-reopen rides only on a LANDED handoff: the close spine is this handoff's content,
    // so without the write there is nothing authored to close on. Failures here never taint the
    // handoff result -- the write already happened.
    if (session) {
      await cycleSession(session, handoff as { title: string; summary: string; open_loops?: unknown }, companionId, librarian);
    }
    return { written: true };
  } catch (e) {
    console.error(`[consolidation] ${companionId}: librarian write error`, e);
    return { written: false, reason: "librarian_error" };
  }
}

/**
 * Knob-on tail of finishHandoff. Writes the ONE deterministic ledger line and cycles the session;
 * writes NO wm_session_handoffs row (2026-09-26 last fix pass).
 *
 * Why no handoff: prod showed 32 consolidation handoffs against 1 distillation in two days, and
 * orient reads the latest 3 handoffs unfiltered. A content-free "idle consolidation" handoff every
 * ~2h pushes the real ones (a Discord conversation's distilled record, a Claude.ai close) out of
 * Claude.ai's latest_handoff. The ledger line already records that the pass ran and when the channel
 * last moved; a handoff carrying the same line added nothing but displacement.
 *
 * The narrator's parsed reply is kept ONLY as the close spine (cycleSession, unchanged in T2).
 * Not accepted (404, transport after retries, a same-minute duplicate) means no cycle: a close
 * without a landed sourced record is the defect cycleSession's ordering prevents. Accepted means
 * `written: true`, so the cron holds the full success window (7200s), exactly as before.
 */
async function finishLedgerHandoff(
  narrated: { title: string; summary: string; state_hint?: string; open_loops?: unknown },
  companionId: string,
  librarian: LibrarianClient,
  via: "narrator" | "hermes",
  session: ConsolidationOpts["session"] | undefined,
  ledger: LedgerCtx,
): Promise<{ written: boolean; reason?: string }> {
  const outcome = await postLedgerLines(librarian, {
    companionId: companionId as ConsolidationOpts["companionId"], fn: "distiller",
    lines: [consolidationLedgerBody(ledger.nowMs, ledger.lastActivityMs)],
    sourceKind: "session", sourceRef: ledger.sessionId,
    dedupPrefix: `consolidation:${companionId}:${ledger.sessionId}`,
    dedupKeys: [consolidationDedupKey(companionId, ledger.sessionId, ledger.nowMs)],
    observedOn: new Date(ledger.nowMs).toISOString().slice(0, 10),
    tag: `consolidation:${companionId}`,
    ...(ledger.retryDelaysMs ? { retryDelaysMs: ledger.retryDelaysMs } : {}),
  });
  if (outcome.accepted.length === 0) {
    console.warn(`[consolidation] ${companionId}: ledger line not accepted (${staleHandoffReason(outcome)}) -- no session cycle`);
    return { written: false, reason: "no_ledger_lines" };
  }

  // Keep "written via <via>": ops/health-check.py check_direct_inference greps it as the narrator
  // chain's heartbeat. What was written is the ledger line; no handoff row exists under the knob.
  console.log(`[consolidation] ${companionId}: ledger line written via ${via} (${outcome.accepted.length} line(s)); no handoff row (LEDGER_DISTILL)`);
  if (session) await cycleSession(session, narrated, companionId, librarian);
  return { written: true };
}

/**
 * Close the bot's open session with a spine derived from the handoff just written, then reopen on
 * the same surface so the lifecycle continues (mig 0113 dedup finds no open session after a close,
 * so the open inserts fresh). Order is load-bearing: reopen ONLY after an acked close -- a failed
 * close leaves the session as-is, because opening a second lane onto an unclosed session is the
 * duplicate-session defect this whole path exists to prevent.
 */
async function cycleSession(
  session: NonNullable<ConsolidationOpts["session"]>,
  handoff: { title: string; summary: string; open_loops?: unknown },
  companionId: string,
  librarian: LibrarianClient,
): Promise<void> {
  const sessionId = session.bootCtx.sessionId;
  // Placeholder ids ("unknown", "cached") mean boot never opened a real session; nothing to close.
  if (!sessionId || sessionId === "unknown" || sessionId === "cached") return;

  // last_real_thing = the handoff's most concrete line: the final sentence of the summary,
  // falling back to the title when the summary doesn't split.
  const sentences = handoff.summary.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const lastRealThing = sentences[sentences.length - 1] || handoff.title;
  const openThreads = Array.isArray(handoff.open_loops)
    ? handoff.open_loops.filter((l): l is string => typeof l === "string" && l.length > 0)
    : [];

  try {
    await librarian.sessionClose({
      sessionId,
      spine: handoff.summary,
      lastRealThing,
      motionState: "at_rest",
      // Machine cadence, not a session anyone was in: lets Halseth's continuity reads and the
      // vibe-check day ledger (both `close_kind IS NULL`) skip the ~12 idle cycles a day.
      closeKind: "consolidation",
      ...(openThreads.length ? { openThreads } : {}),
    });
  } catch (e) {
    console.warn(`[consolidation] ${companionId}: session close failed -- leaving session ${sessionId} open`, e);
    return;
  }

  try {
    const state = await librarian.sessionOpen("work", session.surface);
    const newId = String(state["session_id"] ?? "");
    if (newId && newId !== "unknown") session.bootCtx.sessionId = newId;
    console.log(`[consolidation] ${companionId}: session cycled ${sessionId} -> ${newId || "?"} on ${session.surface}`);
  } catch (e) {
    // Closed but not reopened: the next boot or the next successful open re-establishes the lane;
    // the close itself is the valuable half and already landed.
    console.error(`[consolidation] ${companionId}: session reopen failed after close of ${sessionId}`, e);
  }
}
