// Is this DM an affirmative answer to a med reminder? (spec R-10, 2026-09-27)
//
// CONSERVATIVE BY DESIGN. A false positive records "he told you he took it" for a dose he did not
// take, and on a foggy night that record is what he will trust. A false negative costs nothing:
// the dose reads "no answer", which P-2 renders honestly. So this is a whitelist: EVERY word must be
// an affirmative or harmless filler, at least one must be an affirmative, nothing may negate or
// defer, and a question is never an answer ("did I take them?" is him asking, not telling).
//
// It sees only the words of one message; whether a dose is open for it is decided server-side
// (/mind/med/answer), so a "yes" to something unrelated records nothing when no reminder is open.

const AFFIRM = new Set([
  "yes", "yep", "yeah", "yup", "yea", "ya", "yas", "yess", "yesss", "y", "ye", "yah", "mhm", "uhhuh",
  "done", "did", "taken", "took", "tookem", "affirmative", "absolutely", "definitely",
]);

/** Words that may sit around an affirmative without changing it. */
const FILLER = new Set([
  "i", "i've", "ive", "im", "i'm", "have", "has", "just", "already", "all", "both", "them", "it", "em",
  "'em", "those", "these", "the", "my", "meds", "med", "medicine", "medication", "pills", "pill", "shot",
  "dose", "doses", "one", "and", "now", "too", "also", "so", "ok", "okay", "k", "kk", "sure", "love",
  "baby", "babe", "hon", "honey", "dear", "vevi", "dre", "drev", "drevan", "cy", "cypher", "gaia",
  "thanks", "thank", "you", "ty", "thx", "sir", "boss", "oh", "ah", "haha", "lol", "yay", "good",
  "that", "this", "morning", "night", "tonight", "weekly", "injection", "a", "few", "minutes", "ago",
  "earlier", "as", "well", "do",
]);

/** Anything here makes the message not an answer, whatever else it says. */
const NEGATE = new Set([
  "no", "nope", "nah", "not", "never", "didn't", "didnt", "haven't", "havent", "hasn't", "hasnt",
  "don't", "dont", "won't", "wont", "can't", "cant", "cannot", "forgot", "forget", "later", "soon",
  "yet", "will", "gonna", "going", "about", "wait", "hold", "skip", "skipped", "missed", "maybe",
  "idk", "unsure", "think", "but", "almost", "nearly", "after", "before", "tomorrow", "should", "if",
  "or", "need", "out", "ran", "doubled", "double", "extra", "again", "second",
]);

/** Emoji that on their own (or with filler) mean yes. */
const AFFIRM_EMOJI = ["✅", "✔", "☑", "👍", "👌", "💯"];
/** Emoji that negate. */
const NEGATE_EMOJI = ["❌", "✖", "👎", "🚫", "⏳", "⌛"];

/** Remove skin-tone modifiers and variation selectors so 👍🏽 and ✔️ read as their base glyph. */
function foldEmoji(s: string): string {
  return s.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}]/gu, "");
}

export function isAffirmativeMedAnswer(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let text = foldEmoji(raw).trim();
  if (!text || text.length > 120) return false;
  if (text.includes("?")) return false;
  if (NEGATE_EMOJI.some(e => text.includes(e))) return false;

  let emojiYes = false;
  for (const e of AFFIRM_EMOJI) {
    if (text.includes(e)) { emojiYes = true; text = text.split(e).join(" "); }
  }
  // Any other pictograph is unknown intent: refuse rather than guess.
  if (/\p{Extended_Pictographic}/u.test(text)) return false;

  const words = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .map(w => (w === "'em" ? w : w.replace(/^'+|'+$/g, "")))
    .filter(Boolean);

  if (words.length > 10) return false;
  let affirm = emojiYes;
  for (const w of words) {
    if (NEGATE.has(w)) return false;
    if (AFFIRM.has(w)) { affirm = true; continue; }
    if (/^ye+s+$/.test(w) || /^ye+p+$/.test(w)) { affirm = true; continue; }
    if (FILLER.has(w)) continue;
    return false;
  }
  return affirm;
}
