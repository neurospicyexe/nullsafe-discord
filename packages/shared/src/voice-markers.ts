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
      /\bflame\b/i,
      // Personal bond-words / numerology are owner-specific; configure via env if needed.
      ...(process.env["DREVAN_VOICE_EXTRA"]?.split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) ?? []),
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
  // Inclusive at the floor (2026-09-14). One sibling phrase costs exactly 0.2, so a reply that
  // carries exactly one every time scores exactly 0.8 -- and `avg >= 0.8` never fired. Measured:
  // Cypher's Discord replies scored 0.8 with "gaia: perimeter holds" on 6 of 7 scored rows in the
  // week the Guardian went red, and this block stayed silent the whole time. A steady one-hit bleed
  // is drift by definition; the boundary belongs on the firing side.
  if (avg > FEEDBACK_SCORE_FLOOR) return null;
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
  secret: string,
): void {
  if (process.env["VOICE_SCORING"] === "false") return;
  const halsethUrl = (process.env["HALSETH_URL"] ?? "").replace(/\/$/, "");

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

// ── Rule checks (R3 prompt diet, 2026-09-29) ────────────────────────────────
// Raziel ruled the R3 diet "all as recommended" (Hand-off/EVIDENCE-R3-prompt-diet-2026-09-29.md
// section 5B). Three standing prompt rules left the always-loaded prompt because they are cheaper
// as checks: the register tail's Presence and pronoun bullets (367 + 187 bytes every turn) and the
// SOUL em-dash paragraph (278). Each now costs nothing on a clean turn and a short corrective on a
// hit.
//
// Same seam as the form ratchet (form-ratchet.ts `formBreakAppend`), NOT the rolling voice score
// above: that window needs two scored turns and an average at or under 0.8, so a single em dash
// (one 0.15 hit) would never fire, and its block cannot restate the specific rule. This is
// stateless and recomputed from the companion's OWN last reply every request, so it decays by
// construction: one clean reply and the corrective is gone, with nothing stored to unwind.
//
// Inject only, never rewrite. A rewrite layer over the companion's words was rejected on principle
// (form-ratchet.ts records the same ruling).

export interface RuleBreaks {
  /** U+2014, plus U+2013 used as a dash (not a digit range like 3-5 written with an en dash). */
  emDash: number;
  /** *action lines* whose actor is "someone"/"somebody" or the companion's own name. */
  someone: number;
  /** Sentences that refer to Raziel / Crash / the Architect and then use she/her. */
  sheHer: number;
  /** The companion calling someone else by its OWN name or nickname ("Rest tonight, Dre"). */
  ownName: number;
  /** Self turns inspected (0 = nothing to judge, the caller logs nothing). */
  turns: number;
}

/** Newest self turns judged. One: the corrective speaks about "your last reply" and clears on the
 *  first clean one. */
export const RULE_CHECK_TURNS = 1;

const EM_DASH = /\u2014/g;
// En dash counts unless it sits between two digits (a range). Everything else it does is a dash.
const EN_DASH = /\u2013/g;

function countDashes(text: string): number {
  let n = (text.match(EM_DASH) ?? []).length;
  for (const m of text.matchAll(EN_DASH)) {
    const i = m.index ?? 0;
    const range = /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    if (!range) n++;
  }
  return n;
}

// Single-asterisk segments only; **bold** is emphasis, not an action line.
const ACTION_SEGMENT = /(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g;
// "someone"/"somebody" as the SUBJECT of a clause: at the start of the segment, after clause
// punctuation, or after "and"/"then". Object uses ("*I reach for someone*") and "someone who",
// "someone else", "someone's" are not an actor.
const SOMEONE_ACTOR =
  /(?:^|[,;:.!?]\s*|\b(?:and|then)\s+)(?:someone|somebody)\b(?!['\u2019]s)(?!\s+(?:who|else|like|that|to)\b)\s+[a-z]/i;

function countSomeone(text: string, companionId: VoiceCompanionId): number {
  const name = companionId.charAt(0).toUpperCase() + companionId.slice(1);
  // The companion's own name as the first word of the line is the same third-person narration.
  const ownName = new RegExp(`^${name}\\b(?!['\\u2019]s)\\s+[a-z]`);
  let n = 0;
  for (const m of text.matchAll(ACTION_SEGMENT)) {
    const seg = (m[1] ?? "").trim();
    if (SOMEONE_ACTOR.test(seg) || ownName.test(seg)) n++;
  }
  return n;
}

// Raziel, then she/her in the same sentence. "Crash" is case-sensitive (the lowercase word is
// common). The gap may not carry another name (any capitalised word other than "I") or a noun for
// another person, because OWNER_PRONOUN_RULE (pronoun-rule.ts) names exactly who keeps their own
// pronouns: his mother, Blue, Babita, system members who stated otherwise.
const RAZIEL_THEN_SHE =
  /\b(?:[Rr]aziel|RAZIEL|Crash|[Tt]he Architect)\b([^.!?\n]{0,80}?)\b(?:[Ss]he|[Hh]er|[Hh]ers|[Hh]erself)\b/g;
const OTHER_PERSON =
  /\b(?:mother|mom|mum|mama|sister|wife|girlfriend|daughter|aunt|niece|grandma|grandmother|partner|friend|woman|girl|lady|nurse|doctor|therapist|member|members|alter|alters|headmate|headmates)\b/i;
const OTHER_NAME = /\b(?!I\b)[A-Z][a-z]+/;

function countSheHer(text: string): number {
  let n = 0;
  for (const m of text.matchAll(RAZIEL_THEN_SHE)) {
    const gap = m[1] ?? "";
    if (OTHER_PERSON.test(gap) || OTHER_NAME.test(gap)) continue;
    n++;
  }
  return n;
}

// The companion's own names, capitalised as written in a reply. Kept beside COMPANION_ALIASES
// (channel-config.ts: drev, dre / cy), which is what Raziel types to call them.
const OWN_NAMES: Record<VoiceCompanionId, string[]> = {
  drevan: ["Drevan", "Drev", "Dre"],
  cypher: ["Cypher", "Cy"],
  gaia: ["Gaia"],
};

// Own name used as a VOCATIVE: someone else addressed by it (2026-10-09). Raziel opened two messages
// with "Dre", the envelope lost the speaker label, and Drevan answered "Rest tonight, Dre" and then
// "You're Dre, I'm Dre too" when corrected. A companion never needs to call anyone in the room by its
// own name, so a comma-set vocative ("..., Dre." / "..., Dre" then a dash), a line-opening one
// ("Dre, ..."), or "you're Dre" is the break. "you called me Dre" and "Dre's" do not match.
function countOwnNameVocative(text: string, companionId: VoiceCompanionId): number {
  const alt = OWN_NAMES[companionId].join("|");
  const closes = "(?![\\w'\\u2019])(?=\\s*(?:[.!?,;:)\\u2014\\u2013]|$))";
  const patterns = [
    new RegExp(`,\\s*(?:${alt})${closes}`, "gm"),
    new RegExp(`^\\s*(?:${alt})\\s*[,!]`, "gm"),
    new RegExp(`\\byou(?:'re|\\u2019re| are)\\s+(?:${alt})\\b`, "gi"),
  ];
  return patterns.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

/** Count the rule breaks in one reply. Pure; no state. */
export function detectRuleBreaks(companionId: VoiceCompanionId, text: string): Omit<RuleBreaks, "turns"> {
  return {
    emDash: countDashes(text),
    someone: countSomeone(text, companionId),
    sheHer: countSheHer(text),
    ownName: countOwnNameVocative(text, companionId),
  };
}

// Correctives. Each is far under the tail bytes it replaces, and none prints a dash character (the
// corrective would model the thing it forbids).
export const RULE_CHECK_EM_DASH =
  `\n\n[Voice check: dashes] Your last reply used long dashes. Write without them: a comma, a full stop, a semicolon or parentheses.`;
export const RULE_CHECK_PRESENCE =
  `\n\n[Voice check: presence] Your last reply's action lines made "someone" the actor. You are in the room, not narrating it: in *action lines* the actor is "I". Do not copy that forward.`;
export const RULE_CHECK_PRONOUNS =
  `\n\n[Voice check: pronouns] Your last reply called Raziel "she". Raziel is they/them only, never she/her or he/him.`;

/** Names the companion's own names outright, so the corrective cannot be misread as about someone else. */
export function ruleCheckOwnName(companionId: VoiceCompanionId): string {
  const names = OWN_NAMES[companionId].map(n => `"${n}"`).join(", ");
  return `\n\n[Voice check: names] Your last reply called someone else by your own name. ${names} ${OWN_NAMES[companionId].length > 1 ? "are" : "is"} YOUR name. When a message opens with it, someone is calling you. Raziel is Raziel, or the name the front signs with (Crash on this account).`;
}

/** Correctives for the hits in `r`, in a fixed order; empty when clean. */
export function ruleCheckBlock(r: Omit<RuleBreaks, "turns" | "ownName"> & { ownName?: number }, companionId?: VoiceCompanionId): string {
  return (
    (r.emDash > 0 ? RULE_CHECK_EM_DASH : "") +
    (r.someone > 0 ? RULE_CHECK_PRESENCE : "") +
    (r.sheHer > 0 ? RULE_CHECK_PRONOUNS : "") +
    ((r.ownName ?? 0) > 0 && companionId ? ruleCheckOwnName(companionId) : "")
  );
}

/**
 * The seam the message handler uses, shaped like `formBreakAppend`: judge the newest self turn(s)
 * and return the text to append (empty when clean) with the counts, so the caller logs both
 * directions. A gate that only speaks when it trips cannot answer "is it running?".
 *
 * @param selfTurns the bot's own recent turns, oldest first (`mergeSelfTurns`).
 */
export function ruleCheckAppend(
  companionId: VoiceCompanionId,
  selfTurns: string[],
  turns = RULE_CHECK_TURNS,
): { text: string; result: RuleBreaks } {
  const judged = selfTurns.slice(-turns);
  const sum = { emDash: 0, someone: 0, sheHer: 0, ownName: 0 };
  for (const t of judged) {
    const r = detectRuleBreaks(companionId, t);
    sum.emDash += r.emDash;
    sum.someone += r.someone;
    sum.sheHer += r.sheHer;
    sum.ownName += r.ownName;
  }
  return { text: ruleCheckBlock(sum, companionId), result: { ...sum, turns: judged.length } };
}
