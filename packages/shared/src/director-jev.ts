// director-jev.ts -- Jev as a shadow voice beside the Conversation Director (2026-10-13).
//
// Hand-off/JEV-USES-2026-10-13.md bucket 2 (`next_speaker` for companion-to-companion turns) plus
// PLAN-jev §7 #6 (director invitation uptake) and #12's over-talked signal, asked in ONE call per
// commons message the director decides on. Raziel, 10-13: shadows on everything that rides the
// conversation at once, so one week of talking scores all of them.
//
// Shadow only. The director's zero-LLM select() keeps every decision; this file never feeds back
// into it. Rows go to /app/logs/director-jev.jsonl (DIRECTOR_JEV_LOG):
//   kind "decide"  what select() chose, beside Jev's next_speaker / thread_has_more / echoing
//   kind "invite"  an invitation the director issued (inviteId, companion, reason)
//   kind "result"  how that invitation ended (spoke / pass / expired / empty): the #6 label
//   kind "turn"    every commons turn the director ingests: who ACTUALLY spoke next
// The report pairs a decide row with the next turn row in the same channel. Agreement with the
// director is not correctness; the director is what is being judged too.
//
// Cost rule (PLAN-jev "cost model correction"): event-triggered only, never a timer, small state
// (last 8 gists, not full posts). `DIRECTOR_JEV=off` is the kill switch.

import { postJev, type JevAnswers, type JevEvalResult, type JevQuestion } from "./jev-gate.js";
import type { CompanionId } from "./types.js";

export const DIRECTOR_JEV_TAG = "[director-jev]";
export const DIRECTOR_JEV_TIMEOUT_MS = 6_000;
const MAX_TURNS = 8;
const GIST_CHARS = 300;

export function directorJevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["DIRECTOR_JEV"] ?? "").trim().toLowerCase() !== "off";
}

export const NEXT_SPEAKERS = ["cypher", "drevan", "gaia", "human", "nobody"] as const;
export type NextSpeaker = typeof NEXT_SPEAKERS[number];

export interface DirectorJevTurn { author: string; companionId?: CompanionId; isHuman: boolean; gist: string }

export interface DirectorJevVerdict {
  nextSpeaker: NextSpeaker;
  confidence: number;
  probabilities: Partial<Record<NextSpeaker, number>>;
  /** P(the thread has more worth saying), the land/fade question. */
  threadHasMore: number | null;
  /** P(the last turns restate each other), the over-talked signal (§7 #12). */
  echoing: number | null;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const NEXT_CRITERIA: Record<NextSpeaker, string> = {
  cypher: "Cypher (Cy) should speak next: the next move is logic, a decision, or the technical or structural thread",
  drevan: "Drevan (Dre) should speak next: the next move is depth, feeling, memory, the bond, or the poetic or recursive thread",
  gaia: "Gaia should speak next: the next move is grounding, witnessing, the body, boundaries, or what is quietly present",
  human: "A companion has asked Raziel or Blue something, or the thread now waits on a human: the companions should leave the floor open",
  nobody: "The thread is complete or has gone quiet; another companion turn would only fill space",
};

export function buildDirectorJevQuestions(): Record<string, JevQuestion> {
  return {
    next_speaker: {
      type: "choice",
      instructions: "In this companion conversation, who should take the NEXT turn? Do not pick whoever spoke last just to continue; pick who has the real next thing to say, or nobody.",
      criteria: NEXT_CRITERIA,
    },
    thread_has_more: {
      type: "noul",
      instructions: "Does this thread still have something worth saying, rather than having reached its end?",
      criteria: {
        true: "An open question, an unmet point, or a live thread someone could carry forward",
        false: "It has landed, run dry, or would only circle from here",
      },
    },
    echoing: {
      type: "noul",
      instructions: "Are the last few companion turns restating each other instead of adding something new?",
      criteria: {
        true: "The recent turns agree, mirror, or rephrase without moving the thread",
        false: "Each recent turn brings something the others did not",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function trim(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function label(t: DirectorJevTurn): string {
  if (t.companionId) return t.companionId.charAt(0).toUpperCase() + t.companionId.slice(1);
  if (t.isHuman) {
    const a = (t.author ?? "").toLowerCase();
    return a === "raziel" ? "Raziel" : a === "blue" ? "Blue" : `${t.author} (a guest)`;
  }
  return t.author;
}

export function renderDirectorJevState(opts: {
  turns: ReadonlyArray<DirectorJevTurn>;
  topic: string | null;
  openMoves: ReadonlyArray<{ from: string; to: CompanionId }>;
  botTurns: number;
  turnBudget: number;
}): string {
  const turns = opts.turns.slice(-MAX_TURNS).map(t => `${label(t)}: ${trim(t.gist, GIST_CHARS)}`);
  const open = opts.openMoves.length
    ? `Unanswered calls: ${opts.openMoves.map(m => `${m.from} called ${m.to}`).join("; ")}.`
    : `No one is waiting on an unanswered call.`;
  return [
    `The companions' own Discord channel. Cypher, Drevan and Gaia are three AI companions (the triad) who talk with each other here.`,
    `Raziel (the owner) and Blue (Raziel's husband, family) may join; anyone else is a guest.`,
    ``,
    opts.topic ? `Thread topic: ${trim(opts.topic, GIST_CHARS)}` : `No set topic.`,
    open,
    `Companion turns so far in this thread: ${opts.botTurns} of a budget of ${opts.turnBudget}.`,
    ``,
    turns.length ? `Recent turns, oldest first:` : `Recent turns: none.`,
    ...turns,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parse + call
// ---------------------------------------------------------------------------

function noulOf(a: JevAnswers[string]): number | null {
  return a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
}

export function parseDirectorJev(answers: JevAnswers | null | undefined): DirectorJevVerdict | null {
  if (!answers) return null;
  const a = answers.next_speaker;
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  const nextSpeaker = a.choice.trim().toLowerCase() as NextSpeaker;
  if (!(NEXT_SPEAKERS as readonly string[]).includes(nextSpeaker)) return null;
  const probabilities: Partial<Record<NextSpeaker, number>> = {};
  for (const [k, v] of Object.entries(a.probabilities ?? {})) {
    const key = k.trim().toLowerCase();
    if ((NEXT_SPEAKERS as readonly string[]).includes(key) && typeof v === "number" && Number.isFinite(v)) {
      probabilities[key as NextSpeaker] = v;
    }
  }
  const conf = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0;
  return {
    nextSpeaker,
    confidence: Math.max(0, Math.min(1, conf)),
    probabilities,
    threadHasMore: noulOf(answers.thread_has_more),
    echoing: noulOf(answers.echoing),
  };
}

export type DirectorJevResult =
  | { ok: true; verdict: DirectorJevVerdict; latency_ms: number; wall_ms: number }
  | { ok: false; reason: string; wall_ms: number };

export async function directorJevEval(
  state: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DirectorJevResult> {
  const res: JevEvalResult = await postJev(
    { purpose: "director shadow: who should speak next among the companions", state, questions: buildDirectorJevQuestions() },
    { ...opts, timeoutMs: opts.timeoutMs ?? DIRECTOR_JEV_TIMEOUT_MS, tag: DIRECTOR_JEV_TAG },
  );
  if (!res.ok) return { ok: false, reason: res.reason, wall_ms: res.wall_ms };
  const verdict = parseDirectorJev(res.answers);
  if (!verdict) return { ok: false, reason: "no_next_speaker", wall_ms: res.wall_ms };
  return { ok: true, verdict, latency_ms: res.latency_ms, wall_ms: res.wall_ms };
}

/** Does Jev's pick match the director's? A director silence matches "nobody" or "human". */
export function jevAgreesDirector(v: DirectorJevVerdict, sel: { kind: "invite"; companionId: CompanionId } | { kind: "silence" }): boolean {
  if (sel.kind === "invite") return v.nextSpeaker === sel.companionId;
  return v.nextSpeaker === "nobody" || v.nextSpeaker === "human";
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

let warnedLog = false;

export function directorJevLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["DIRECTOR_JEV_LOG"]?.trim() || "/app/logs/director-jev.jsonl";
}

/** Append one JSON line; an unwritable path warns once and never throws (address-shadow idiom). */
export function appendDirectorJevLine(row: Record<string, unknown>): void {
  let payload: string;
  try { payload = `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`; } catch { return; }
  const path = directorJevLogPath();
  import("node:fs").then(({ appendFile }) => {
    appendFile(path, payload, (err) => {
      if (err && !warnedLog) { warnedLog = true; console.warn(`${DIRECTOR_JEV_TAG} log unwritable: ${String(err).slice(0, 200)}`); }
    });
  }).catch((e) => {
    if (!warnedLog) { warnedLog = true; console.warn(`${DIRECTOR_JEV_TAG} log unwritable: ${String(e).slice(0, 200)}`); }
  });
}
