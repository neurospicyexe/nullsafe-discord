// low-info.ts -- deterministic "pure acknowledgement" classifier for the WRITE side (2026-11-01,
// Halseth task 538ab03b item 2). It decides ONE thing: whether an exchange is too empty to be worth
// a writeback judge call. It never touches what the bots say or whether they reply.
//
// CONSERVATIVE BY CONSTRUCTION (Raziel's standing rule: chatter is WANTED). A line is low-info only
// if EVERY token is on a closed allowlist of acknowledgement words, it is at most 6 words, and it has
// no digit, no question mark and no name. Anything else (a name, a feeling word, a number, a question,
// a longer line, any word not on the list) is KEPT. Emoji-only lines are low-info except affection or
// distress emoji. An empty line is never low-info (an attachment-only turn still gets judged).
//
// WRITEBACK_LOWINFO = off | shadow | on, CODE DEFAULT shadow. Shadow logs, on skips the judge.

export type LowInfoMode = "off" | "shadow" | "on";

export function writebackLowInfoMode(env: Record<string, string | undefined> = process.env): LowInfoMode {
  const v = (env["WRITEBACK_LOWINFO"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "on") return "on";
  return "shadow";
}

const MAX_WORDS = 6;

/** Closed vocabulary: acknowledgements, laughter, agreement, thanks. No names, no feelings, no nouns. */
const ACK_WORDS = new Set([
  "ok", "okay", "okey", "k", "kk", "okie", "cool", "kay", "alright", "aight", "sure", "right",
  "thanks", "thank", "you", "thx", "ty", "tysm", "tyvm", "thanx", "np", "yw",
  "lol", "lmao", "lmfao", "rofl", "haha", "hahaha", "hehe", "heh", "ha", "hah",
  "yeah", "yea", "yep", "yup", "yes", "ya", "uhhuh", "mhm", "mhmm", "mm", "mmm", "mmhm", "hm", "hmm", "hmmm",
  "uh", "huh", "ah", "oh", "ooh", "aha",
  "nice", "good", "great", "awesome", "sweet", "fair", "true", "same", "word", "gotcha", "got", "it", "noted",
  "makes", "sense", "ofc", "of", "course", "for", "real", "so", "very", "much", "a", "lot", "the", "that",
  "is", "was", "bet",
]);

/** Emoji we never drop: affection, distress, care. A lone heart is a feeling, not a filler. */
const KEEP_EMOJI = /[❤\u{1F493}-\u{1F49F}\u{1F90D}-\u{1F90E}\u{1F970}\u{1F60D}\u{1F618}\u{1F62D}\u{1F622}\u{1F625}\u{1F61E}\u{1F614}\u{1FAC2}\u{1F494}\u{1F63F}\u{1F97A}\u{1F198}]/u;

export function isLowInfo(text: string | null | undefined): boolean {
  try {
    const raw = (text ?? "").trim();
    if (!raw) return false;
    if (/\d/.test(raw) || raw.includes("?") || /[<>@#]|https?:|\n.*\n/.test(raw)) return false;
    const letters = raw.replace(/[^\p{L}\p{M}'’\s]/gu, " ");
    const hasLetters = /\p{L}/u.test(letters);
    if (!hasLetters) {
      // Emoji / punctuation only. Require at least one emoji-ish symbol, short, and no keep-emoji.
      if (raw.length > 24) return false;
      if (KEEP_EMOJI.test(raw)) return false;
      return /\p{Extended_Pictographic}/u.test(raw);
    }
    const words = letters.toLowerCase().split(/\s+/).map(w => w.replace(/['’]/g, "")).filter(Boolean);
    if (words.length === 0 || words.length > MAX_WORDS) return false;
    if (KEEP_EMOJI.test(raw)) return false;
    // Collapse stretched words: "okkkk" -> "ok", "yesss" -> "yes", "loool" -> "lol".
    const squash = (w: string) => w.replace(/(.)\1{2,}/gu, "$1$1").replace(/(.)\1+$/u, "$1");
    return words.every(w => ACK_WORDS.has(w) || ACK_WORDS.has(squash(w)) || ACK_WORDS.has(w.replace(/(.)\1+/gu, "$1")));
  } catch {
    return false;
  }
}

/** True only when BOTH sides of the exchange are low-info. */
export function exchangeIsLowInfo(humanLine: string, reply: string): boolean {
  return isLowInfo(humanLine) && isLowInfo(reply);
}
