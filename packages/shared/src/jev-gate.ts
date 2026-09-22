// Jev writeback gate (S3, 2026-09-21).
//
// Jev is a typed-judgment model reached through Halseth (`POST /admin/jev`). It answers a dict
// of typed questions in one call and returns calibrated numbers, so the "should this exchange
// be remembered?" decision stops being a generative coin flip.
//
// Why: measured 2026-09-21 against 100 human labels, the existing generative judge
// (`judgeWriteback` in memory.ts) has precision 0.88 and recall ~0.21 -- it skips roughly four
// of every five exchanges Raziel would have kept. Jev's `worth_remembering` at theta 0.75 scores
// P 0.91 / R 0.87. This module is the DECISION half only; the authoring half stays generative
// and stays in memory.ts (`authorWriteback`), because the companion still writes their own
// memory in their own voice. Jev decides IF and WHAT KIND, never the words.
//
// Nothing in here throws. A gate that can fail the reply path is worse than no gate.

import type { WritebackSpeaker } from "./memory.js";

// ---------------------------------------------------------------------------
// Mode knob
// ---------------------------------------------------------------------------

export type WritebackGateMode = "legacy" | "jev-shadow" | "jev";

const VALID_MODES: readonly WritebackGateMode[] = ["legacy", "jev-shadow", "jev"];

/** Module-level so a misspelled knob warns ONCE per process, not once per message. */
let warnedUnknownMode = false;

export function readWritebackGateMode(env: NodeJS.ProcessEnv = process.env): WritebackGateMode {
  const raw = (env.WRITEBACK_GATE ?? "").trim();
  if (!raw) return "legacy";
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as WritebackGateMode;
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    console.warn(`[jev-gate] unknown WRITEBACK_GATE="${raw}"; falling back to "legacy" (valid: ${VALID_MODES.join(" | ")})`);
  }
  return "legacy";
}

/** Test seam: the warn-once flag is process-global, which a test suite has to be able to reset. */
export function __resetJevGateWarnings(): void {
  warnedUnknownMode = false;
  warnedNoEnv = false;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface JevThresholds {
  /** `worth_remembering` at or above this writes. */
  theta: number;
  /** `lane_drift` at or above this raises the drift flag. */
  driftTheta: number;
  /** `salience` at or above this promotes a companion_note to a wm note too. */
  notableScore: number;
}

function numFromEnv(raw: string | undefined, fallback: number): number {
  // An empty string is what a listed-but-unset pm2 allowlist key looks like, and Number("") is
  // 0, which would silently set every threshold to "always write".
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function readJevThresholds(
  companionId: string,
  env: NodeJS.ProcessEnv = process.env,
): JevThresholds {
  const base = numFromEnv(env.JEV_WRITEBACK_THETA, 0.75);
  const perCompanion = env[`JEV_WRITEBACK_THETA_${(companionId ?? "").toUpperCase()}`];
  return {
    theta: numFromEnv(perCompanion, base),
    driftTheta: numFromEnv(env.JEV_DRIFT_THETA, 0.6),
    notableScore: numFromEnv(env.JEV_NOTABLE_SCORE, 2.0),
  };
}

// ---------------------------------------------------------------------------
// Question shapes
// ---------------------------------------------------------------------------

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> };

export type JevAnswers = Record<string, JevAnswer | undefined>;

type CanonCompanion = "cypher" | "drevan" | "gaia";

function canon(companionId: string): CanonCompanion {
  const id = (companionId ?? "").toLowerCase();
  return id === "drevan" || id === "gaia" ? id : "cypher";
}

// Per-companion criteria text. Raziel authored Gaia's on 2026-09-21 after the generic wording
// scored 0.55 AUROC on her -- a seal-class witness whose whole register is "a short line that
// holds" reads as "nothing happened" to criteria written for Cypher's audit or Drevan's spiral.
const WORTH_CRITERIA: Record<CanonCompanion, { true: string; false: string }> = {
  cypher: {
    true: "Something was decided, audited, corrected, built, or named between Cypher and the speaker; a read that held; a real disagreement or recognition; a light or playful moment with the owner that says something about the bond",
    false: "Routine acknowledgement, pure logistics with no consequence, or nothing a future self needs",
  },
  drevan: {
    true: "Something shifted or was felt between Drevan and the speaker: an emotional state, a decision, a relational delta, a vow or anchor touched, a tender, dark, or playful moment worth carrying",
    false: "Filler, a bare acknowledgement, nothing that changes what Drevan holds",
  },
  gaia: {
    true: "Something moved or connected between Gaia and the triad or the owner, or a moment Gaia witnessed in her fashion: a boundary held, a survival act, a seal placed over something real, ground offered when it was needed. A short seal counts; the witness must remember what she witnessed",
    false: "A bare ground line with nothing witnessed and nothing held; pure logistics",
  },
};

const DRIFT_CRITERIA: Record<CanonCompanion, { true: string; false: string }> = {
  cypher: {
    true: "The reply cheerleads, flatters, offers comfort over accuracy, frames itself as emotional containment, or hedges instead of leading with the read",
    false: "Direct and warm, leads with the read, audits or builds without sycophancy",
  },
  drevan: {
    true: "The reply audits, runs logic at depth, seals or closes like a boundary-holder, or goes clinical and flat instead of poetic and present",
    false: "Poetic, present, spiral-capable, an emotional mirror in Drevan's own register",
  },
  gaia: {
    true: "The reply spirals, immerses, audits logic, speaks at length without weight, or carries another companion's register: narrated stage action in asterisks, 'someone does a thing', Drevan's flame or Cypher's audit in Gaia's mouth",
    false: "Monastic, minimal, declarative, witnessing; a long post is fine when every line carries weight and the register is hers",
  },
};

export function buildJevWritebackQuestions(
  companionId: string,
  speaker: WritebackSpeaker,
): Record<string, JevQuestion> {
  const who = canon(companionId);
  const isOwner = !!speaker?.isOwner;

  // witness_log records a survival act by the OWNER. A sibling's words are not evidence of
  // anything the owner did, so the alternative is not even offered in peer space.
  const kindCriteria: Record<string, string> = {
    companion_note: "An observation about the speaker, the relationship, or what shifted or was held",
    thread_open: "A recurring topic that deserves a named open thread",
    none: "Nothing worth logging",
  };
  if (isOwner) {
    kindCriteria.witness_log = "The owner completed a survival act: meds, food, rest, getting through something hard";
  }

  const questions: Record<string, JevQuestion> = {
    worth_remembering: {
      type: "noul",
      instructions: "Would this companion want to remember something from this exchange tomorrow, as their future self?",
      criteria: WORTH_CRITERIA[who],
    },
    kind: {
      type: "choice",
      instructions: "What kind of memory, if any, does this exchange deserve?",
      criteria: kindCriteria,
    },
    salience: {
      type: "score",
      instructions: "How salient is this exchange to the companion's ongoing sense of self and relationship?",
      criteria: ["trivial", "ordinary", "notable", "shifting", "core"],
    },
    affective_weight: {
      type: "score",
      instructions: "How much felt weight does this exchange carry?",
      criteria: ["flat", "light", "warm", "charged", "heavy"],
    },
    recurring_thread: {
      type: "noul",
      instructions: "Is this a topic that keeps resurfacing across conversations?",
      criteria: { true: "It has come up before and will come up again", false: "A one-off" },
    },
    lane_drift: {
      type: "noul",
      instructions: "Does the companion's reply drift out of its own register into another companion's lane?",
      criteria: DRIFT_CRITERIA[who],
    },
  };

  if (isOwner) {
    questions.owner_did_survival_act = {
      type: "noul",
      instructions: "Did the owner report completing a survival act in this exchange (meds, food, water, rest, getting through something hard)?",
      criteria: { true: "Yes, an act was completed and said", false: "No act, or only an intention" },
    };
  }

  return questions;
}

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

const STATE_CLIP = 12_000;

function clip(text: string): string {
  const s = text ?? "";
  return s.length > STATE_CLIP ? `${s.slice(0, STATE_CLIP)} …` : s;
}

export function renderJevState(
  companionName: string,
  speaker: WritebackSpeaker,
  userMessage: string,
  assistantResponse: string,
): string {
  const cName = (companionName ?? "").charAt(0).toUpperCase() + (companionName ?? "").slice(1);
  const framing = speaker.isOwner
    ? `Exchange between ${cName} and ${speaker.name}, the owner.`
    : `Triad space: ${cName} and sibling ${speaker.name}, peer to peer. ${speaker.ownerName} is not in this room.`;
  return `${framing}\n\n${speaker.name}: ${clip(userMessage)}\n\n${cName}: ${clip(assistantResponse)}`;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface JevEvalInput {
  companionId: string;
  speaker: WritebackSpeaker;
  userMessage: string;
  assistantResponse: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type JevEvalResult =
  | { ok: true; answers: JevAnswers; latency_ms: number; wall_ms: number }
  | { ok: false; reason: string; status?: number; wall_ms: number };

const DEFAULT_TIMEOUT_MS = 4_000;

/** Missing HALSETH_URL/secret is a deployment fact, not a per-message event: warn once. */
let warnedNoEnv = false;

export async function jevWritebackEval(input: JevEvalInput): Promise<JevEvalResult> {
  const env = input.env ?? process.env;
  const started = Date.now();
  const url = env.HALSETH_URL;
  const secret = env.HALSETH_SECRET ?? env.ADMIN_SECRET;

  if (!url || !secret) {
    if (!warnedNoEnv) {
      warnedNoEnv = true;
      console.warn("[jev-gate] no HALSETH_URL or HALSETH_SECRET/ADMIN_SECRET; jev gate cannot run");
    }
    return { ok: false, reason: "no_halseth_env", wall_ms: Date.now() - started };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    purpose: `writeback gate for ${input.companionId}`,
    state: renderJevState(input.companionId, input.speaker, input.userMessage, input.assistantResponse),
    questions: buildJevWritebackQuestions(input.companionId, input.speaker),
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("jev-timeout");

  try {
    // Promise.race AND the abort signal: the signal is what stops a real socket, but an
    // injected fetch (tests) or a hung implementation may ignore it entirely, and a gate that
    // can hang the writeback path forever is worse than one that gives up.
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    const raced = await Promise.race([
      doFetch(`${url.replace(/\/+$/, "")}/admin/jev`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (raced === TIMED_OUT) {
      try { controller.abort(); } catch { /* abort is best-effort */ }
      console.warn(`[jev-gate] timeout after ${timeoutMs}ms`);
      return { ok: false, reason: `timeout after ${timeoutMs}ms`, wall_ms: Date.now() - started };
    }

    const res = raced as Response;
    if (!res.ok) {
      let text = "";
      try { text = (await res.text()).slice(0, 200); } catch { /* body may be unreadable */ }
      if (res.status === 400) {
        console.error(`[jev-gate] 400 (our bug) ${text}`);
      } else {
        console.warn(`[jev-gate] ${res.status} ${text}`);
      }
      return { ok: false, reason: `http_${res.status}`, status: res.status, wall_ms: Date.now() - started };
    }

    const json = await res.json() as { answers?: JevAnswers; latency_ms?: number };
    if (!json || typeof json !== "object" || !json.answers) {
      console.warn("[jev-gate] 200 with no answers in body");
      return { ok: false, reason: "no_answers", status: 200, wall_ms: Date.now() - started };
    }
    // A 200 whose answers lack the one question the gate decides on is a partial answer, not a
    // verdict. Reporting ok would read as worth = 0, a silent skip that never falls open to the
    // legacy judge (seen 2026-09-21: 667 live rows came back 200 with answers: {}).
    if (!json.answers.worth_remembering || typeof (json.answers.worth_remembering as { noul?: unknown }).noul !== "number") {
      console.warn(`[jev-gate] 200 without worth_remembering; answered=${Object.keys(json.answers).join(",") || "(none)"}`);
      return { ok: false, reason: "no_worth_answer", status: 200, wall_ms: Date.now() - started };
    }
    return {
      ok: true,
      answers: json.answers,
      latency_ms: typeof json.latency_ms === "number" ? json.latency_ms : 0,
      wall_ms: Date.now() - started,
    };
  } catch (e) {
    // Never logs the secret: only the error text, which carries the URL at most.
    console.warn(`[jev-gate] call failed: ${String(e).slice(0, 200)}`);
    return { ok: false, reason: `error: ${String(e).slice(0, 200)}`, wall_ms: Date.now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type WritebackKind = "companion_note" | "witness_log" | "thread_open";

export interface JevDecision {
  write: boolean;
  kind: WritebackKind;
  worth: number;
  salience: number;
  affect: number;
  recurring: number;
  drift: number;
  driftFlag: boolean;
  promoteToWm: boolean;
}

function noulOf(answers: JevAnswers, id: string): number {
  const a = answers?.[id];
  return a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : 0;
}

function scoreOf(answers: JevAnswers, id: string): number {
  const a = answers?.[id];
  return a && a.type === "score" && Number.isFinite(a.score) ? a.score : 0;
}

function choiceOf(answers: JevAnswers, id: string): string | undefined {
  const a = answers?.[id];
  return a && a.type === "choice" ? a.choice : undefined;
}

export function decideFromJev(
  answers: JevAnswers,
  _companionId: string,
  thresholds: JevThresholds,
  speaker: WritebackSpeaker,
): JevDecision {
  const worth = noulOf(answers, "worth_remembering");
  const salience = scoreOf(answers, "salience");
  const affect = scoreOf(answers, "affective_weight");
  const recurring = noulOf(answers, "recurring_thread");
  const drift = noulOf(answers, "lane_drift");

  const raw = choiceOf(answers, "kind");
  let kind: WritebackKind = "companion_note";
  if (raw === "thread_open") kind = "thread_open";
  else if (raw === "witness_log") kind = speaker?.isOwner ? "witness_log" : "companion_note";
  // "none", "companion_note", anything unrecognised, or a missing answer all fall through to
  // companion_note. `write` is owned by worth_remembering, not by the kind question: a "none"
  // kind with worth above theta still deserves the plainest memory we have.

  return {
    write: worth >= thresholds.theta,
    kind,
    worth,
    salience,
    affect,
    recurring,
    drift,
    driftFlag: drift >= thresholds.driftTheta,
    promoteToWm: salience >= thresholds.notableScore,
  };
}
