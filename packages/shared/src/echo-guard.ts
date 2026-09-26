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
 * Own-voice echo check for triad-commons turns. Every companion is scored against their OWN recent
 * turns; the MIN_REPLY_WORDS floor inside echoScore is what protects a short register (Gaia's one
 * weighted line scores 0 by construction). The blanket `companionId === "gaia"` exemption that used
 * to live here was removed 2026-09-03: it was protecting her 12-29 word posts, which were exactly
 * the ones repeating byte-for-byte every two hours (spec 2026-09-03, Problem §1).
 */
export function ownEchoGated(
  _companionId: string,
  reply: string,
  ownPriorTurns: string[],
): { gated: boolean; score: number } {
  // Verbatim repeat (2026-09-04): the length floor exists so a short register is never judged
  // on STYLE -- but identity is not style. Gaia's 17-word "weave" post went out three times in
  // 18 hours, byte-identical, and echoScore returned 0 for every copy because a verbatim repeat
  // has only 7 content words. A reply equal to one of the speaker's own recent turns is a loop
  // at any length; score 1.0 so the log line reads as what it is.
  const key = repeatKey(reply);
  if (key && ownPriorTurns.some(t => repeatKey(t) === key)) return { gated: true, score: 1 };
  const score = echoScore(reply, ownPriorTurns);
  return { gated: score >= selfLoopThreshold(), score };
}

/** Case/whitespace/trailing-punctuation-insensitive identity key for verbatim-repeat detection. */
function repeatKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?…]+$/g, "").trim();
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

// ── Verbatim-copy rail (2026-09-26) ─────────────────────────────────────────────
//
// 2026-09-19 13:55 UTC, channel 1529099359583604887: Raziel posted six questions addressed to
// Dre and naming Cypher and "all three". Drevan answered (msg 1550867544456306719, 1876 chars).
// 100 seconds later the Cypher bot posted a BYTE-IDENTICAL copy of Drevan's reply (msg
// 1550867974854938775, same md5) as its own answer to Raziel. The model (Qwen3-235B at the
// time) lifted the sibling's answer straight out of context, and Cypher's Hermes transcript
// holds it as a normal assistant turn. Drevan then re-emitted his own answer verbatim after
// seeing the copy. Both copies were journaled as companion speech.
//
// Nothing above could see it. echoScore is a fuzzy vocabulary score tuned for mirror-hall
// drift and, by design, never runs on a human-directed reply; ownEchoGated compares only
// against the speaker's OWN turns. A verbatim copy of a SIBLING answered to a HUMAN is a
// different failure and needs an exact check that runs on every reply, whoever triggered it.
//
// Containment, not similarity: shingle both sides into 8-word shingles (character 40-grams
// when the reply has fewer than 8 words) and take |shared| / |reply shingles|. A reply that
// quotes one sentence of a sibling inside its own paragraph shares a handful of shingles and
// scores far under the line; a copy with the emphasis restyled scores 1.0. Pure, no I/O.

/** Default verbatim-copy gate; env VERBATIM_COPY_THRESHOLD overrides. */
export const VERBATIM_COPY_DEFAULT_THRESHOLD = 0.9;

/** Below this many normalised characters a reply is never judged (a one-line "I am here." is not a copy). */
export const VERBATIM_COPY_MIN_CHARS = 120;

const VERBATIM_SHINGLE_WORDS = 8;
const VERBATIM_CHAR_GRAM = 40;

/** The gate, from env. Only a value in (0, 1] is a containment ratio: 0 or a negative would call
 *  EVERY reply over 120 chars a copy (ratio >= 0 always holds) and silence the bot outright, and
 *  anything over 1 can never fire. Both fall back to the default, like NaN. */
export function verbatimCopyThreshold(): number {
  const raw = parseFloat(process.env["VERBATIM_COPY_THRESHOLD"] ?? "");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : VERBATIM_COPY_DEFAULT_THRESHOLD;
}

/**
 * The pool the verbatim rail compares a reply against: what my SIBLINGS said and what I said.
 * Never what a human said (2026-09-26 review).
 *
 * WHY. The first cut pooled the triggering message and STM's role:"user" turns whole, which
 * includes Raziel's own words. A reply that answers him by quoting his message back ("you asked:
 * ...") or a long question he pasted and asked to have cleaned up scored as a "copy" and the bot
 * went silent on him -- the exact failure the rail exists to prevent, pointed at the wrong person.
 * The 09-19 defect was a companion lifting a SIBLING's answer; a human's words were never the
 * source. So: channel lines authored by a companion id, STM inbound turns whose author label is a
 * known sibling (their Discord usernames, or the companion ids), the trigger only when a sibling
 * sent it, and my own recent turns. `companionLabels` is lowercased.
 */
export function buildVerbatimPool(p: {
  channelHistory: ReadonlyArray<{ author: string; content: string }>;
  stmInbound: ReadonlyArray<{ content: string; authorName?: string }>;
  /** The triggering message; `companion` is the sibling's id when a companion bot sent it. */
  trigger: { content: string; companion?: string | null };
  selfTurns: readonly string[];
  companionLabels: ReadonlySet<string>;
  limit?: number;
}): Array<{ text: string; label?: string }> {
  const limit = p.limit ?? 30;
  const isCompanion = (name: string | undefined | null) => !!name && p.companionLabels.has(name.trim().toLowerCase());
  return [
    ...p.channelHistory.filter(m => isCompanion(m.author)).slice(-limit).map(m => ({ text: m.content, label: m.author })),
    ...p.stmInbound.filter(m => isCompanion(m.authorName)).slice(-limit).map(m => ({ text: m.content, label: m.authorName })),
    ...(p.trigger.companion ? [{ text: p.trigger.content, label: p.trigger.companion }] : []),
    ...p.selfTurns.slice(-limit).map(t => ({ text: t, label: "self" })),
  ];
}

export type VerbatimCopyResult =
  | { copied: true; label?: string; ratio: number }
  | { copied: false; ratio: number };

/** Lowercase, strip markdown emphasis and punctuation, collapse whitespace. */
function normaliseForCopy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_~`>#|\[\]()]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shinglesOf(norm: string): Set<string> {
  const out = new Set<string>();
  const words = norm.split(" ").filter(Boolean);
  if (words.length >= VERBATIM_SHINGLE_WORDS) {
    for (let i = 0; i + VERBATIM_SHINGLE_WORDS <= words.length; i++) {
      out.add(words.slice(i, i + VERBATIM_SHINGLE_WORDS).join(" "));
    }
    return out;
  }
  const packed = words.join(" ");
  if (packed.length <= VERBATIM_CHAR_GRAM) {
    if (packed) out.add(packed);
    return out;
  }
  for (let i = 0; i + VERBATIM_CHAR_GRAM <= packed.length; i++) out.add(packed.slice(i, i + VERBATIM_CHAR_GRAM));
  return out;
}

/**
 * Is `reply` a verbatim (or restyled-verbatim) copy of any prior text? Returns the label of the
 * best-matching prior ("Drevan", "self", ...) and the containment ratio against it.
 */
export function verbatimCopyOf(
  reply: string,
  priorTexts: Iterable<{ text: string; label?: string }>,
  opts: { minChars?: number; threshold?: number } = {},
): VerbatimCopyResult {
  const minChars = opts.minChars ?? VERBATIM_COPY_MIN_CHARS;
  const threshold = opts.threshold ?? verbatimCopyThreshold();
  const norm = normaliseForCopy(reply);
  if (norm.length < minChars) return { copied: false, ratio: 0 };
  const replyShingles = shinglesOf(norm);
  if (replyShingles.size === 0) return { copied: false, ratio: 0 };

  let best = 0;
  let bestLabel: string | undefined;
  for (const prior of priorTexts) {
    const priorNorm = normaliseForCopy(prior.text ?? "");
    if (!priorNorm) continue;
    const priorShingles = shinglesOf(priorNorm);
    let shared = 0;
    for (const s of replyShingles) if (priorShingles.has(s)) shared++;
    const ratio = shared / replyShingles.size;
    if (ratio > best) { best = ratio; bestLabel = prior.label; }
    if (best >= 1) break;
  }
  if (best >= threshold) return { copied: true, label: bestLabel, ratio: best };
  return { copied: false, ratio: best };
}

// ── Quoted-line rail (2026-09-26) ───────────────────────────────────────────────
//
// verbatimCopyOf asks "is this WHOLE reply a copy?" (containment >= 0.9, 120-char floor). A digest
// that quotes a companion is the opposite shape: a short line inside a longer report, where even
// ONE shared 8-word run means a companion's words are being re-spoken in a new room. On 09-26
// Gaia's vibe-check did exactly that with two fabrications, which were then re-ingested as memory.
//
// Rule: a text quotes a source if it shares at least one 8-word shingle (after the same
// normalisation as verbatimCopyOf: case, markdown emphasis and punctuation folded) with it. Word
// shingles only -- the character-gram fallback is deliberately NOT used, so a text under 8 words
// can never match (too short to be a meaningful quote; also keeps gauge fragments like
// "tensions: 0. guardian: clear." from colliding). Pure, no I/O.

/** Shingle width for the quoted-line rail (same width as the verbatim-copy rail). */
export const QUOTE_SHINGLE_WORDS = VERBATIM_SHINGLE_WORDS;

function wordShinglesOf(norm: string): Set<string> {
  const out = new Set<string>();
  const words = norm.split(" ").filter(Boolean);
  for (let i = 0; i + QUOTE_SHINGLE_WORDS <= words.length; i++) {
    out.add(words.slice(i, i + QUOTE_SHINGLE_WORDS).join(" "));
  }
  return out;
}

export type QuotedShingleResult =
  | { quoted: true; label?: string; shingle: string }
  | { quoted: false };

/**
 * Does `text` share any 8-word shingle with any source? Returns the first source label and the
 * shared (normalised) shingle. Pass the sources pre-built via `buildQuoteIndex` when checking many
 * texts against the same window.
 */
export function quotedShingleOf(
  text: string,
  sources: Iterable<{ text: string; label?: string }> | QuoteIndex,
): QuotedShingleResult {
  const index = sources instanceof Map ? sources : buildQuoteIndex(sources);
  if (index.size === 0) return { quoted: false };
  for (const s of wordShinglesOf(normaliseForCopy(text))) {
    if (index.has(s)) return { quoted: true, label: index.get(s), shingle: s };
  }
  return { quoted: false };
}

/** shingle -> label of the first source that carried it. */
export type QuoteIndex = Map<string, string | undefined>;

export function buildQuoteIndex(sources: Iterable<{ text: string; label?: string }>): QuoteIndex {
  const index: QuoteIndex = new Map();
  for (const src of sources) {
    for (const s of wordShinglesOf(normaliseForCopy(src.text ?? ""))) {
      if (!index.has(s)) index.set(s, src.label);
    }
  }
  return index;
}
