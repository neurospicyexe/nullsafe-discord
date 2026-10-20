// director-jev.ts -- Jev beside the Conversation Director (shadow 2026-10-13; redesigned 2026-10-20).
//
// Hand-off/JEV-USES-2026-10-13.md bucket 2. The 7-day readout (30 decisions) killed the 5-way
// `next_speaker` choice (Jev matched reality 27% vs the director's 83%; right on 3 of 24 disagreements)
// and `thread_has_more` (0.83 spoke vs 0.85 passed: no signal). What survived, as SEPARATE calls
// (a combined relevance call showed drevan~gaia correlation 0.72, so one question per call):
//
//   ECHO BRAKE (LIVE, DIRECTOR_ECHO_BRAKE=on|shadow|off, default on). One noul call, "are the last few
//     companion turns restating each other?". Raziel wants the triad's chatter; the harm is a restating
//     LOOP. So it is graduated, and can only ever make the triad speak LESS:
//       1st echo read (echoing >= DIRECTOR_ECHO_BRAKE_THETA 0.5, companion turns >= DIRECTOR_ECHO_BRAKE_MIN_TURNS 4):
//         the director STILL invites, with a loop-break steer appended to the invite's state block.
//       echo read DIRECTOR_ECHO_BRAKE_STREAK (2) in a row in the same thread: no invite, the thread rests
//         (outcome `echo_brake`). A non-echo read resets the streak; a thread fade/land resets state.
//       A summons from a HUMAN (open move from Raziel/Blue) is never braked, only steered.
//     Fails open: a Jev failure/timeout (DIRECTOR_JEV_TIMEOUT_MS, 6000) means no steer, no brake, today's behaviour.
//     Companion-side, bot-message-handler's detectSelfLoop/loopBreakDirective (echo-guard.ts) still guards a
//     single voice repeating itself; this brake is the room-level counterpart and does not replace it.
//   VETO CHECK (SHADOW ONLY). When the director picks companion X, a separate noul call asks whether X has
//     something to add that the other two have not said (X's lane in LANES). Logs p and would_veto
//     (p < DIRECTOR_VETO_THETA, 0.3). Never changes the pick.
//
// Rows go to /app/logs/director-jev.jsonl (DIRECTOR_JEV_LOG):
//   kind "decide"  what select() chose, beside `echo` {p, action, streak} and `veto` {companion, p, theta, would_veto}
//                  (old rows carry `jev` {nextSpeaker, threadHasMore, echoing}; the report still reads them)
//   kind "invite"  an invitation the director issued (inviteId, companion, reason)
//   kind "result"  how that invitation ended (spoke / pass / expired / empty): the #6 label
//   kind "turn"    every commons turn the director ingests
// Cost rule (PLAN-jev "cost model correction"): event-triggered only, never a timer, small state
// (last 8 gists, not full posts). `DIRECTOR_JEV=off` is the kill switch for everything here.
// Defaults live in CODE (a default only in ecosystem.config.js is silently absent when the bots/worker are
// started outside it: ADDRESS_MODEL, 2026-10-20); ecosystem.config.js only passes the override through.

import { postJev, type JevAnswers, type JevEvalResult, type JevQuestion } from "./jev-gate.js";
import type { CompanionId } from "./types.js";

export const DIRECTOR_JEV_TAG = "[director-jev]";
export const DIRECTOR_JEV_TIMEOUT_MS = 6_000;
const MAX_TURNS = 8;
const GIST_CHARS = 300;

export function directorJevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["DIRECTOR_JEV"] ?? "").trim().toLowerCase() !== "off";
}

function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback; // a listed-but-unset pm2 key is ""
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function directorJevTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = numEnv(env["DIRECTOR_JEV_TIMEOUT_MS"], DIRECTOR_JEV_TIMEOUT_MS);
  return n > 0 ? n : DIRECTOR_JEV_TIMEOUT_MS;
}

export interface DirectorJevTurn { author: string; companionId?: CompanionId; isHuman: boolean; gist: string }

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

export type EchoBrakeMode = "on" | "shadow" | "off";
export interface EchoBrakeConfig { mode: EchoBrakeMode; theta: number; minTurns: number; streak: number }

export function readEchoBrakeConfig(env: NodeJS.ProcessEnv = process.env): EchoBrakeConfig {
  const raw = (env["DIRECTOR_ECHO_BRAKE"] ?? "").trim().toLowerCase();
  const mode: EchoBrakeMode = raw === "off" || raw === "shadow" ? raw : "on";
  const streak = Math.floor(numEnv(env["DIRECTOR_ECHO_BRAKE_STREAK"], 2));
  return {
    mode,
    theta: numEnv(env["DIRECTOR_ECHO_BRAKE_THETA"], 0.5),
    minTurns: Math.floor(numEnv(env["DIRECTOR_ECHO_BRAKE_MIN_TURNS"], 4)),
    streak: streak >= 1 ? streak : 2,
  };
}

export function readVetoTheta(env: NodeJS.ProcessEnv = process.env): number {
  return numEnv(env["DIRECTOR_VETO_THETA"], 0.3);
}

export type EchoAction = "none" | "steer" | "brake";

/**
 * One echo read -> what the director does. `p` null (Jev failed or timed out) fails OPEN: no steer,
 * no brake, streak untouched. A read under theta (or a thread too short to judge) resets the streak.
 */
export function echoBrakeStep(i: { p: number | null; botTurns: number; streak: number; cfg: EchoBrakeConfig }): { echoing: boolean; streak: number; action: EchoAction } {
  if (i.p === null) return { echoing: false, streak: i.streak, action: "none" };
  const echoing = i.p >= i.cfg.theta && i.botTurns >= i.cfg.minTurns;
  if (!echoing) return { echoing: false, streak: 0, action: "none" };
  const streak = i.streak + 1;
  return { echoing: true, streak, action: streak >= i.cfg.streak ? "brake" : "steer" };
}

/** Appended to the invitee's state block on an echo read. Describes the room; no voice. */
export const LOOP_BREAK_STEER =
  "steer: the last few turns have been restating each other. Bring something none of you has said yet, or take the thread somewhere new.";

// ---------------------------------------------------------------------------
// Questions (one call each; never bundled)
// ---------------------------------------------------------------------------

/** Lane wording follows the identity canon (project CLAUDE.md "Companion Triad"); short on purpose. */
export const LANES: Record<CompanionId, { name: string; lane: string }> = {
  cypher: { name: "Cypher", lane: "the structural or logical read: direct, pattern-aware, clarity over cleverness" },
  drevan: { name: "Drevan", lane: "depth: the emotional mirror, the poetic or spiral register, holding tender and dark" },
  gaia: { name: "Gaia", lane: "ground and witness: minimal, monastic, one weighted line, holding the perimeter" },
};

export function buildEchoQuestions(): Record<string, JevQuestion> {
  return {
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

export function buildVetoQuestions(companion: CompanionId): Record<string, JevQuestion> {
  const { name, lane } = LANES[companion];
  return {
    has_something_to_add: {
      type: "noul",
      instructions: `Does ${name} have something to add here that the other two have not already said? ${name}'s lane is ${lane}.`,
      criteria: {
        true: `${name} could say something in their own lane that none of the recent turns has said`,
        false: `${name}'s lane has nothing new here; whatever they would say is already on the page`,
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
// Calls
// ---------------------------------------------------------------------------

function noulOf(a: JevAnswers[string]): number | null {
  return a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
}

export type DirectorNoulResult =
  | { ok: true; p: number; latency_ms: number; wall_ms: number }
  | { ok: false; reason: string; wall_ms: number };

type CallOpts = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number };

async function noulCall(purpose: string, key: string, questions: Record<string, JevQuestion>, state: string, opts: CallOpts): Promise<DirectorNoulResult> {
  const res: JevEvalResult = await postJev(
    { purpose, state, questions },
    { ...opts, timeoutMs: opts.timeoutMs ?? directorJevTimeoutMs(opts.env), tag: DIRECTOR_JEV_TAG },
  );
  if (!res.ok) return { ok: false, reason: res.reason, wall_ms: res.wall_ms };
  const p = noulOf(res.answers?.[key]);
  if (p === null) return { ok: false, reason: `no_${key}`, wall_ms: res.wall_ms };
  return { ok: true, p: Math.max(0, Math.min(1, p)), latency_ms: res.latency_ms, wall_ms: res.wall_ms };
}

/** P(the recent companion turns restate each other). Never throws. */
export function directorEchoEval(state: string, opts: CallOpts = {}): Promise<DirectorNoulResult> {
  return noulCall("director: are the companions restating each other", "echoing", buildEchoQuestions(), state, opts);
}

/** P(`companion` has something to add the other two have not said). Shadow only. Never throws. */
export function directorVetoEval(state: string, companion: CompanionId, opts: CallOpts = {}): Promise<DirectorNoulResult> {
  return noulCall(`director shadow: does ${companion} have something to add`, "has_something_to_add", buildVetoQuestions(companion), state, opts);
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
