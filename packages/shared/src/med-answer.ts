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
  // Endearments (2026-09-28: "Taken lover" was refused because "lover" was an unknown word).
  "lover", "darling", "sweetheart", "sweetie", "beloved", "hun", "dearest",
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

/**
 * The OPENING-CLAUSE path (2026-09-30). The whitelist below needs every word known, and his real
 * answers never look like that: from 09-29 to 09-30 all four were refused and nothing was recorded
 * ("Taken! This is really helping baby", "Taken baby love you I am sleepy", "Taken baby! Thank you
 * ugh it's too early to be awake but work call", "I did take them this morning baby sorry I was
 * distracted..."). He answers first, then talks. So: a message that OPENS with a taking verb (not
 * "yes", not "done": those open plenty of messages that are not about meds) counts, and whatever he
 * says after it is his, not the matcher's. Still conservative where it matters: the opening clause
 * (to the first . ! ? newline or "but", at most 6 words past the verb) must not negate, defer or
 * ask; "took" needs a med object or nothing after it ("took the dog out" is not an answer); a
 * "but not" / "except" anywhere refuses ("took them yesterday but not today").
 */
const LEAD_RE = /^(?:(?:yes|yep|yeah|yup|ok|okay)[\s,!.]+)?(?:i\s+|i've\s+|ive\s+|have\s+|just\s+|already\s+|did\s+)*(?:(taken)|(took)|(take))\b/;
const TOOK_OBJECT_RE = /^(?:them|it|em|'em|those|these|mine|my\s+(?:meds|med|medicine|medication|pills|pill|dose|shot|injection)|the\s+(?:meds|pills|medicine|dose))\b/;
const CLAUSE_END_RE = /[.!?\n]|\bbut\b/;
const LATE_NEGATION_RE = /\bbut\s+(?:not|didn'?t|haven'?t|forgot|missed|skipped|no)\b|\bexcept\b/;
const CLAUSE_NEGATE = new Set([...NEGATE, "yesterday", "aback"]);
const TOOK_ENDEARMENT_RE = /^(?:baby|babe|love|lover|darling|hon|honey|sweetheart|dre|drev|drevan|cy|gaia|thank|thanks|ty)\b/;

function opensWithTaken(raw: string): boolean {
  const text = foldEmoji(raw).toLowerCase().replace(/[’`]/g, "'").trim();
  if (!text || text.length > 400) return false;
  if (LATE_NEGATION_RE.test(text)) return false;
  const m = LEAD_RE.exec(text);
  if (!m) return false;
  const lead = m[0];
  // "take" only after "did" ("I did take them"); bare "take" / "I take" is a habit or a plan.
  // "took" and "take" both need a med object (or an endearment) next: "I did take a nap" is not meds.
  if (m[3] && !/\bdid\s+$/.test(lead.slice(0, lead.length - "take".length))) return false;
  const after = text.slice(lead.length);
  const endIdx = after.search(CLAUSE_END_RE);
  const clauseTail = endIdx === -1 ? after : after.slice(0, endIdx);
  if (endIdx !== -1 && after[endIdx] === "?") return false;
  if (m[2] || m[3]) {
    const t = clauseTail.trim();
    if (t && !TOOK_OBJECT_RE.test(t) && !TOOK_ENDEARMENT_RE.test(t)) return false;
  }
  const words = clauseTail.replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  return !words.some(w => CLAUSE_NEGATE.has(w));
}

export function isAffirmativeMedAnswer(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (opensWithTaken(raw)) return true;
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
