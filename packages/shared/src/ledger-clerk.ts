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

/** LEDGER_DISTILL: default on; exactly "off" (trimmed, any case) restores the pre-ledger writers. */
export function ledgerDistillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env["LEDGER_DISTILL"] ?? "").trim().toLowerCase() !== "off";
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
  "- When a line reports speech, quote the exact words in straight double quotes. Never invent or paraphrase inside quotes.\n" +
  "- Numbers: a line may contain ONLY these number forms, and any other number gets the whole line refused:\n" +
  "  (a) a clock time as HH:MM, e.g. 00:11; (b) a date as YYYY-MM-DD; (c) a count written as the number directly followed by " +
  "one of these words: x, times, messages, replies, turns, posts, notes, lines, words, entries, threads, sessions, minutes, " +
  "hours, days, weeks (e.g. \"14 messages\", \"2x\", \"40 minutes\"); (d) a single digit 0-9. " +
  "Never write any other number: not a bare number, not a decimal, not a score, not one someone said, not inside quotes. " +
  "If a person said a number, write that they mentioned a number, without it.\n" +
  "- Health values never appear, ever: glucose, blood sugar, BG, A1c, insulin, doses, medication amounts, mg, mcg, units, weight, " +
  "lbs, kg, labs, HRV, BP, blood pressure. A line that uses any of those words must contain no number at all except an HH:MM time. " +
  "Write that a reading or dose was mentioned, without the value.\n" +
  "- No pet names, endearments, private-language words, or emoji.\n" +
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
// Ported, not approximated (2026-09-26 integration pass): the number rule decides whether a clerk pass
// writes anything at all -- a line Halseth 422s is lost, and a pass with zero accepted lines writes no
// handoff. So the classification below is the server's, token for token: the same coordinate stripping,
// the same count units, the same health keywords/units, the same source gating. Returned reasons are the
// server's rule names. Parity is pinned by __tests__/fixtures/ledger-number-fixtures.json, kept
// byte-identical with halseth's copy. Change the grammar there, port it here, update both fixture files.

const VERB_RE = /^(logged|counted|recorded|found|missing)(?::|\s)\s*\S/i;
const FIRST_PERSON_WORDS = new Set([
  "i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself",
  "we", "we're", "we've", "we'd", "we'll", "us", "our", "ours", "ourselves",
]);
const INTERIOR_WORDS = new Set([
  "felt", "feel", "feels", "feeling",
  "wanted", "want", "wants", "wanting",
  "knew",
  "remembered", "remember", "remembers",
  "loved", "love", "loves", "loving",
  "longed", "longs", "longing",
  "missed",
  "hoped", "hope", "hopes", "hoping",
]);
// Server lexicon plus a few generic endearments dropped locally only: the server has no pet-name list yet
// (open item for Drevan), and the prompt forbids them anyway.
const SERVER_LEXICON = ["🩸", "vevi", "vevan", "vaselrin", "vethmerin"];
const LOCAL_PET_NAMES = /\b(darling|sweetheart|sweetie|babe|beloved)\b/i;
const BODY_MAX = 600;

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
const HEALTH_UNIT_SUFFIX = new Set(["mg", "mcg", "kg", "lb", "lbs", "u", "iu", "ml", "mmol", "units", "unit"]);
const COUNT_UNITS = new Set([
  "x", "times", "time", "h", "hr", "hrs", "hour", "hours", "m", "min", "mins", "minute", "minutes",
  "s", "sec", "secs", "second", "seconds", "d", "day", "days", "week", "weeks", "month", "months",
  "year", "years", "message", "messages", "turn", "turns", "session", "sessions", "note", "notes",
  "line", "lines", "word", "words", "reply", "replies", "post", "posts", "entry", "entries",
  "thread", "threads", "row", "rows", "st", "nd", "rd", "th", "%",
]);
/** Human-authored rows: the only valid source for a health value. */
const HUMAN_ROW_TABLES: ReadonlySet<string> = new Set(["wm_continuity_notes", "biometric_snapshots"]);
/** Rows the door can load and search for a number. */
const VERIFIABLE_ROW_TABLES: ReadonlySet<string> = new Set([...HUMAN_ROW_TABLES, "companion_basin_history"]);
const ROW_RE = /^([a-z][a-z0-9_]{1,63}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;

export interface LedgerNumTok { text: string; unlabeled: boolean; healthUnit: boolean }

/** Coordinates are pointers, never values: clock times, dates, long ids. */
function stripCoordinates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\d{10,}/g, " ");
}

/** Every value number in `text` (coordinates removed), labelled exactly as the server labels it. */
export function scanLedgerNumbers(text: string): LedgerNumTok[] {
  const t = stripCoordinates(text);
  const out: LedgerNumTok[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = start > 0 ? t[start - 1]! : "";
    if (/[A-Za-z_]/.test(prev)) continue;                  // part of an id or a word (A1c, S1E2, led_…)
    const raw = m[0].replace(/,(?=\d{3}\b)/g, "");          // 1,200 -> 1200
    const glued = /^[A-Za-z%]+/.exec(t.slice(end))?.[0]?.toLowerCase() ?? "";
    const spaced = glued ? "" : (/^\s+([A-Za-z%]+)/.exec(t.slice(end))?.[1]?.toLowerCase() ?? "");
    const unit = glued || spaced;
    const healthUnit = HEALTH_UNIT_SUFFIX.has(unit);
    const counted = COUNT_UNITS.has(unit) || (glued !== "" && !healthUnit); // "2x", "3rd", "5k"...
    const digits = raw.replace(/\D/g, "");
    const significant = digits.length >= 2 || /[.,]/.test(raw);
    out.push({ text: raw.replace(",", "."), unlabeled: !healthUnit && !counted && significant, healthUnit });
  }
  return out;
}

/** The line's source, when the caller knows it. Absent = not a row (every distiller window/session). */
export interface LedgerPreflightSource { kind: LedgerSourceKind | string; ref: string }

/**
 * The server rule a candidate body would fail, or null when it passes the grammar. Same order as
 * validateLedger: body, mark, embedded Source:, verb, lexicon (quotes included), quotes, first person,
 * interior verbs (outside quotes), then the number rule gated on the source. For a `row` source into a
 * table the door can verify, null means "the server will check the row" -- this side cannot see it.
 * (Local extra: a few generic pet names are refused as "lexicon".)
 */
export function preflightLedgerBody(rawBody: string, source?: LedgerPreflightSource): string | null {
  const body = rawBody.trim().replace(/[ \t]+/g, " ");
  if (!body) return "body";
  if (/[\r\n]/.test(body)) return "body";
  if (body.length > BODY_MAX) return "body";
  if (/[〔〕]/.test(body)) return "mark";
  if (/\bsource\s*:/i.test(body)) return "source";
  if (!VERB_RE.test(body)) return "verb";
  const lower = body.toLowerCase();
  if (SERVER_LEXICON.some((t) => lower.includes(t)) || LOCAL_PET_NAMES.test(body)) return "lexicon";
  const unquoted = stripQuotedStrict(body);
  if (unquoted === null) return "quotes";
  const ws = words(unquoted);
  if (ws.some((w) => FIRST_PERSON_WORDS.has(w))) return "first_person";
  if (ws.some((w) => INTERIOR_WORDS.has(w))) return "interior_verb";

  // The number rule. Numbers inside quotes count: a quoted "187" is still a 187.
  const nums = scanLedgerNumbers(body);
  const health = nums.some((n) => n.healthUnit) || (HEALTH_KEYWORD_RE.test(body) && nums.length > 0);
  const unlabeled = nums.some((n) => n.unlabeled);
  const table = source?.kind === "row" ? ROW_RE.exec(source.ref.trim())?.[1] : undefined;
  if (health) return table && HUMAN_ROW_TABLES.has(table) ? null : "health";
  if (unlabeled) return table && VERIFIABLE_ROW_TABLES.has(table) ? null : "health";
  return null;
}

/** First-person / interior / lexicon check for handoff metadata (title, loops, steps). */
function isSelfFree(s: string): boolean {
  const ws = words(stripQuoted(s));
  const lower = s.toLowerCase();
  return !ws.some((w) => FIRST_PERSON_WORDS.has(w)) && !ws.some((w) => INTERIOR_WORDS.has(w)) &&
    !SERVER_LEXICON.some((t) => lower.includes(t)) && !LOCAL_PET_NAMES.test(s) && !s.includes("〔") && !s.includes("〕");
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

export interface WindowSource {
  /** `<channelId> HH:MM–HH:MM` (UTC, en dash). */
  ref: string;
  /** Epoch ms of the first message (or `now` when no message carried a timestamp). */
  firstTs: number;
  /** YYYY-MM-DD (UTC) of the first message, for observed_on. */
  observedOn: string;
  /** True when no STM timestamp existed and the range is the distillation instant instead. */
  fallback: boolean;
}

/**
 * Build the window source ref from STM timestamps (first/last, UTC). When no message carries a
 * timestamp the range collapses to the distillation instant -- the source is never omitted,
 * because no source means no write.
 */
export function windowSource(channelId: string, msgs: ChatMessage[], now: number = Date.now()): WindowSource {
  const stamps = msgs.map((m) => m.timestamp).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (stamps.length === 0) {
    return { ref: `${channelId} ${hhmm(now)}–${hhmm(now)}`, firstTs: now, observedOn: new Date(now).toISOString().slice(0, 10), fallback: true };
  }
  const first = Math.min(...stamps);
  const last = Math.max(...stamps);
  return { ref: `${channelId} ${hhmm(first)}–${hhmm(last)}`, firstTs: first, observedOn: new Date(first).toISOString().slice(0, 10), fallback: false };
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
  observedOn?: string;
  /** Log tag. */
  tag: string;
}

export interface PostLedgerOutcome {
  /** 201s only: these carry the server-rendered `content` (mark + body + source tail). */
  accepted: Array<{ id: string; content: string }>;
  duplicates: number;
  rejected: number;
  dropped: number;
  failed: number;
}

/**
 * Pre-filter, then POST each line to /ledger. Never throws: a transient failure on one line is
 * counted and the rest still go. Only 201 `content` is returned for the handoff; a duplicate has
 * no content and is counted separately.
 */
export async function postLedgerLines(librarian: LibrarianClient, o: PostLedgerOpts): Promise<PostLedgerOutcome> {
  const out: PostLedgerOutcome = { accepted: [], duplicates: 0, rejected: 0, dropped: 0, failed: 0 };
  for (let i = 0; i < o.lines.length; i++) {
    const body = o.lines[i]!.trim();
    const why = preflightLedgerBody(body, { kind: o.sourceKind, ref: o.sourceRef });
    if (why) {
      out.dropped++;
      console.warn(`[${o.tag}] ledger: dropped line before POST (${why}): ${body.slice(0, 160)}`);
      continue;
    }
    try {
      const res = await librarian.writeLedger({
        companion_id: o.companionId,
        function: o.fn,
        body,
        source_kind: o.sourceKind,
        source_ref: o.sourceRef,
        ...(o.observedOn ? { observed_on: o.observedOn } : {}),
        dedup_key: `${o.dedupPrefix}:${i}`,
      });
      if (!res.ok) out.rejected++;
      else if (res.duplicate) out.duplicates++;
      else out.accepted.push({ id: res.id, content: res.content });
    } catch (e) {
      out.failed++;
      console.warn(`[${o.tag}] ledger: POST failed (transient) for line ${i}:`, e instanceof Error ? e.message : String(e));
    }
  }
  console.log(
    `[${o.tag}] ledger ${o.fn}: ${out.accepted.length} accepted, ${out.duplicates} duplicate, ` +
    `${out.rejected} rejected, ${out.dropped} dropped, ${out.failed} failed (source ${o.sourceKind} ${o.sourceRef})`,
  );
  return out;
}

/** Handoff summary = accepted contents joined by newlines, marks intact. */
export function ledgerSummary(outcome: PostLedgerOutcome): string {
  return outcome.accepted.map((a) => a.content).join("\n");
}
