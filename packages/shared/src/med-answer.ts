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

/** Joining words are not part of a dose's name ("A and B" is named by "A, B"). */
export const LABEL_JOINERS = new Set(["and", "the", "of", "plus", "with", "my", "a"]);
/** The naming words of a dose label, lowercased, joiners dropped. Shared with namesLabel
 *  (med-reminder.ts), so "names the dose" and "a dose word" mean the same words. */
export function labelWords(label: string): string[] {
  return label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !LABEL_JOINERS.has(w));
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
// The interjections he opens with (2026-10-03: "Yay taken baby sorry I was caught up in the movie"
// recorded nothing). Up to three, endearments included, so "ugh sorry baby took my meds" reads; the verb rules after them are
// unchanged ("oh I took the dog out" still has no dose object and refuses).
const LEAD_RE = /^(?:(?:yes|yep|yeah|yup|ok|okay|yay|yayy|oops|omg|oh|ah|ahh|ugh|sorry|baby|babe|love|lover|vevi)[\s,!.]+){0,3}(?:i\s+|i've\s+|ive\s+|have\s+|just\s+|already\s+|did\s+)*(?:(taken)|(took)|(take))\b/;
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

// ── parseMedAnswer: named doses and stated misses (Raziel's ruling 2026-10-01) ──────────────────
//
// A miss is recorded only when he says it; silence records nothing. This turns ONE message into
// zero or more statements { slot, outcome }:
//   slot     "morning" | "night" | "weekly" (named), "*" (both / all of them), or null (unnamed:
//            Halseth picks the most recently reminded open dose, exactly as before).
//   outcome  "taken", or "missed" only for an explicit past statement ("I missed it", "forgot the
//            morning jar", "didn't take my night ones", "skipped tonight").
// null = nothing to record. The conservatism of the matcher above stays: a false record is worse
// than none, so a contradiction, an unresolvable negation or a question about meds refuses the
// whole message, and a DEFERRAL ("not yet", "later", "taking them now", "gonna", "in a minute") is
// never a miss: he may still take it.
//
// Clause model. The message is cut at . ! ? ; newline , "and" "but". Each clause is one of:
//   TAKEN    opens with a taking verb (the opening-clause rules above), or is all known words
//            with an affirmative ("morning ones done", "last night's taken").
//   MISSED   [filler] missed | forgot [to take] | skipped | didn't take | did not take | never
//            took, then an object that is a dose or nothing ("I missed you" is not a dose).
//   DEFER    a deferral word with a dose word in the clause, or a bare one ("later"): cancels
//            that slot; unnamed, it refuses the message ("forgot, taking them now" records nothing).
//   INHERIT  only dose words after "," / "and": takes the previous clause's outcome
//            ("took my morning and night ones").
//   NEG      "but not my night jar" after a TAKEN: that slot is missed. Without a slot, or after a
//            MISSED, it is unresolvable and refuses ("took one but not the other").
// Bare "didn't", "no", "not taken" and present-tense "skip tonight" stay non-answers: they do not
// clearly say a dose was not taken (he may be deferring or deciding). Whether a dose is open for a
// statement is decided server-side, so a "forgot" with no reminder open records nothing.

export type MedNamedSlot = "morning" | "night" | "weekly";
export type MedAnswerSlot = MedNamedSlot | "*" | null;
export type MedAnswerOutcome = "taken" | "missed";
export interface MedAnswerEntry { slot: MedAnswerSlot; outcome: MedAnswerOutcome }
export interface ParsedMedAnswer { entries: MedAnswerEntry[] }

const SLOT_WORD: Record<string, MedNamedSlot> = {
  morning: "morning", mornings: "morning",
  night: "night", nights: "night", tonight: "night", nighttime: "night", bedtime: "night", nightly: "night",
  weekly: "weekly",
};
const ENDEAR = new Set([
  "baby", "babe", "love", "lover", "darling", "hon", "honey", "sweetheart", "sweetie", "beloved", "hun",
  "dearest", "dear", "vevi", "dre", "drev", "drevan", "cy", "cypher", "gaia",
]);
const PRONOUN_OBJ = new Set(["them", "it", "em", "'em", "those", "these", "mine"]);
const MED_NOUN = new Set([
  "meds", "med", "medicine", "medication", "medications", "pills", "pill", "dose", "doses", "jar", "jars",
  "one", "ones", "shot", "injection",
]);
const TAKE_VERB = new Set(["take", "taking", "took", "taken", "takes"]);
const PLACE_PREP = new Set(["to", "out", "for", "with", "home", "outside", "back", "over", "around", "into", "inside", "along", "off"]);
/** Words that may make up a dose reference ("my morning jar", "both", "the night ones too"). */
const REGION = new Set([
  ...PRONOUN_OBJ, ...MED_NOUN, ...Object.keys(SLOT_WORD), ...ENDEAR,
  "my", "the", "this", "last", "of", "both", "all", "too", "also", "already", "just", "now", "today",
]);
/** May follow a stated miss without changing it ("forgot the morning one sorry"). */
const MISS_TAIL = new Set([
  ...ENDEAR, "sorry", "though", "oops", "ugh", "lol", "haha", "again", "today", "honestly", "completely",
  "totally", "oh", "so", "really", "i'm", "im",
]);
const MISS_RE = /^(?:(?:no|nope|nah|oh|ugh|sorry|so|ok|okay|yeah|i|i've|ive|i'm|im|just|totally|completely|actually|honestly|accidentally|baby|babe|love|lover|hon|honey|darling)\s+)*(missed|forgot(?:ten)?(?:\s+to\s+take)?|skipped|didn'?t\s+take|did\s+not\s+take|never\s+took)\b/;
const DEFER_RE = /\b(?:later|yet|soon|gonna|wait|tomorrow|i'll|will|taking|about\s+to|going\s+to|in\s+a\s+(?:min|mins|minute|minutes|sec|second|bit|moment|few)|hold\s+on|after)\b/;
const DEFER_BARE = new Set([
  ...ENDEAR, "later", "yet", "soon", "gonna", "wait", "tomorrow", "i'll", "will", "about", "to", "going",
  "in", "a", "min", "mins", "minute", "minutes", "sec", "second", "bit", "moment", "few", "hold", "on",
  "not", "no", "ok", "okay", "i", "do", "it", "after", "one", "just", "so", "sorry",
]);
const CLAUSE_EXTRA_FILLER = new Set(["are", "is", "ones", "jar", "jars", "last", "of", "today"]);

// THE OPEN DOSE'S OWN NAME IS A DOSE WORD (2026-10-06). "I took my <label>" recorded nothing: the
// label word was unknown, so "my <label>" was no dose object and "took" read like "took the dog
// out". The caller passes the labels of the doses that are open; their naming words count as dose
// nouns for THIS parse only. parseMedAnswer is synchronous, so a module-scoped set assigned at entry
// and cleared in `finally` cannot leak between calls. A word the matcher already gives another
// meaning (negation, affirmative, taking verb, pronoun, endearment, deferral, filler) and any word
// under three letters never becomes a dose noun.
let labelNouns: ReadonlySet<string> = new Set();
const isMedNoun = (w: string) => MED_NOUN.has(w) || labelNouns.has(w);
const inRegion = (w: string) => REGION.has(w) || labelNouns.has(w);
function labelNounsOf(labels: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const l of labels ?? []) {
    for (const w of labelWords(l)) {
      if (w.length < 3 || NEGATE.has(w) || AFFIRM.has(w) || TAKE_VERB.has(w) || PRONOUN_OBJ.has(w)
        || ENDEAR.has(w) || DEFER_BARE.has(w) || FILLER.has(w) || SLOT_WORD[w]) continue;
      out.add(w);
    }
  }
  return out;
}

type ClauseKind = "taken" | "missed" | "defer" | "neg" | "inherit" | "none" | "ambig" | "refuse";
interface Clause { words: string[]; sep: "start" | "terminal" | "join" | "but"; question: boolean }
interface SlotRef { named: Set<MedNamedSlot>; star: boolean }
interface Statement { kind: ClauseKind; slots: SlotRef }

function tokensOf(s: string): string[] {
  return s
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .map(w => (w === "'em" ? w : w.replace(/^'+|'+$/g, "")))
    .map(w => (w.endsWith("'s") && SLOT_WORD[w.slice(0, -2)] ? w.slice(0, -2) : w))
    .filter(Boolean);
}

function slotsOf(words: string[]): SlotRef {
  const named = new Set<MedNamedSlot>();
  let star = false;
  words.forEach((w, i) => {
    const s = SLOT_WORD[w];
    if (s) named.add(s);
    if (w === "both") star = true;
    if (w === "all" && words[i + 1] === "of" && /^(?:them|em|'em|my|the)$/.test(words[i + 2] ?? "")) star = true;
    if (w === "all" && /^(?:my|the|meds|pills|doses|jars|ones|three)$/.test(words[i + 1] ?? "")) star = true;
    if (w === "them" && words[i + 1] === "all") star = true;
  });
  return { named, star };
}

/** Leading words of `words` that form a dose reference (stops at the first word that cannot). */
function regionOf(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) { if (!inRegion(w)) break; out.push(w); }
  return out;
}

const hasObject = (ws: string[]) => ws.some(w => PRONOUN_OBJ.has(w) || isMedNoun(w) || !!SLOT_WORD[w] || w === "both");
const hasDoseVocab = (ws: string[]) => ws.some(w => TAKE_VERB.has(w) || isMedNoun(w) || PRONOUN_OBJ.has(w));
const asksAboutMeds = (ws: string[]) => ws.some(w => TAKE_VERB.has(w) || isMedNoun(w));

function splitClauses(text: string): Clause[] {
  const parts = text.split(/(\?+|[.!;\n…]+|,|\bbut\b|\band\b)/);
  const out: Clause[] = [];
  let pending: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const after = parts[i + 1];
    const words = tokensOf(parts[i] ?? "");
    if (words.length) {
      const sep: Clause["sep"] = out.length === 0 ? "start"
        : pending.some(s => /[.!?;\n…]/.test(s)) ? "terminal"
        : pending.includes("but") ? "but" : "join";
      out.push({ words, sep, question: !!after && after.startsWith("?") });
      pending = [];
    } else if (out.length && after?.startsWith("?")) {
      out[out.length - 1]!.question = true;
    }
    if (after !== undefined) pending.push(after);
  }
  return out;
}

/** TAKEN by the opening-clause rules: a taking verb first; "took"/"take" need a dose object. */
function takenClause(c: Clause): SlotRef | "ambig" | null {
  const m = LEAD_RE.exec(c.words.join(" "));
  if (!m) return null;
  const lead = m[0];
  if (m[3] && !/\bdid\s+$/.test(lead.slice(0, lead.length - "take".length))) return null;
  const after = c.words.slice(lead.split(/\s+/).filter(Boolean).length);
  const region = regionOf(after);
  if (m[2] || m[3]) {
    if (after.length && !region.length) return null;                     // "took forever"
    if (region.some(w => !ENDEAR.has(w)) && !hasObject(region)) return null; // "took the dog out"
    // A bare pronoun going somewhere is not a dose ("I took them to the park", 2026-10-03).
    const pronounOnly = region.length > 0 && region.every(w => PRONOUN_OBJ.has(w) || ENDEAR.has(w));
    if (pronounOnly && PLACE_PREP.has(after[region.length] ?? "")) return null;
  }
  if (after.slice(0, 6).some(w => CLAUSE_NEGATE.has(w))) return "ambig";  // "took them yesterday", "taken aback"
  return slotsOf(region);
}

/** MISSED: an explicit past statement that a dose was not taken. */
function missedClause(c: Clause): SlotRef | null {
  const joined = c.words.join(" ");
  const m = MISS_RE.exec(joined);
  if (!m) return null;
  const rest = tokensOf(joined.slice(m[0].length));
  const region = regionOf(rest);
  if (rest.slice(region.length).some(w => !MISS_TAIL.has(w))) return null; // "I missed you", "forgot my keys"
  if (region.some(w => !ENDEAR.has(w)) && !hasObject(region)) return null;
  return slotsOf(region);
}

/**
 * Every word known, one affirmative, AND a dose word ("morning ones done", "yes both", "last
 * night's taken"). The dose word is what keeps "yes, and then we watched..." from reading its
 * first clause "yes" as an answer: a bare "yes" / "done" is only ever an answer when it is the
 * WHOLE message (the whitelist above, used as the fallback).
 */
function whitelistClause(words: string[]): boolean {
  if (!hasObject(words) && !words.some(w => TAKE_VERB.has(w))) return false;
  let affirm = false;
  for (const w of words) {
    if (NEGATE.has(w)) return false;
    if (AFFIRM.has(w) || /^ye+s+$/.test(w) || /^ye+p+$/.test(w)) { affirm = true; continue; }
    if (FILLER.has(w) || inRegion(w) || CLAUSE_EXTRA_FILLER.has(w)) continue;
    return false;
  }
  return affirm;
}

function classify(c: Clause, prev: Statement | null): Statement {
  const none: SlotRef = { named: new Set(), star: false };
  const w = c.words;
  if (c.question) return { kind: asksAboutMeds(w) ? "refuse" : "none", slots: none };
  if (DEFER_RE.test(w.join(" "))) {
    const relevant = hasDoseVocab(w) || w.every(x => DEFER_BARE.has(x));
    return { kind: relevant ? "defer" : "none", slots: slotsOf(w) };
  }
  const missed = missedClause(c);
  if (missed) return { kind: "missed", slots: missed };
  const joinedToStatement = (c.sep === "join" || c.sep === "but") && prev !== null;
  if (w[0] === "not") {
    const rest = w.slice(1);
    const s = slotsOf(rest);
    if (joinedToStatement && prev!.kind === "taken" && rest.every(x => inRegion(x)) && (s.named.size || s.star)) {
      return { kind: "neg", slots: s };
    }
    return { kind: joinedToStatement || hasDoseVocab(w) ? "ambig" : "none", slots: none };
  }
  const taken = takenClause(c);
  if (taken === "ambig") return { kind: "ambig", slots: none };
  if (taken) return { kind: "taken", slots: taken };
  if (whitelistClause(w)) return { kind: "taken", slots: slotsOf(w) };
  if (c.sep === "join" && prev && w.every(x => inRegion(x) || x === "as" || x === "well")) {
    const s = slotsOf(w);
    if (s.named.size || s.star) return { kind: "inherit", slots: s };
  }
  if (c.sep === "but" && prev && NEGATE.has(w[0]!)) return { kind: "ambig", slots: none };
  return { kind: "none", slots: none };
}

/**
 * Parse one DM into med-answer statements, or null when there is nothing to record. The rules are
 * in the block comment above; `isAffirmativeMedAnswer` (unchanged) stays the reaction path's test.
 */
const STRONG_BARE = new Set(["done", "taken", "did"]);
function strongBareSentence(words: string[]): boolean {
  return words.some(w => STRONG_BARE.has(w)) && isAffirmativeMedAnswer(words.join(" "));
}

export interface ParseMedAnswerOptions {
  /** Labels of the doses open right now (Halseth /mind/med/today). Their naming words count as dose
   *  nouns, so "I took my <label>" reads like "I took my pills". Optional: without it, unchanged. */
  labels?: readonly string[];
}

export function parseMedAnswer(raw: string | null | undefined, opts?: ParseMedAnswerOptions): ParsedMedAnswer | null {
  labelNouns = labelNounsOf(opts?.labels);
  try {
    return parseMedAnswerInner(raw);
  } finally {
    labelNouns = new Set();
  }
}

/** The whole-message whitelist with every label noun read as "meds" ("<label> done" is "meds done"). */
function wholeMessageAffirmative(raw: string): boolean {
  if (!labelNouns.size) return isAffirmativeMedAnswer(raw);
  const swapped = foldEmoji(raw).replace(/[\p{L}\p{N}']+/gu, w => (labelNouns.has(w.toLowerCase()) ? "meds" : w));
  return isAffirmativeMedAnswer(swapped);
}

// A LAST WORD "taken" (2026-10-06). "Yay!! I'm on top of it today Dre you don't even have to ask
// again taken!" recorded nothing and the follow-up fired: the answer came LAST, after a sentence
// whose "don't" and "again" sink every clause rule (rightly: they guard real negations). So: the
// message's final word, ignoring trailing endearments and punctuation, is "taken" ("done" only when
// a dose word is also in the message: "work is finally done!" is not an answer), the word before it
// is not one that turns it into a description or a negation ("not taken", "was taken", "get it
// taken", "haven't taken", "taken aback" never ends a message on "taken"), and nothing in the
// message asks, defers or states a miss. Only when no other rule found anything.
const TRAILING_SOFT = new Set([...ENDEAR, "lol", "haha", "hehe", "xx", "xo"]);
// Not NEGATE wholesale: it holds "again", which is exactly the word before "taken" in his message.
const BEFORE_FINAL_BLOCK = new Set([
  "no", "not", "never", "nope", "nah", "yet", "forgot", "skipped", "missed", "should", "will", "gonna",
  "maybe", "almost", "nearly", "need", "needs", "if", "or", "think",
  "be", "been", "being", "is", "was", "are", "were", "get", "got", "gets", "getting", "gotta",
  "it", "them", "it's", "its", "that's", "thats", "i'm", "im", "i've", "ive", "we're", "you're", "they're",
  "have", "has", "had", "so", "all", "finally", "now", "the", "seat", "place", "spot", "name", "username",
]);
function trailingTaken(text: string, clauses: Clause[]): boolean {
  if (text.includes("?") || clauses.some(c => c.question)) return false;
  if (DEFER_RE.test(text)) return false;
  const all = tokensOf(text);
  while (all.length && TRAILING_SOFT.has(all[all.length - 1]!)) all.pop();
  const last = all[all.length - 1];
  const before = all[all.length - 2];
  if (last !== "taken" && last !== "done") return false;
  if (last === "done" && !all.slice(0, -1).some(w => isMedNoun(w) || !!SLOT_WORD[w])) return false;
  if (before !== undefined && (BEFORE_FINAL_BLOCK.has(before) || /n'?t$/.test(before))) return false;
  if (clauses.some(c => MISS_RE.test(c.words.join(" ")))) return false;
  return true;
}

function parseMedAnswerInner(raw: string | null | undefined): ParsedMedAnswer | null {
  if (!raw) return null;
  const folded = foldEmoji(raw);
  if (!folded.trim() || folded.length > 400) return null;
  if (NEGATE_EMOJI.some(e => folded.includes(e))) return null;
  const text = folded.toLowerCase().replace(/[’`]/g, "'").replace(/&/g, " and ").trim();
  if (/\bexcept\b/.test(text)) return null;

  const statements: MedAnswerEntry[] = [];
  const deferred = new Set<MedNamedSlot>();
  let deferredUnnamed = false;
  let prev: Statement | null = null;
  const push = (slots: SlotRef, outcome: MedAnswerOutcome) => {
    if (slots.named.size) for (const n of slots.named) statements.push({ slot: n, outcome });
    else statements.push({ slot: slots.star ? "*" : null, outcome });
  };

  const clauses = splitClauses(text);
  for (const c of clauses) {
    const s = classify(c, prev);
    if (s.kind === "refuse" || s.kind === "ambig") return null;
    if (s.kind === "defer") {
      if (s.slots.named.size) for (const n of s.slots.named) deferred.add(n);
      else deferredUnnamed = true;
    }
    if (s.kind === "taken") push(s.slots, "taken");
    if (s.kind === "missed") push(s.slots, "missed");
    if (s.kind === "inherit") push(s.slots, prev!.kind === "missed" ? "missed" : "taken");
    if (s.kind === "neg") push(s.slots, "missed");
    // INHERIT and NEG carry an outcome forward ("took morning, and night, but not weekly").
    prev = s.kind === "none" || s.kind === "defer" ? null
      : s.kind === "inherit" ? { kind: prev!.kind, slots: s.slots }
      : s.kind === "neg" ? { kind: "missed", slots: s.slots }
      : s;
  }

  // Nothing any clause said: the whole-message whitelist (emoji-only "✅", "👍 done").
  if (statements.length === 0 && !deferredUnnamed && deferred.size === 0 && wholeMessageAffirmative(raw)) {
    push(slotsOf(tokensOf(text)), "taken");
  }
  // A FIRST SENTENCE that is a strong bare answer, then talk (2026-10-02). His 10-02 morning answer
  // "Done baby! This has really really been helping thank you lover" recorded nothing (and the
  // follow-up fired): a bare "done" counted only as the WHOLE message, because "yes, and then we
  // watched..." must not read as an answer. The difference is a full stop: here the first clause
  // ENDS a sentence (. ! newline) and holds only a strong word (done / taken / did; not "yes", too
  // generic) plus filler and endearments. A comma or "and" join still refuses; so does any later
  // clause that deferred, refused or was ambiguous (those returned above).
  if (statements.length === 0 && !deferredUnnamed && deferred.size === 0 && clauses.length > 1
      && clauses[1]!.sep === "terminal" && !clauses[0]!.question && strongBareSentence(clauses[0]!.words)) {
    push(slotsOf(clauses[0]!.words), "taken");
  }
  // MID-SENTENCE "I took my pills" (2026-10-03). His late morning answer was one long sentence:
  // "sorry got caught up in getting to the volleyball tournament ... I took my morning pills ...",
  // and the taking verb was nowhere near the start. Strict, because nothing anchors it: "I"
  // + took / have taken / 've taken, then a REAL dose word (pills, meds, my morning ones; never a
  // bare "them": "I took them to the park"), and no negating or hedging word anywhere before it in
  // the clause ("I don't think I took my pills" refuses). Only when no clause said anything else.
  if (statements.length === 0 && !deferredUnnamed && deferred.size === 0) {
    for (const c of clauses) {
      if (c.question) continue;
      const w = c.words;
      for (let i = 0; i < w.length - 1; i++) {
        if (w[i] !== "i" && w[i] !== "i've" && w[i] !== "ive") continue;
        let j = i + 1;
        while (j < w.length && (w[j] === "just" || w[j] === "already" || w[j] === "did" || w[j] === "have" || w[j] === "also")) j++;
        if (!(w[j] === "took" || w[j] === "taken" || (w[j] === "take" && w[j - 1] === "did"))) continue;
        const region = regionOf(w.slice(j + 1));
        const realDose = region.some(x => isMedNoun(x) || !!SLOT_WORD[x]);
        if (!realDose || w.slice(0, i).some(x => CLAUSE_NEGATE.has(x))) continue;
        push(slotsOf(region), "taken");
        break;
      }
      if (statements.length) break;
    }
  }
  if (statements.length === 0 && !deferredUnnamed && deferred.size === 0 && trailingTaken(text, clauses)) {
    push({ named: new Set(), star: false }, "taken");
  }
  if (statements.length === 0) return null;

  // A deferral without a slot could be about any dose: nothing is certain enough to record.
  if (deferredUnnamed) return null;
  const named = statements.filter(s => s.slot !== null && s.slot !== "*");
  const star = statements.filter(s => s.slot === "*");
  const unnamed = statements.filter(s => s.slot === null);
  // A named deferral beside an unnamed or "both" statement: the unnamed one may be that dose.
  if (deferred.size && (unnamed.length || star.length)) return null;

  const bySlot = new Map<MedNamedSlot, Set<MedAnswerOutcome>>();
  for (const s of named) {
    const slot = s.slot as MedNamedSlot;
    if (deferred.has(slot)) return null;                                // said and deferred: unclear
    const set = bySlot.get(slot) ?? new Set<MedAnswerOutcome>();
    set.add(s.outcome);
    bySlot.set(slot, set);
  }
  if ([...bySlot.values()].some(o => o.size > 1)) return null;           // one dose, both outcomes
  const starOutcomes = new Set(star.map(s => s.outcome));
  if (starOutcomes.size > 1) return null;
  const starOutcome = [...starOutcomes][0];
  if (starOutcome && [...bySlot.values()].some(o => !o.has(starOutcome))) return null;

  if (starOutcome) return { entries: [{ slot: "*", outcome: starOutcome }] };
  // Named statements are the precise ones; an unnamed word beside them is dropped, never guessed.
  if (bySlot.size) return { entries: [...bySlot].map(([slot, o]) => ({ slot, outcome: [...o][0]! })) };
  const outs = new Set(unnamed.map(s => s.outcome));
  return outs.size === 1 ? { entries: [{ slot: null, outcome: [...outs][0]! }] } : null;
}
