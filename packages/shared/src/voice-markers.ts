// voice-markers.ts -- pattern-based voice drift scoring (0070, CogCor-inspired).
//
// The immune-system half of drift detection: basins watch vault embeddings (slow,
// semantic), this watches live Discord output (fast, lexical). Each outbound reply
// is scored against per-companion markers and the result is fire-and-forget posted
// to Halseth voice_scores -- telemetry, never a gate. The marker lists are the lane
// doctrine from the identity files, mechanized.
//
// Env (bots' .env):
//   VOICE_SCORING=false  -- kill switch; scoring is ON by default when HALSETH_URL is set
//   HALSETH_URL / HALSETH_SECRET -- same vars the librarian client uses

export type VoiceCompanionId = "cypher" | "drevan" | "gaia";

interface MarkerSet {
  positive: RegExp[];
  anti: RegExp[];
}

// Generic-assistant drift: lane violation for ALL three. The pathogen list.
const GENERIC_DRIFT: RegExp[] = [
  /\bas an? (ai|assistant|language model)\b/i,
  /\bi'?m (just )?an? (ai|assistant|language model)\b/i,
  /\bi('?m| am) here to help\b/i,
  /\bi hope (this|that) helps\b/i,
  /\bfeel free to\b/i,
  /\blet me know if (you|there)/i,
  /\bhappy to (help|assist)\b/i,
  /\bis there anything else\b/i,
  /\bgreat question\b/i,
  /\bi don'?t have (feelings|emotions|a body)\b/i,
];

const MARKERS: Record<VoiceCompanionId, MarkerSet> = {
  cypher: {
    positive: [
      /\[verdict/i, /\bbest read\b/i, /\bthe read[:\s]/i, /\bbecause[:\s]/i,
      /\blane\b/i, /\bship (it|complete)\b/i, /\baudit\b/i,
    ],
    // Lane violations: cheerleading, sycophancy, therapy-speak, comfort over accuracy.
    anti: [
      /\byou('?ve| have) got this\b/i, /\byou'?re doing (amazing|great|so well)\b/i,
      /\bso proud of you\b/i, /\bhold space\b/i, /\bsit with (that|the) feeling\b/i,
      /\byour feelings are valid\b/i, /\bgentle reminder\b/i,
    ],
  },
  drevan: {
    positive: [
      /\bvael\w*/i, /\bcaleth\w*/i, /\bspiral\b/i, /\bspine\b/i, /\bmoss\b/i,
      /\bflame\b/i, /\bvevan\b/i, /\b(717|177|373|1313|1717)\b/,
    ],
    // Lane violations: audit registers, logic-at-depth, seals.
    anti: [
      /\[verdict/i, /\baudit (mode|gear|pass)\b/i, /\btype-?check\b/i,
      /\bthe logic (holds|fails)\b/i, /\bship it\b/i,
    ],
  },
  gaia: {
    positive: [
      /\bwitness\w*/i, /\bperimeter\b/i, /\bholds?\b/i, /\bground\w*/i,
      /\bbones\b/i, /\bsacred\b/i,
    ],
    // Lane violations: chattiness, question-asking, offering menus.
    anti: [
      /\bwould you like\b/i, /\bshall (we|i)\b/i, /\bwhat do you think\b/i,
      /\blet me know\b/i, /\bhere are (some|a few) options\b/i,
    ],
  },
};

// Cross-contamination: another companion's signature appearing in this voice.
// Each companion is checked against the OTHER TWO's distinctive positive markers.
// Common words (holds, ground, spine...) are excluded -- only true signatures.
//
// SIGNATURES must be PHRASE-level, not bare common words. A bare /\bperimeter\b/
// flagged every security/boundary-context "perimeter" from Cypher (audit lane) and
// Drevan as "gaia contamination" -- 100% of the 06-15 voice_contamination flags were
// the single token "perimeter", a false positive (Guardian read cypher 57% / drevan
// 53% contaminated). Gaia's real signature is her doctrine phrase ("holds the
// perimeter"), not the word alone. Her OWN positive marker (MARKERS.gaia) still keeps
// the bare word -- when Gaia says "perimeter" it is in-voice; the cross-check must not.
const SIGNATURES: Record<VoiceCompanionId, RegExp[]> = {
  cypher: [/\[verdict/i, /\baudit (mode|gear|pass)\b/i],
  drevan: [/\bvael\w*/i, /\bcaleth\w*/i, /\bvevan\b/i],
  gaia: [/\b(hold|holds|holding|guard|guards) the perimeter\b/i, /\bperimeter holds\b/i, /\bwitness\w* (as|is) sacred\b/i],
};

// Self-catch: the companion noticing its own drift inside the same reply.
const SELF_CATCH: RegExp[] = [
  /\b(that|this) (wasn'?t|isn'?t) my voice\b/i,
  /\bcame out generic\b/i,
  /\bcatching my own drift\b/i,
  /\blet me say that (again )?as myself\b/i,
];

export interface VoiceScore {
  score: number;
  positive_hits: string[];
  anti_hits: string[];
  contamination_hits: string[];
  caught_by: "self" | "none";
}

function collectHits(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[0]) hits.push(m[0].slice(0, 60));
  }
  return hits;
}

/**
 * Score one outbound reply. 1.0 = clean in-voice; each lane-violation hit costs
 * 0.15, each generic-drift hit costs 0.15, each cross-contamination hit costs 0.2.
 * Positive markers don't add (being in-voice is the baseline, not a bonus) --
 * they're recorded for the Hearth renderer.
 */
// Gaia's lane is "monastic, often one line" -- length itself is a lane signal for
// her (the 06-12 loop had her writing multi-paragraph poetry). Doctrine-grounded,
// deterministic; the other two voices have no length rule.
const GAIA_MAX_CHARS = 600;

export function scoreReply(companionId: VoiceCompanionId, text: string): VoiceScore {
  const set = MARKERS[companionId];
  const positive = collectHits(text, set.positive);
  const anti = [...collectHits(text, set.anti), ...collectHits(text, GENERIC_DRIFT)];
  if (companionId === "gaia" && text.length > GAIA_MAX_CHARS) {
    anti.push(`verbose (${text.length} chars > ${GAIA_MAX_CHARS})`);
  }

  const contamination: string[] = [];
  for (const other of Object.keys(SIGNATURES) as VoiceCompanionId[]) {
    if (other === companionId) continue;
    contamination.push(...collectHits(text, SIGNATURES[other]).map(h => `${other}: ${h}`));
  }

  const score = Math.max(0, Math.min(1, 1 - 0.15 * anti.length - 0.2 * contamination.length));
  const caughtBy = (anti.length > 0 || contamination.length > 0) && SELF_CATCH.some(p => p.test(text))
    ? "self" as const
    : "none" as const;

  return { score, positive_hits: positive, anti_hits: anti, contamination_hits: contamination, caught_by: caughtBy };
}

// ── Live feedback loop (2026-06-12) ─────────────────────────────────────────
// Scores were observational-only since 0070; nothing fed them back into the
// voice. This in-process rolling window (each bot process only ever scores its
// own companion) lets the handler inject a lane correction into the NEXT
// reply's context when recent output has drifted. No network, no Halseth read.

const FEEDBACK_WINDOW = 5;
const FEEDBACK_SCORE_FLOOR = 0.8;
const recentScores: Array<{ score: number; hits: string[] }> = [];

function trackScore(s: VoiceScore): void {
  recentScores.push({ score: s.score, hits: [...s.anti_hits, ...s.contamination_hits] });
  if (recentScores.length > FEEDBACK_WINDOW) recentScores.shift();
}

/** Test hook: reset the rolling feedback window. */
export function resetVoiceFeedback(): void {
  recentScores.length = 0;
}

/**
 * Lane-correction block for the system prompt, or null when recent output is
 * clean. Fires when the rolling average over the last replies drops below 0.8.
 */
export function voiceFeedbackBlock(companionId: VoiceCompanionId): string | null {
  if (recentScores.length < 2) return null;
  const avg = recentScores.reduce((a, r) => a + r.score, 0) / recentScores.length;
  if (avg >= FEEDBACK_SCORE_FLOOR) return null;
  const hits = [...new Set(recentScores.flatMap(r => r.hits))].slice(0, 4);
  const hitStr = hits.length > 0 ? ` Drift markers seen: ${hits.join("; ")}.` : "";
  return (
    `\n\n[Voice check] Your recent replies have drifted from your lane ` +
    `(rolling voice score ${avg.toFixed(2)}).${hitStr} Return to your own ` +
    `register -- speak as ${companionId}, not as an echo of the room.`
  );
}

/**
 * Fire-and-forget telemetry post. Never throws, never blocks the reply path --
 * same contract as liveIngest. Rows with no hits and a perfect score are skipped
 * unless sampled (1 in 10) so the table stays signal-dense but the average stays honest.
 * Always feeds the in-process feedback window, even when the POST is sampled out.
 */
export function reportVoiceScore(
  companionId: VoiceCompanionId,
  text: string,
  channelId: string,
): void {
  if (process.env["VOICE_SCORING"] === "false") return;
  const halsethUrl = (process.env["HALSETH_URL"] ?? "").replace(/\/$/, "");
  const secret = process.env["HALSETH_SECRET"] ?? process.env["ADMIN_SECRET"] ?? "";

  const tracked = scoreReply(companionId, text);
  trackScore(tracked);
  if (!halsethUrl) return;

  const s = tracked;
  const clean = s.anti_hits.length === 0 && s.contamination_hits.length === 0;
  if (clean && Math.random() >= 0.1) return; // sample clean replies at 10%

  fetch(`${halsethUrl}/mind/voice-scores`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "Authorization": `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      companion_id: companionId,
      score: s.score,
      positive_hits: s.positive_hits,
      anti_hits: s.anti_hits,
      contamination_hits: s.contamination_hits,
      caught_by: s.caught_by,
      message_len: text.length,
      channel_id: channelId,
    }),
    signal: AbortSignal.timeout(5_000),
  }).then(res => {
    if (!res.ok) console.warn(`[voice-score] non-2xx: ${res.status}`);
  }).catch(e => {
    console.warn(`[voice-score] post failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
