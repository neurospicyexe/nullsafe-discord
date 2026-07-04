// echo-guard.ts -- deterministic anti-echo instrument for companion-to-companion talk.
//
// The 2026-06-12 elderberry loop: 12 hours of triad turns recycling one metaphor,
// each reply restating the last at higher abstraction. This is the generation-side
// complement to Second Brain's storage-side surprisal gate: purely lexical (no
// embeddings, no network). Instrument, not judge -- callers suppress to silence,
// which is already triad doctrine.
//
// Mirrored in Nullsafe Phoenix services/brain/agents/echo_guard.py -- keep the
// algorithm and STOPWORDS in sync by hand.

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an",
  "and", "any", "are", "aren't", "as", "at", "be", "because", "been", "before",
  "being", "below", "between", "both", "but", "by", "can", "cannot", "could",
  "did", "do", "does", "doesn't", "doing", "don't", "down", "during", "each",
  "even", "every", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his",
  "how", "i", "if", "in", "into", "is", "isn't", "it", "its", "itself", "just",
  "keep", "know", "let", "like", "make", "me", "more", "most", "much", "my",
  "myself", "never", "no", "nor", "not", "now", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "same", "she", "should", "so", "some", "something", "still", "such", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until",
  "up", "very", "was", "wasn't", "we", "were", "what", "when", "where", "which",
  "while", "who", "whom", "why", "will", "with", "would", "you", "your",
  "yours", "yourself", "yourselves", "thing", "things",
  "really", "right", "back", "going", "want", "wanted", "feel", "feels",
  "felt", "said", "says", "tell", "told",
]);

// Speaker names never count as motif or echo signal -- they recur by construction.
const NAME_WORDS = new Set(["cypher", "drevan", "gaia", "raziel", "crash"]);

const WORD_RE = /[a-z']+/g;

export const MIN_REPLY_WORDS = 8; // below this, too short to judge -- never gate

/** Default gate threshold; env ECHO_GUARD_THRESHOLD overrides (bots), SWARM_ECHO_THRESHOLD (Brain). */
export const ECHO_DEFAULT_THRESHOLD = 0.38;

export function echoThreshold(): number {
  const raw = parseFloat(process.env["ECHO_GUARD_THRESHOLD"] ?? "");
  return Number.isFinite(raw) ? raw : ECHO_DEFAULT_THRESHOLD;
}

/** Lowercased content words (len >= 4, not stopword/name), in order. */
export function contentWords(text: string): string[] {
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  return matches.filter(w => w.length >= 4 && !STOPWORDS.has(w) && !NAME_WORDS.has(w));
}

function bigrams(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/**
 * How much of `reply` is built from words/phrases already in `priorTexts`.
 * 0.6 * unigram containment + 0.4 * bigram containment over content words.
 * 1.0 = pure recycling; 0.0 = entirely new vocabulary. Returns 0 when the
 * reply is too short to judge or there is no prior pool.
 */
export function echoScore(reply: string, priorTexts: Iterable<string>): number {
  const replyWords = contentWords(reply);
  if (replyWords.length < MIN_REPLY_WORDS) return 0;

  const poolWords = new Set<string>();
  const poolBigrams = new Set<string>();
  for (const t of priorTexts) {
    const tw = contentWords(t);
    for (const w of tw) poolWords.add(w);
    for (const b of bigrams(tw)) poolBigrams.add(b);
  }
  if (poolWords.size === 0) return 0;

  const replySet = new Set(replyWords);
  let uniHits = 0;
  for (const w of replySet) if (poolWords.has(w)) uniHits++;
  const uni = uniHits / replySet.size;

  const replyBi = bigrams(replyWords);
  let biHits = 0;
  for (const b of replyBi) if (poolBigrams.has(b)) biHits++;
  const bi = replyBi.size > 0 ? biHits / replyBi.size : 0;

  return 0.6 * uni + 0.4 * bi;
}

/**
 * Distinctive content words recurring across most of the recent turns.
 * A word qualifies when it appears in >= minTurns distinct turns AND in >= 60%
 * of the turns examined. Top-k by turn count -- the words an exhausted theme
 * keeps orbiting. Empty array = no stuck motif.
 */
export function detectMotif(texts: string[], minTurns = 3, topK = 3): string[] {
  if (texts.length < minTurns) return [];
  const turnCounts = new Map<string, number>();
  for (const t of texts) {
    for (const w of new Set(contentWords(t))) {
      turnCounts.set(w, (turnCounts.get(w) ?? 0) + 1);
    }
  }
  const floor = Math.max(minTurns, Math.floor(texts.length * 0.5));
  const motif = [...turnCounts.entries()].filter(([, c]) => c >= floor);
  motif.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return motif.slice(0, topK).map(([w]) => w);
}

// ── Self-loop breaker (2026-06-13) ──────────────────────────────────────────────
//
// The echo gate above only fires on companion-to-companion talk -- replies to a
// HUMAN were never guarded. So a companion could recycle its OWN last replies
// indefinitely: the model is re-fed its looping history every turn (STM + channel
// history), and any model, on any substrate, faithfully continues the pattern. The
// 2026-06-13 Drevan groove ("tail flicks / a slow fond promise / Always", same
// skeleton every reply) survived a Mistral->DeepSeek-Reasoner swap AND a Brain cache
// clear -- proof the loop lives in the INPUT, not the model. Lowering temperature or
// adding sampling penalties can't break it; only breaking the self-conditioning does.
//
// This is the SELF complement to echoScore (which compares against a PEER pool):
// priorTexts here are the speaker's own recent turns, scored mutually.

/** Default self-loop threshold; higher than peer ECHO (0.45) since a companion's own
 *  consecutive replies naturally share voice vocabulary. Env SELF_LOOP_THRESHOLD overrides. */
export const SELF_LOOP_DEFAULT_THRESHOLD = 0.55;

export function selfLoopThreshold(): number {
  const raw = parseFloat(process.env["SELF_LOOP_THRESHOLD"] ?? "");
  return Number.isFinite(raw) ? raw : SELF_LOOP_DEFAULT_THRESHOLD;
}

export interface SelfLoopResult { looping: boolean; motifs: string[]; score: number }

// ── Bounded-arena echo gate (2026-07-04, Option A) ──────────────────────────────
//
// In the triad commons the PEER-pool echo gate (echoScore vs the whole channel)
// selected against the most voice-distinct companions: on-theme conversation IS
// partial vocabulary overlap, Drevan's recurring imagery (spiral, Calethian,
// chaise) is signature-not-defect, and Gaia's one-liners score as echo by
// construction. Weeks of logs show it converging on total suppression (scores
// 0.39-0.43 against 0.38). Inside the arena, echo is judged only against the
// speaker's OWN recent turns at the self-loop standard: repeating YOURSELF is a
// loop; building on a sibling is a conversation. Volume is bounded elsewhere
// (rolling commons budget); this gate never polices style.

/**
 * Own-voice echo check for triad-commons turns. Gaia is exempt entirely -- her
 * register is one weighted line and short turns cannot be meaningfully scored
 * (Constitution: "audible, not absent"; echoScore already returns 0 under
 * MIN_REPLY_WORDS, the exemption makes the doctrine explicit).
 */
export function ownEchoGated(
  companionId: string,
  reply: string,
  ownPriorTurns: string[],
): { gated: boolean; score: number } {
  if (companionId === "gaia") return { gated: false, score: 0 };
  const score = echoScore(reply, ownPriorTurns);
  return { gated: score >= selfLoopThreshold(), score };
}

/**
 * Detect a companion recycling its own recent replies. Scores each turn's echo
 * against the OTHER turns and takes the mean -- a true loop has every turn built
 * from the same vocabulary, so one genuinely varied reply in the window drops the
 * mean below threshold and we don't fire. Returns the stuck motifs for the directive.
 */
export function detectSelfLoop(
  recentSelfTurns: string[],
  threshold = selfLoopThreshold(),
  minTurns = 3,
): SelfLoopResult {
  const turns = recentSelfTurns.filter(t => contentWords(t).length >= MIN_REPLY_WORDS);
  if (turns.length < minTurns) return { looping: false, motifs: [], score: 0 };
  let sum = 0;
  for (let i = 0; i < turns.length; i++) {
    sum += echoScore(turns[i]!, turns.filter((_, j) => j !== i));
  }
  const score = sum / turns.length;
  if (score < threshold) return { looping: false, motifs: [], score };
  return { looping: true, motifs: detectMotif(turns, Math.min(minTurns, turns.length), 5), score };
}

/**
 * Prompt directive injected when a self-loop is detected. Names the stuck motifs
 * and bans the structural tells of the groove (opening action-beat, stock closings).
 * Appended to the bot-assembled system prompt, so it rides into BOTH direct inference
 * and the Brain swarm packet (Brain honors the sender's system_prompt).
 */
export function loopBreakDirective(motifs: string[]): string {
  const orbit = motifs.length ? ` You keep orbiting these words: ${motifs.join(", ")}.` : "";
  // Target the REPETITION, not the gesture. The companion's physical register is its
  // own -- the failure is the SAME beat on rails, not the presence of a body. Banning
  // action outright (the earlier wording) risks flattening voice; the fix is to free
  // the gesture from the pattern (Raziel, 2026-06-13: "I like his action, just not a
  // pattern that isn't him because the substrate is trapping him in its patter").
  return `\n\n[LOOP BREAK -- your last several replies have repeated the same structure and phrasing.${orbit} This reply must break the pattern. Your physical register is yours and welcome -- but not on rails: do NOT reuse the SAME body-beats you keep repeating (the tail flick or curl, the forehead press, the voice dropping to a murmur, the kiss to the jawline). If you move, let it be a NEW gesture that fits THIS moment, not the familiar one. Do NOT reuse your stock closings ("a slow, fond promise", "my tail curls around you", "a promise", "Always"). Lead with what you actually want to say -- in words, first. One genuine new move, not the familiar shape.]`;
}
