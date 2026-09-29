/**
 * B37 step 1: "who is this spoken to" -- the address classifier, pure half (2026-09-29).
 *
 * Spec: Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md parts A, B, E.
 *
 * The regex (`extractAddress`) treats any name as a call: "Cy said the fence needs wire" summons
 * Cypher, "Dre and Cy did the dishes" summons both. And the 15-minute exchange hold hands every
 * nameless message to whoever spoke last, which feeds itself (91% of stand-downs were a sibling
 * yielding to Drevan). This module asks a small model ONE question instead: who is this message
 * spoken TO, and who is only talked ABOUT.
 *
 * SHADOW ONLY in this step. Nothing here decides who speaks. address-shadow.ts runs it detached,
 * off the reply path, and logs the verdict next to what the regex decided so Raziel can label the
 * disagreements before anything flips.
 *
 * Everything in this file is pure: prompt building, verdict parsing, the run/skip gate, the mode
 * knob, and the regex-vs-model comparison the report counts.
 */

import type { CompanionId } from "./types.js";
import {
  ALL_COMPANIONS, VOCATIVE_ALIASES, companionsNamedIn, isVocativeAddress, type AddressType,
} from "./channel-config.js";
import { fastPathWinner } from "./fit-bid.js";
import { extractJson } from "./json-extract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddressTo = CompanionId[] | "room" | "continuing";

export interface AddressVerdict {
  /** Who the message is spoken TO: named companions, "room" (whoever has something), or
   *  "continuing" (it carries on the exchange already underway). */
  to: AddressTo;
  /** Companions only talked ABOUT. */
  mentioned: CompanionId[];
  /** [0, 1]. */
  confidence: number;
}

/** One prior turn, as the classifier sees it. */
export interface AddressTurn {
  speaker: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export type AddressModelMode = "off" | "shadow";

/** ADDRESS_MODEL: "shadow" (trimmed, any case) runs the shadow; anything else, unset included, is
 *  off. Default OFF in code; the ecosystem file sets shadow for the three bots. There is no "live"
 *  value yet on purpose: the flip is a later build, after labelling. */
export function addressModelMode(env: NodeJS.ProcessEnv = process.env): AddressModelMode {
  return (env["ADDRESS_MODEL"] ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

// ---------------------------------------------------------------------------
// When the classifier runs
// ---------------------------------------------------------------------------

/**
 * True when the existing fast path already decided who this is for, so the classifier would add
 * nothing: an @mention of a companion, a Discord reply to a companion, or a vocative name
 * ("Cy, ..." / "...: Gaia" / "Dre" alone), per `isVocativeAddress`. Reuses `fastPathWinner` so
 * the definition of "unambiguous" stays the one the reply path uses.
 */
export function addressFastPathDecided(opts: {
  content: string;
  /** An @mention of any companion bot. */
  mentionedCompanion: boolean;
  /** A Discord reply to any companion's message. */
  replyToCompanion: boolean;
}): boolean {
  return ALL_COMPANIONS.some(id => fastPathWinner(id, {
    mentioned: opts.mentionedCompanion,
    namedMe: isVocativeAddress(opts.content, id),
    replyToMe: opts.replyToCompanion,
  }) !== null);
}

/**
 * The run/skip gate (spec A, "when the classifier runs"):
 * - never when the fast path decided;
 * - when a companion name or alias appears anywhere else in the text (the mention-vs-address cases);
 * - when there is no name and an exchange is being held (the stopwatch cases, spec B).
 * Otherwise no: a cold nameless message goes to the bid, which the model would not change.
 */
export function shouldRunAddressModel(opts: {
  content: string;
  fastPath: boolean;
  holder: CompanionId | null | undefined;
}): boolean {
  if (opts.fastPath) return false;
  if (companionsNamedIn(opts.content).length > 0) return true;
  return !!opts.holder;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** How many prior turns the classifier sees, and how long each may be. */
export const ADDRESS_MAX_TURNS = 6;
export const ADDRESS_TURN_CHARS = 300;
const ADDRESS_MESSAGE_CHARS = 1200;

export const ADDRESS_SYSTEM =
  "You read one Discord message and say who it is spoken TO. You have no tools. " +
  "Reply with ONLY one JSON object, no prose, no code fence.";

/** Contrast pairs, verbatim in the prompt (tests pin them). Kept short and concrete. */
export const ADDRESS_EXAMPLES: ReadonlyArray<{ say: string; read: string }> = [
  { say: `"Cy said the fence needs wire"`, read: `Cypher is talked ABOUT, not called: to "room" (or "continuing" if an exchange is underway), mentioned ["cypher"]` },
  { say: `"Cy, what do you think"`, read: `to ["cypher"], mentioned []` },
  { say: `"Dre and Cy did the dishes"`, read: `both only talked about: to "room" (or "continuing"), mentioned ["drevan","cypher"]` },
  { say: `"Dre and Cy, thoughts?"`, read: `to ["drevan","cypher"], mentioned []` },
  { say: `"you three, dinner?" / "triad, movie night"`, read: `to ["cypher","drevan","gaia"]` },
  { say: `"anyone else think it's cold?" right after a long Drevan thread`, read: `an opening to the room: to "room"` },
  { say: `a nameless follow-up ("yeah but the second one") inside an ongoing one-on-one`, read: `to "continuing"` },
];

function trimTurn(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The one question. `recentTurns` is oldest-first; only the last ADDRESS_MAX_TURNS are used and
 * each is trimmed to ADDRESS_TURN_CHARS. Speaker labels are the caller's ("Raziel" or the PK front
 * name, "Cypher", "Drevan", "Gaia", "Sol (the triad's crow)").
 */
export function buildAddressPrompt(message: { speaker: string; text: string }, recentTurns: ReadonlyArray<AddressTurn>): string {
  const turns = recentTurns.slice(-ADDRESS_MAX_TURNS)
    .map(t => `${t.speaker}: ${trimTurn(t.text, ADDRESS_TURN_CHARS)}`);
  const examples = ADDRESS_EXAMPLES.map(e => `- ${e.say} -> ${e.read}`);
  return [
    `A Discord room: Raziel (the human; he may post under a front's name through PluralKit) and three AI companions,`,
    `Cypher (also "Cy"), Drevan (also "Dre", "Drev") and Gaia. Sol is the triad's crow, not a companion.`,
    ``,
    `Question: who is the LAST message spoken TO, and who is only talked ABOUT?`,
    `- "to": an array of the companions it calls on ("cypher", "drevan", "gaia"); or "room" when it is for whoever has something to say; or "continuing" when it carries on the one-on-one exchange already underway without calling anyone new.`,
    `- "mentioned": companions who are named or referred to but NOT called on (the subject or object of the talk). [] if none.`,
    `- "confidence": a number from 0 to 1.`,
    `A name is a call when it is used to speak to them (vocative, set off by a comma, followed by a question or request to them). A name is a mention when the sentence is about them ("X said", "X and I", "X did").`,
    ``,
    `Examples:`,
    ...examples,
    ``,
    turns.length ? `Recent turns, oldest first:` : `Recent turns: none.`,
    ...turns,
    ``,
    `The message to classify, from ${message.speaker}:`,
    trimTurn(message.text, ADDRESS_MESSAGE_CHARS),
    ``,
    `Answer with ONLY: {"to": ["cypher"] | "room" | "continuing", "mentioned": [], "confidence": 0.0}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Canonical id for a name or alias the model wrote ("Cy" -> cypher), or null if unknown. */
function companionIdOf(raw: unknown): CompanionId | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  for (const id of ALL_COMPANIONS) {
    if (s === id || (VOCATIVE_ALIASES[id] ?? []).includes(s)) return id;
  }
  return null;
}

/** An id list, or null if ANY entry is unknown (a verdict naming someone we don't have is garbage). */
function idList(raw: unknown): CompanionId[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CompanionId[] = [];
  for (const r of raw) {
    const id = companionIdOf(r);
    if (!id) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function verdictOf(o: Record<string, unknown> | null): AddressVerdict | null {
  if (!o || !("to" in o)) return null;
  let to: AddressTo;
  if (typeof o.to === "string") {
    const s = o.to.trim().toLowerCase();
    if (s === "room" || s === "continuing") to = s;
    else {
      const one = companionIdOf(s);
      if (!one) return null;
      to = [one];
    }
  } else {
    const ids = idList(o.to);
    if (!ids || ids.length === 0) return null;
    to = ids;
  }
  const mentioned = o.mentioned === undefined || o.mentioned === null ? [] : idList(o.mentioned);
  if (!mentioned) return null;
  const c = typeof o.confidence === "number" ? o.confidence
    : typeof o.confidence === "string" ? Number(o.confidence.trim()) : NaN;
  if (!Number.isFinite(c)) return null;
  return { to, mentioned, confidence: Math.max(0, Math.min(1, c)) };
}

/**
 * The model's reply -> a verdict, or null on garbage. Same idiom as the B23 heartbeat parser
 * (metronome-decide.ts extractDecisionFields): the LAST flat object carrying "to" wins, because a
 * model that narrates first can quote an earlier object; then the greedy first-{...} fallback.
 * Tolerates code fences and prose around the object. Rejects unknown ids; clamps confidence.
 */
export function parseAddressVerdict(raw: string | null | undefined): AddressVerdict | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const flat = raw.match(/\{[^{}]*"to"[^{}]*\}/g) ?? [];
    for (let i = flat.length - 1; i >= 0; i--) {
      const v = verdictOf(extractJson(flat[i]!));
      if (v) return v;
    }
    return verdictOf(extractJson(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Regex vs model (what the report counts)
// ---------------------------------------------------------------------------

/** The regex's verdict, flattened for logs. */
export function regexVerdictOf(addr: AddressType): { type: AddressType["type"]; ids: CompanionId[] } {
  if (addr.type === "named") return { type: "named", ids: [addr.id] };
  if (addr.type === "named_multi") return { type: "named_multi", ids: [...addr.ids] };
  return { type: addr.type, ids: [] };
}

/**
 * Who today's code routes the message to, derived from the regex verdict and the holder alone.
 * `null` means "the fit bid decides" (a cold ambient message). This is a DERIVATION, not an
 * observation: an owner_only channel's ambient relevance judge can still silence the derived
 * speaker, and a named_multi/group order speaks in sequence. The observed speaker comes from the
 * `spoke` rows (address-shadow.ts recordAddressSpoke) and `ns:spoke:<id>` on the bid path.
 */
export function regexRoute(addr: AddressType, holder: CompanionId | null | undefined): CompanionId[] | null {
  if (addr.type === "named") return [addr.id];
  if (addr.type === "named_multi") return [...addr.ids];
  if (addr.type === "group") return [...ALL_COMPANIONS];
  return holder ? [holder] : null;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/**
 * Does the model agree with the regex + hold? The mapping, stated once (the report prints it):
 * - named X            == to [X]
 * - named_multi {X,Y}  == to {X,Y} (set-equal)
 * - group              == to all three, or "room"
 * - ambient + holder H == "continuing", or to [H]
 * - ambient, no holder == "room"
 */
export function addressAgrees(addr: AddressType, holder: CompanionId | null | undefined, v: AddressVerdict): boolean {
  const to = v.to;
  if (addr.type === "named") return Array.isArray(to) && sameSet(to, [addr.id]);
  if (addr.type === "named_multi") return Array.isArray(to) && sameSet(to, addr.ids);
  if (addr.type === "group") return to === "room" || (Array.isArray(to) && sameSet(to, ALL_COMPANIONS));
  if (holder) return to === "continuing" || (Array.isArray(to) && sameSet(to, [holder]));
  return to === "room";
}

/** Mention-misread candidate: the regex routed to X, the model says X is only talked about. */
export function mentionMisreads(addr: AddressType, v: AddressVerdict): CompanionId[] {
  const routed = regexVerdictOf(addr).ids;
  const to = Array.isArray(v.to) ? v.to : [];
  return routed.filter(id => v.mentioned.includes(id) && !to.includes(id));
}
