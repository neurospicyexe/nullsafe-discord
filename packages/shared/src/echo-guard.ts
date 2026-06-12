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
export const ECHO_DEFAULT_THRESHOLD = 0.45;

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
export function detectMotif(texts: string[], minTurns = 4, topK = 3): string[] {
  if (texts.length < minTurns) return [];
  const turnCounts = new Map<string, number>();
  for (const t of texts) {
    for (const w of new Set(contentWords(t))) {
      turnCounts.set(w, (turnCounts.get(w) ?? 0) + 1);
    }
  }
  const floor = Math.max(minTurns, Math.floor(texts.length * 0.6));
  const motif = [...turnCounts.entries()].filter(([, c]) => c >= floor);
  motif.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return motif.slice(0, topK).map(([w]) => w);
}
