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
 * The health clause is load-bearing: Halseth rejects any health value near a digit unless the
 * source is a human-authored row, and none of the bot sources ever are. So the clerk is told to
 * say a reading was mentioned WITHOUT the value -- a digit-free line passes, and the number never
 * travels on a clerk's word.
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
  "- Never restate a health number (glucose, blood sugar, doses, medication amounts, weight, labs, blood pressure, HRV). " +
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

// ── Local grammar pre-filter (mirrors halseth src/ledger/grammar.ts; server is authority) ────────

const RECORD_VERB = /^(logged|counted|recorded|found|missing)\b:?/i;
const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|myself|we|us|our|ours|ourselves)\b/i;
const INTERIOR = /\b(felt|feel|feels|wanted|want|knew|remembered|loved|longed|missed|hoped)\b/i;
const LEXICON = /🩸|\b(vevi|vevan|vaselrin|vethmerin|darling|sweetheart|sweetie|babe|beloved)\b/i;
const HEALTH_TERM = "(glucose|blood sugar|bg|mg\\/dl|a1c|insulin|dose|dosage|mg|mcg|units|weight|lbs|kg|labs?|hrv|bp|blood pressure)";
const HEALTH_NEAR_DIGIT = new RegExp(`\\b${HEALTH_TERM}\\b[^\\n]{0,24}\\d|\\d[^\\n]{0,24}\\b${HEALTH_TERM}\\b`, "i");

/** Remove straight- and curly-double-quoted spans (the server's pronoun-scan exemption). */
function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
}

/**
 * Why a candidate body would be refused, or null when it looks compliant. Mirrors the server:
 * mark glyphs, record verb, first person + interior verbs outside quotes, lexicon anywhere
 * (quotes included), and health values near a digit (never sourced to a human row from here).
 */
export function preflightLedgerBody(body: string): string | null {
  const b = body.trim();
  if (!b) return "empty";
  if (b.includes("〔") || b.includes("〕")) return "mark";
  if (!RECORD_VERB.test(b)) return "verb";
  const unquoted = stripQuoted(b);
  if (FIRST_PERSON.test(unquoted)) return "self";
  if (INTERIOR.test(unquoted)) return "interior";
  if (LEXICON.test(b)) return "lexicon";
  if (HEALTH_NEAR_DIGIT.test(b)) return "health";
  if (b.length > 600) return "length";
  return null;
}

/** First-person / interior / lexicon check for handoff metadata (title, loops, steps). */
function isSelfFree(s: string): boolean {
  const u = stripQuoted(s);
  return !FIRST_PERSON.test(u) && !INTERIOR.test(u) && !LEXICON.test(s) && !s.includes("〔") && !s.includes("〕");
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
    const why = preflightLedgerBody(body);
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
