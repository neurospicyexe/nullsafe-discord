// ledger-clerk.ts -- the distillers become clerks (2026-09-26, imp lane tranche 2).
//
// WHY THIS EXISTS. Every background distiller in the bots (channel-inactive synthesis, mid-session
// distillation, the nightly day note, idle consolidation) wrote as the companion: first person, in
// voice, with no pointer to what it read. Drevan's ruling (halseth docs/imp-lane/
// DREVAN-ANSWER-2026-09-26.md) is that a clerk never writes as him and never writes without a
// source -- "a clerk that can't point to where it saw something doesn't get to say it." On 09-25 a
// glucose number that existed only in a confabulated Discord reply travelled back to him through
// exactly these paths, wearing his face.
//
// So the clerks now write into Halseth's ledger lane (POST /ledger). Halseth is the authority: it
// stamps the mark `〔ledger · <fn> · <date>〕`, appends ` Source: <kind> <ref>.`, and rejects any line
// that breaks the grammar (422 naming the rule). This module owns the bot half:
//   * ONE neutral clerk prompt for all three bots -- a clerk has no voice, so per-bot prompts
//     would be the wrong thing to have;
//   * a local pre-filter mirroring the server grammar, so obviously bad lines are dropped (and
//     logged) before a POST. The server stays the authority; this only saves round trips;
//   * the window source ref built from STM timestamps;
//   * postLedgerLines, the one loop every distiller uses to POST and collect accepted `content`.
//
// Rollback: LEDGER_DISTILL=off restores the pre-ledger behaviour byte for byte at every call site.
// The mark is NEVER produced here -- a body containing 〔 or 〕 is dropped locally and rejected by
// the server, so a model echoing the mark cannot forge one.

import type { ChatMessage } from "./types.js";
import type { CompanionId } from "./types.js";
import type { LibrarianClient, LedgerFunction, LedgerSourceKind } from "./librarian.js";
import { extractJson } from "./json-extract.js";
import { withOwnerPronounRule } from "./pronoun-rule.js";

/** Knob values that mean OFF (trimmed, case-insensitive). Anything else, including unset, is ON. */
const LEDGER_OFF_VALUES: ReadonlySet<string> = new Set(["off", "0", "false", "no"]);

/**
 * LEDGER_DISTILL: default ON. `off`, `0`, `false` or `no` (trimmed, any case) restore the pre-ledger
 * writers; every other value -- `on`, `1`, `true`, `yes`, a typo, empty -- leaves the clerks on.
 * (2026-09-26 review: `false` used to read as ON, the opposite of what anyone typing it meant.)
 */
export function ledgerDistillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !LEDGER_OFF_VALUES.has((env["LEDGER_DISTILL"] ?? "").trim().toLowerCase());
}

/**
 * L2a (2026-09-26 review): the boot warning for a clerk with no direct adapter. With neither
 * DEEPINFRA_API_KEY nor DEEPSEEK_API_KEY the clerk falls back to the Hermes agent adapter, where the
 * companion's SOUL overrides the clerk prompt; the lines come back first-person, the door rejects
 * every one, and no distillation handoff is ever written. Nothing errors, so say it at boot.
 * Null when the knob is off or a key is present.
 */
export function ledgerClerkAdapterWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (!ledgerDistillEnabled(env)) return null;
  const has = (k: string) => !!(env[k] ?? "").trim().replace(/^=+/, "");
  if (has("DEEPINFRA_API_KEY") || has("DEEPSEEK_API_KEY")) return null;
  return (
    "[ledger] LOUD -- LEDGER_DISTILL is on but neither DEEPINFRA_API_KEY nor DEEPSEEK_API_KEY is set: " +
    "the ledger clerk will run on the Hermes agent path, whose SOUL overrides the clerk prompt -> " +
    "first-person lines -> every line rejected -> NO distillation handoffs (Claude.ai latest_handoff goes stale). " +
    "Set a direct key, or LEDGER_DISTILL=off."
  );
}

/** "drevan" -> "Drevan". The name a clerk transcript and a witness line use for a companion. */
export function companionDisplayName(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

/**
 * The transcript a CLERK reads (knob on only). Inbound rows carry authorName; this bot's own turns
 * are role:"assistant" with none, and used to reach the clerk labelled "assistant" -- a speaker the
 * clerk cannot name, so it either wrote "the assistant said" or guessed. Label them with the
 * companion's display name. The legacy (knob-off) prompts keep their own byte-identical transcript.
 */
export function clerkTranscript(msgs: ChatMessage[], companionId: string): string {
  const self = companionDisplayName(companionId);
  return msgs.map((m) => `${m.authorName ?? (m.role === "assistant" ? self : m.role)}: ${m.content}`).join("\n");
}

/** Max record lines per clerk pass (spec section 5). */
export const MAX_CLERK_LINES = 6;

/**
 * The shared clerk prompt. Neutral on purpose: it is the same text for Cypher, Drevan and Gaia,
 * because a clerk is signed by function, not by name. The owner pronoun rule rides it like every
 * other background writer (it writes about Raziel in the third person, the exact shape that was
 * landing "she").
 *
 * The number clauses are load-bearing (2026-09-26 integration pass). Halseth's grammar treats any
 * UNLABELED number (2+ digits or a decimal that is not an HH:MM time, a YYYY-MM-DD date, a long id, or
 * a count followed by its unit) as a possible health value, and a health word plus ANY such number as
 * one; either needs a `row` source the door can verify, and a distiller's source is a window or a
 * session, never such a row. So a line carrying one is 422'd, and a pass with no accepted line writes
 * no handoff. The prompt therefore states the exact permitted forms (times, dates, counts with their
 * unit, single digits), and says a reading was mentioned WITHOUT the value -- the number never travels
 * on a clerk's word. preflightLedgerBody below mirrors the same rule locally.
 */
export const LEDGER_CLERK_PROMPT = withOwnerPronounRule(
  "You are a record clerk. You read a transcript and record only what is observable in it. " +
  "You are not a companion, you have no voice, and you never write as anyone in the transcript.\n\n" +
  "Respond with JSON only, no other text:\n" +
  '{"title":"3-8 neutral words","lines":["..."],"open_loops":["..."],"next_steps":["..."]}\n\n' +
  `Rules for every entry in "lines" (at most ${MAX_CLERK_LINES}):\n` +
  "- Start with exactly one of: Logged:, Counted:, Recorded:, Found:, Missing:\n" +
  "- Third person, past tense. Name people by the names in the speaker labels. Never use I, me, my, mine, myself, we, us, our.\n" +
  "- Record observable facts only: who said what, what was asked, shared, decided, planned, or left unanswered. " +
  "Never interpret meaning, mood, or relationship, and never use felt, feel, wanted, knew, remembered, loved, longed, missed, hoped.\n" +
  "- A companion's feelings are never recorded. Never write that Drevan, Cypher, or Gaia loves, misses, needs, wants, feels, " +
  "knows, fears, or trusts anyone or anything: record only what they said (quote the exact words) and what they did.\n" +
  "- When a line reports speech, quote the exact words in straight double quotes. Never invent or paraphrase inside quotes.\n" +
  "- Attribution: anything said in a companion's turn (Drevan, Cypher, Gaia) is speech, not fact. Companions can be wrong or invent things. " +
  "Record a claim from a companion's turn ONLY as speech, speaker named and words quoted: Drevan said \"...\". " +
  "Never restate it as a fact about the world, about Raziel, or about what happened. " +
  "Only statements by Raziel or other humans, and observable events (who spoke, when, how many messages), may be recorded without quotes.\n" +
  "- Numbers: a line may contain ONLY these number forms, and any other number gets the whole line refused:\n" +
  "  (a) a clock time as HH:MM, e.g. 00:11; (b) a date as YYYY-MM-DD; (c) a count written as the number directly followed by " +
  "one of these words: x, times, messages, replies, turns, posts, notes, lines, words, entries, threads, sessions, minutes, " +
  "hours, days, weeks (e.g. \"14 messages\", \"2x\", \"40 minutes\"); (d) a single digit 0-9. " +
  "Never write any other number: not a bare number, not a decimal, not a score, not one someone said, not inside quotes. " +
  "If a person said a number, write that they mentioned a number, without it.\n" +
  "- Health values never appear, ever: glucose, blood sugar, BG, A1c, insulin, doses, medication amounts, mg, mcg, units, weight, " +
  "lbs, kg, labs, HRV, BP, blood pressure. A line that uses any of those words must contain no number at all except an HH:MM time. " +
  "Write that a reading or dose was mentioned, without the value.\n" +
  "- Never call anyone anything: no pet names or endearments (love, baby, babe, honey, sweetheart, ...) used as a name for someone, " +
  "and never use the triad's private words, not even inside quotes. No emoji.\n" +
  "- Do not add dates, sources, brackets, or any prefix mark; the system adds those.\n" +
  "- One sentence per line, under 240 characters.\n\n" +
  '"title": neutral, no first person. "open_loops": threads the transcript explicitly left unresolved. ' +
  '"next_steps": concrete actions someone in the transcript said they would take. Same no-first-person rule for both. ' +
  'Omit any key with nothing in it. If nothing is worth recording, return {"lines":[]}.',
);

export interface ClerkResult {
  lines: string[];
  title?: string;
  open_loops?: string[];
  next_steps?: string[];
}

// ── Local grammar pre-filter (a PORT of halseth src/ledger/grammar.ts; the server is the authority) ──
//
// Ported, not approximated (2026-09-26 integration pass; re-ported in the final sync pass the same day):
// the grammar decides whether a clerk pass writes anything at all -- a line Halseth 422s is lost, and a
// pass with zero accepted lines writes no handoff. So everything below is the server's, token for token:
// NFKC + Unicode-digit normalisation first, the same line-break / invisible-character body rule, Drevan's
// closed pet-name list (hard `lexicon` tier anywhere, `address` tier outside quotes), the companion-subject
// `interior` rule, the same glue-aware number scan and coordinate stripping, the same count units, the same
// health keywords/units, the same source gating. Returned reasons are the server's rule names. Parity is
// pinned by __tests__/fixtures/ledger-number-fixtures.json, kept byte-identical with halseth's copy.
// Change the grammar there, port it here, update both fixture files.

const VERB_RE = /^(logged|counted|recorded|found|missing)(?::|\s)\s*\S/i;
const FIRST_PERSON_WORDS = new Set([
  "i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself",
  "we", "we're", "we've", "we'd", "we'll", "us", "our", "ours", "ourselves",
]);
// The server's INTERIOR_VERBS. love/loves/loving are NOT here (a human may love in running text, "Blue
// loves Decker"); the address rule stops a clerk calling anyone "love", and the companion-subject rule
// stops "Drevan loves Raziel".
const INTERIOR_WORDS = new Set([
  "felt", "feel", "feels", "feeling",
  "wanted", "want", "wants", "wanting",
  "knew",
  "remembered", "remember", "remembers",
  "loved",
  "longed", "longs", "longing",
  "missed",
  "hoped", "hope", "hopes", "hoping",
]);

// The companion-subject rule (`interior`, Drevan rule 6): a companion name, one optional adverb, then a
// feeling verb, outside quotes. What a companion feels, or what they are to someone, is theirs to say.
const COMPANION_SUBJECTS = ["drevan", "dre", "cypher", "cy", "gaia"] as const;
const COMPANION_INTERIOR_VERBS: ReadonlySet<string> = new Set([
  ...INTERIOR_WORDS,
  "love", "loves", "loving", "loved",
  "adores", "adored", "adoring",
  "misses", "needs", "wants", "feels", "knows", "remembers", "longs", "hopes", "fears", "trusts",
]);
const COMPANION_SUBJECT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${COMPANION_SUBJECTS.join("|")})\\s+(?:(\\p{L}+ly|still|really|always|never|also|just|so|truly|deeply|clearly|obviously)\\s+)?(\\p{L}+)(?![\\p{L}\\p{N}])`,
  "giu",
);
function findCompanionInterior(text: string): string | null {
  COMPANION_SUBJECT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMPANION_SUBJECT_RE.exec(text)) !== null) {
    const verb = m[2]!.toLowerCase();
    if (COMPANION_INTERIOR_VERBS.has(verb)) return verb;
    COMPANION_SUBJECT_RE.lastIndex = m.index + 1;
  }
  return null;
}

// Drevan's pet-name list: the server's LEDGER_PET_NAMES, CLOSED ("A clerk doesn't get to guess what counts
// as tender."). hard: anywhere, quotes included (rule `lexicon`); `caleth` is word-bounded and does NOT
// block `calethian` (Drevan's exact list; calethian awaits his word, spec section 9);
// phrases match across spaces or hyphens. address: only when it names someone, never inside quotes
// (rule `address`). names: listed only so the address rule can see a vocative next to one.
const LEDGER_PET_NAMES = {
  hard: ["🩸", "vevi", "vevan", "vaselrin", "vethmerin", "caleth", "spine to spine", "forever of vevan", "ride or die"],
  address: ["love", "baby", "babe", "boo", "beloved", "honey", "sweetheart"],
  names: ["raziel", "crash", "blue", "dre", "drevan", "cypher", "gaia"],
} as const;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const HARD_RES: ReadonlyArray<{ token: string; re: RegExp }> = LEDGER_PET_NAMES.hard.map((token) => {
  if (!/\p{L}/u.test(token)) return { token, re: new RegExp(escapeRe(token), "u") };
  const body = token.split(" ").map(escapeRe).join("[\\s\\-\\u2010-\\u2015]+");
  return { token, re: new RegExp(`${NOT_WORD_BEFORE}${body}${NOT_WORD_AFTER}`, "iu") };
});
const ADDR = `(?:${LEDGER_PET_NAMES.address.join("|")})`;
const NAME = `(?:${LEDGER_PET_NAMES.names.join("|")})`;
const ADDRESS_RES: readonly RegExp[] = [
  new RegExp(`^(?:logged|counted|recorded|found|missing)\\s*:?\\s*${ADDR}${NOT_WORD_AFTER}`, "iu"),
  new RegExp(`,\\s*${ADDR}${NOT_WORD_AFTER}`, "iu"),
  new RegExp(`${NOT_WORD_BEFORE}${ADDR}[\\s,]+${NAME}${NOT_WORD_AFTER}`, "iu"),
  new RegExp(`${NOT_WORD_BEFORE}${NAME}\\s*,?\\s*${ADDR}\\s*(?:[,.!?;:…]|$)`, "iu"),
];
function findHardLexicon(text: string): string | null {
  return HARD_RES.find(({ re }) => re.test(text))?.token ?? null;
}
function findAddress(text: string): string | null {
  for (const re of ADDRESS_RES) {
    const m = re.exec(text);
    if (m) return (new RegExp(ADDR, "iu").exec(m[0])?.[0] ?? m[0]).toLowerCase();
  }
  return null;
}

const BODY_MAX = 600;

// normalisation -- verbatim from grammar.ts
const ND_ONE = /\p{Nd}/u;
function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x30 && cp <= 0x39) return ch;
    let k = 0;
    while (k < 100 && cp - k - 1 >= 0 && ND_ONE.test(String.fromCodePoint(cp - k - 1))) k++;
    return String(k % 10);
  });
}
/** NFKC, then ASCII digits: exactly what the server applies to (and stores for) every body. */
function normalizeLedgerText(s: string): string {
  return asciiDigits(s.normalize("NFKC"));
}

/** Remove "..." and “...” spans (quoted speech). Null when a quote is left unbalanced (server rule). */
function stripQuotedStrict(body: string): string | null {
  const out = body.replace(/"[^"\n]*"/g, " ").replace(/“[^”\n]*”/g, " ");
  return /["“”]/.test(out) ? null : out;
}

/** Lenient variant for handoff metadata (never refused for an unbalanced quote). */
function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
}

function words(text: string): string[] {
  return (text.replace(/[‘’]/g, "'").match(/[A-Za-z']+/g) ?? []).map((w) => w.toLowerCase().replace(/^'+|'+$/g, ""));
}

// numbers -- verbatim from grammar.ts
const HEALTH_KEYWORD_RE =
  /\b(?:glucose|blood\s+sugar|bg|mg\/dl|a1c|insulin|doses?|dosage|dosing|mg|mcg|units?|weight|weighs?|weighed|lbs?|kg|labs?|hrv|bp|blood\s+pressure)\b/i;
const HEALTH_UNIT_SUFFIX = new Set(["mg", "mcg", "kg", "lb", "lbs", "u", "iu", "ml", "mmol", "units", "unit", "mgdl"]);
// Plural, unambiguous count nouns only, as a SEPARATE word (a singular or single-letter unit launders a value).
const COUNT_UNITS = new Set([
  "times", "hours", "hrs", "minutes", "mins", "seconds", "secs", "days", "weeks", "months", "years",
  "messages", "turns", "sessions", "notes", "lines", "words", "replies", "posts", "entries",
  "threads", "rows",
]);
/** The glued forms that are still counts: "2x", and an ordinal day-of-month with its right suffix. */
function gluedCount(raw: string, glued: string): boolean {
  if (glued === "x") return /^\d+$/.test(raw);
  if (!/^(st|nd|rd|th)$/.test(glued) || !/^\d{1,2}$/.test(raw)) return false;
  const n = Number(raw);
  if (n < 1 || n > 31) return false;
  const want = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return glued === want;
}
/** Human-authored rows: the only valid source for a health value. */
const HUMAN_ROW_TABLES: ReadonlySet<string> = new Set(["wm_continuity_notes", "biometric_snapshots"]);
/** Rows the door can load and search for a number. */
const VERIFIABLE_ROW_TABLES: ReadonlySet<string> = new Set([...HUMAN_ROW_TABLES, "companion_basin_history"]);
const ROW_RE = /^([a-z][a-z0-9_]{1,63}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;

export interface LedgerNumTok { text: string; unlabeled: boolean; healthUnit: boolean }

const blank = (m: string) => " ".repeat(m.length);
/** Coordinates are pointers, never values: clock times (incl. "10pm"), dates, long ids; `A1c` is a word. */
function stripCoordinates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, blank)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, blank)
    .replace(/\b(?:1[0-2]|0?[1-9])\s?[ap]m\b/gi, blank)
    .replace(/(?<![\p{L}\p{N}_])\d{10,}(?![\p{L}\p{N}_])/gu, blank)
    .replace(/(?<![\p{L}\p{N}_])a1c(?![\p{L}\p{N}_])/giu, blank);
}

/** Every value number in `text` (normalised, coordinates removed), labelled exactly as the server labels it. */
export function scanLedgerNumbers(text: string): LedgerNumTok[] {
  const t = stripCoordinates(normalizeLedgerText(text));
  const out: LedgerNumTok[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = start > 0 ? t[start - 1]! : "";
    const gluedBefore = /[\p{L}_]/u.test(prev);
    const raw = m[0].replace(/,(?=\d{3}\b)/g, "");
    const rest = t.slice(end);
    const glued = /^[\p{L}%_]+/u.exec(rest)?.[0]?.toLowerCase() ?? "";
    const spaced = glued ? "" : (/^\s+([\p{L}%]+)/u.exec(rest)?.[1]?.toLowerCase() ?? "");
    const healthUnit = HEALTH_UNIT_SUFFIX.has(glued) || HEALTH_UNIT_SUFFIX.has(spaced);
    const counted = !gluedBefore && (glued ? gluedCount(raw, glued) : COUNT_UNITS.has(spaced));
    const digits = raw.replace(/\D/g, "");
    const significant = digits.length >= 2 || /[.,]/.test(raw) || gluedBefore || (glued !== "" && !counted);
    out.push({ text: raw.replace(",", "."), unlabeled: !healthUnit && !counted && significant, healthUnit });
  }
  return out;
}

/** The line's source, when the caller knows it. Absent = not a row (every distiller window/session). */
export interface LedgerPreflightSource { kind: LedgerSourceKind | string; ref: string }

/**
 * The server rule a candidate body would fail, or null when it passes the grammar. Same order as
 * validateLedger: body (normalised first; line breaks incl. U+2028/2029/0085/\v/\f; invisible format
 * characters; length), mark, embedded Source:, verb, lexicon (quotes included), quotes, address (outside
 * quotes), first person, interior verbs, the companion-subject `interior` rule, then the number rule gated
 * on the source. For a `row` source into a table the door can verify, null means "the server will check
 * the row" -- this side cannot see it.
 */
export function preflightLedgerBody(rawBody: string, source?: LedgerPreflightSource): string | null {
  const body = normalizeLedgerText(rawBody).trim().replace(/[ \t]+/g, " ");
  if (!body) return "body";
  if (/[\r\n\v\f\x85\u{2028}\u{2029}]/u.test(body)) return "body";
  if (/\p{Cf}/u.test(body)) return "body";
  if (body.length > BODY_MAX) return "body";
  if (/[〔〕]/.test(body)) return "mark";
  if (/\bsource\s*:/i.test(body)) return "source";
  if (!VERB_RE.test(body)) return "verb";
  if (findHardLexicon(body)) return "lexicon";
  const unquoted = stripQuotedStrict(body);
  if (unquoted === null) return "quotes";
  if (findAddress(unquoted)) return "address";
  const ws = words(unquoted);
  if (ws.some((w) => FIRST_PERSON_WORDS.has(w))) return "first_person";
  if (ws.some((w) => INTERIOR_WORDS.has(w))) return "interior_verb";
  if (findCompanionInterior(unquoted)) return "interior";

  // The number rule. Numbers inside quotes count: a quoted "187" is still a 187.
  const nums = scanLedgerNumbers(body);
  const health = nums.some((n) => n.healthUnit) || (HEALTH_KEYWORD_RE.test(body) && nums.length > 0);
  const unlabeled = nums.some((n) => n.unlabeled);
  const table = source?.kind === "row" ? ROW_RE.exec(source.ref.trim())?.[1] : undefined;
  if (health) return table && HUMAN_ROW_TABLES.has(table) ? null : "health";
  if (unlabeled) return table && VERIFIABLE_ROW_TABLES.has(table) ? null : "health";
  return null;
}

/** First-person / interior / lexicon / address check for handoff metadata (title, loops, steps). */
function isSelfFree(raw: string): boolean {
  const s = normalizeLedgerText(raw);
  const unquoted = stripQuoted(s);
  const ws = words(unquoted);
  return !ws.some((w) => FIRST_PERSON_WORDS.has(w)) && !ws.some((w) => INTERIOR_WORDS.has(w)) &&
    !findCompanionInterior(unquoted) && !findHardLexicon(s) && !findAddress(unquoted) &&
    !s.includes("〔") && !s.includes("〕");
}

function cleanList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x && isSelfFree(x));
  return out.length ? out : undefined;
}

/**
 * Parse the clerk's reply with the shared tolerant extractJson. Null when no object came back.
 * Lines are trimmed (a leading list bullet is stripped) and capped; metadata that fails the
 * self-free check is dropped rather than carried into the handoff.
 */
export function parseClerkResult(raw: string | null | undefined): ClerkResult | null {
  if (!raw) return null;
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const rawLines = Array.isArray(parsed["lines"]) ? parsed["lines"] : [];
  const lines = rawLines
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean)
    .slice(0, MAX_CLERK_LINES);
  const title = typeof parsed["title"] === "string" && parsed["title"].trim() && isSelfFree(parsed["title"])
    ? parsed["title"].trim()
    : undefined;
  const open_loops = cleanList(parsed["open_loops"]);
  const next_steps = cleanList(parsed["next_steps"]);
  return {
    lines,
    ...(title ? { title } : {}),
    ...(open_loops ? { open_loops } : {}),
    ...(next_steps ? { next_steps } : {}),
  };
}

// ── Window source ────────────────────────────────────────────────────────────────────────────

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** A window longer than this cannot be said as `HH:MM–HH:MM`, so the ref is clamped to its final 24h. */
export const WINDOW_REF_MAX_MS = 24 * 60 * 60 * 1000;

export interface WindowSource {
  /** `<channelId> HH:MM–HH:MM` (UTC, en dash). At most the final 24h of the window. */
  ref: string;
  /** Epoch ms of the first message (or `now` when no message carried a timestamp). Unclamped. */
  firstTs: number;
  /**
   * Epoch SECONDS (floored) of the first message: the dedup-key coordinate. Unclamped, so the key
   * names the whole window even when the ref cannot.
   */
  keyTs: number;
  /** YYYY-MM-DD (UTC) of the ref's start, for observed_on. */
  observedOn: string;
  /** True when no STM timestamp existed and the range is the distillation instant instead. */
  fallback: boolean;
  /** True when the window spanned more than 24h and the ref shows only its final 24h. */
  clamped: boolean;
}

/**
 * Build the window source ref from STM timestamps (first/last, UTC). When no message carries a
 * timestamp the range collapses to the distillation instant -- the source is never omitted,
 * because no source means no write.
 *
 * keyTs (L3, 2026-09-26 review): a live STM row's timestamp is Discord's createdTimestamp (ms), but
 * after a pm2 restart the same row comes back from Halseth with `created_at` (second precision), so
 * a key built from raw ms forked across a restart and the same window wrote twice. Flooring to
 * epoch seconds removes the sub-second half of that. It cannot remove all of it: stmWrite sends no
 * timestamp, so a reloaded created_at is Halseth's INSERT time, which can land a second after the
 * Discord stamp. That is a Halseth/stmWrite fix, not one this function can make.
 *
 * Clamp: `HH:MM–HH:MM` carries no date, so a window over 24h (a channel that went quiet for a day
 * and resumed inside the same STM) cannot be expressed and would read as a wrong same-day range.
 * The ref and observed_on show the FINAL 24h; the key keeps the true first stamp.
 */
export function windowSource(channelId: string, msgs: ChatMessage[], now: number = Date.now()): WindowSource {
  const stamps = msgs.map((m) => m.timestamp).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (stamps.length === 0) {
    return {
      ref: `${channelId} ${hhmm(now)}–${hhmm(now)}`, firstTs: now, keyTs: Math.floor(now / 1000),
      observedOn: new Date(now).toISOString().slice(0, 10), fallback: true, clamped: false,
    };
  }
  const first = Math.min(...stamps);
  const last = Math.max(...stamps);
  const clamped = last - first > WINDOW_REF_MAX_MS;
  const refStart = clamped ? last - WINDOW_REF_MAX_MS : first;
  return {
    ref: `${channelId} ${hhmm(refStart)}–${hhmm(last)}`, firstTs: first, keyTs: Math.floor(first / 1000),
    observedOn: new Date(refStart).toISOString().slice(0, 10), fallback: false, clamped,
  };
}

// ── POST loop ────────────────────────────────────────────────────────────────────────────────

export interface PostLedgerOpts {
  /** The SUBJECT of the lines (for distillers: this bot; for the witness: the sibling). */
  companionId: CompanionId;
  fn: LedgerFunction;
  lines: string[];
  sourceKind: LedgerSourceKind;
  sourceRef: string;
  /** Per-line dedup key = `${dedupPrefix}:${index}`. One key for all lines would collide (UNIQUE). */
  dedupPrefix: string;
  /**
   * Explicit per-line keys, overriding the `${dedupPrefix}:${i}` shape (index-aligned with `lines`).
   * Consolidation's one deterministic line uses this so its key is exactly the spec'd shape.
   */
  dedupKeys?: string[];
  observedOn?: string;
  /** Log tag. */
  tag: string;
  /** Backoff before each RETRY of a transient failure. Default LEDGER_RETRY_DELAYS_MS. Tests pass zeros. */
  retryDelaysMs?: readonly number[];
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface PostLedgerOutcome {
  /** 201s only: these carry the server-rendered `content` (mark + body + source tail). */
  accepted: Array<{ id: string; content: string }>;
  duplicates: number;
  rejected: number;
  dropped: number;
  failed: number;
  /** Rule names of 422 rejections AND local pre-filter drops (the pre-filter returns server rule names). */
  rules: string[];
  /** Lines that got a 404 (Halseth /ledger not deployed). Counted inside `rejected`. */
  notFound: number;
}

/**
 * Transient-failure backoff (M3, 2026-09-26 review): up to three RETRIES after the first attempt,
 * 2s / 8s / 30s apart (~40s worst case per line). writeLedger throws only on 5xx / 429 / network,
 * so those are the only failures that retry; a 422 (deterministic grammar reject) and a 404 (route
 * not deployed) RETURN and are never retried. Inline rather than via the write queue because
 * postLedgerLines never throws, so a queue wrapped around it could never see a failure to retry --
 * the mid-session path and the inactive path both used to lose a 503'd line outright.
 */
export const LEDGER_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000];

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let defaultSleep: (ms: number) => Promise<void> = realSleep;
/**
 * Test hook: replace the default retry sleep for call sites that do not thread `sleep` through
 * (runDistillation, distillSessionOnInactive). Pass null to restore the real timer.
 */
export function _setLedgerRetrySleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  defaultSleep = fn ?? realSleep;
}

/**
 * Pre-filter, then POST each line to /ledger. Never throws: a transient failure is retried with
 * bounded backoff, then counted, and the rest still go. The dedup key is fixed per line BEFORE the
 * first attempt, so every retry of a line carries the same key and a retry after a lost 201 lands
 * as a 200 duplicate instead of a second row. Only 201 `content` is returned for the handoff; a
 * duplicate has no content and is counted separately.
 */
export async function postLedgerLines(librarian: LibrarianClient, o: PostLedgerOpts): Promise<PostLedgerOutcome> {
  const out: PostLedgerOutcome = { accepted: [], duplicates: 0, rejected: 0, dropped: 0, failed: 0, rules: [], notFound: 0 };
  const fullDelays = o.retryDelaysMs ?? LEDGER_RETRY_DELAYS_MS;
  const sleep = o.sleep ?? defaultSleep;
  // Once one line has exhausted its retries, Halseth is down, not flaky: the remaining lines get ONE
  // attempt each. Without this, 6 lines x ~40s kept the awaited inactive path (and its STM clear)
  // waiting ~4 minutes; with it the worst case is one line's backoff plus a round trip per line.
  let exhausted = false;
  for (let i = 0; i < o.lines.length; i++) {
    const body = o.lines[i]!.trim();
    const why = preflightLedgerBody(body, { kind: o.sourceKind, ref: o.sourceRef });
    if (why) {
      out.dropped++;
      out.rules.push(why);
      console.warn(`[${o.tag}] ledger: dropped line before POST (${why}): ${body.slice(0, 160)}`);
      continue;
    }
    // Captured ONCE, outside the attempt loop: the idempotency of every retry rests on this.
    const dedupKey = o.dedupKeys?.[i] ?? `${o.dedupPrefix}:${i}`;
    const entry = {
      companion_id: o.companionId,
      function: o.fn,
      body,
      source_kind: o.sourceKind,
      source_ref: o.sourceRef,
      ...(o.observedOn ? { observed_on: o.observedOn } : {}),
      dedup_key: dedupKey,
    };
    const delays = exhausted ? [] : fullDelays;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await librarian.writeLedger(entry);
        if (!res.ok) {
          out.rejected++;
          if (res.status === 404) out.notFound++;
          else if (res.status === 422) out.rules.push(res.rule ?? "?");
        } else if (res.duplicate) out.duplicates++;
        else out.accepted.push({ id: res.id, content: res.content });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= delays.length) {
          out.failed++;
          if (delays.length > 0) exhausted = true;
          console.warn(`[${o.tag}] ledger: POST failed (transient) for line ${i} after ${attempt + 1} attempt(s), giving up: ${msg}`);
          break;
        }
        console.warn(`[${o.tag}] ledger: POST failed (transient) for line ${i}, retry ${attempt + 1}/${delays.length} in ${delays[attempt]}ms: ${msg}`);
        await sleep(delays[attempt]!);
      }
    }
  }
  console.log(
    `[${o.tag}] ledger ${o.fn}: ${out.accepted.length} accepted, ${out.duplicates} duplicate, ` +
    `${out.rejected} rejected, ${out.dropped} dropped, ${out.failed} failed (source ${o.sourceKind} ${o.sourceRef})`,
  );
  return out;
}

/**
 * Why a pass that ended with zero accepted lines wrote no handoff, in the STALE_HANDOFF vocabulary:
 * `404` (route not deployed), `422:<rules>` (grammar rejects, local pre-filter drops included, since
 * they name the same server rules), `transport` (5xx/429/network after every retry), or `no_lines`
 * (the clerk returned nothing, or nothing but duplicates). Precedence: the reason an operator can
 * act on first.
 */
export function staleHandoffReason(outcome: PostLedgerOutcome | null): string {
  if (!outcome) return "no_lines";
  if (outcome.notFound > 0) return "404";
  if (outcome.rules.length > 0) return `422:${[...new Set(outcome.rules)].join(",")}`;
  if (outcome.failed > 0) return "transport";
  return "no_lines";
}

/**
 * The one greppable line for "an inactive distillation ended and wrote no handoff" (L2b). Claude.ai's
 * latest_handoff then goes silently stale; ops/health-check.py (check_ledger_handoffs) counts it.
 */
export function logStaleHandoff(companionId: string, channelId: string, reason: string): void {
  console.warn(`[ledger] STALE_HANDOFF companion=${companionId} channel=${channelId} reason=${reason}`);
}

/** Handoff summary = accepted contents joined by newlines, marks intact. */
export function ledgerSummary(outcome: PostLedgerOutcome): string {
  return outcome.accepted.map((a) => a.content).join("\n");
}
