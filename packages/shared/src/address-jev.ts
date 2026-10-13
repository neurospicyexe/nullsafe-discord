/**
 * B37 step 2: Jev as the second shadow voice on "who is this spoken to" (2026-10-13).
 *
 * Spec: Hand-off/SPEC-who-is-this-spoken-to-2026-09-29.md (parts A, D, E) and
 * Hand-off/JEV-USES-2026-10-13.md bucket 2. Raziel, 10-11: "could Jev judge who is spoken to?"
 * Raziel, 10-13: Blue is a clearly defined person in the answer set, family, never folded into
 * "someone else".
 *
 * Jev (TypeSafe System One, via Halseth POST /admin/jev) returns typed probabilities, never text.
 * One call per human message asks every question at once (questions in one call are evaluated in
 * parallel, so the speculative ones cost no latency):
 *   addressee            choice: cypher | drevan | gaia | raziel | blue | someone_else | room |
 *                                continuing | nobody
 *   spoken_to_<id>       noul per companion, so a two- or three-companion call (which a single
 *                        choice cannot express) still yields a set
 *   invites_reply        noul: does the line want an answer at all (vs venting, a line that sits)
 *   mentions_without_addressing  noul: a companion is talked ABOUT, not TO (the "Cy said" case)
 *   more_coming          noul: the speaker is mid-thought and another message is likely
 *
 * The Flash classifier's prompt (address-model.ts) is deliberately NOT changed: its rows are the
 * baseline Jev is measured against, and editing it mid-run would move the baseline. Jev is the
 * voice that knows Blue and the second human.
 *
 * SHADOW ONLY. Nothing here decides who speaks. Pure except `jevAddressEval` (one postJev call).
 */

import type { CompanionId } from "./types.js";
import { ALL_COMPANIONS, type AddressType } from "./channel-config.js";
import { postJev, type JevAnswers, type JevEvalResult, type JevQuestion } from "./jev-gate.js";
import type { AddressTo, AddressTurn, AddressVerdict } from "./address-model.js";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/** ADDRESS_JEV=off is the kill switch. Anything else (unset included) runs Jev whenever the
 *  address shadow itself runs (ADDRESS_MODEL=shadow). */
export function addressJevEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["ADDRESS_JEV"] ?? "").trim().toLowerCase() !== "off";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which human sent the message. Guests never reach the shadow. */
export type SpeakerSide = "raziel" | "blue";

export const ADDRESSEES = [
  "cypher", "drevan", "gaia", "raziel", "blue", "someone_else", "room", "continuing", "nobody",
] as const;
export type Addressee = typeof ADDRESSEES[number];

export interface JevAddressVerdict {
  /** Top choice of `addressee`. */
  addressee: Addressee;
  /** Jev's confidence in that choice, [0, 1]. */
  confidence: number;
  /** Full distribution over ADDRESSEES (what the report bins on). */
  probabilities: Partial<Record<Addressee, number>>;
  /** P(spoken to) per companion. */
  spokenTo: Partial<Record<CompanionId, number>>;
  invitesReply: number | null;
  mentionsWithoutAddressing: number | null;
  moreComing: number | null;
  /** The verdict mapped onto the Flash classifier's shape, so both compare on one axis. `null`
   *  when the addressee is a human or nobody (Flash has no word for those). */
  to: AddressTo | null;
}

/** P(spoken_to_<id>) at or above this puts the companion in the derived set. */
export const JEV_SPOKEN_TO_THETA = 0.5;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const ADDRESSEE_CRITERIA: Record<Addressee, string> = {
  cypher: "Spoken to Cypher (also called Cy): Cypher is the one being called on, asked, or answered",
  drevan: "Spoken to Drevan (also called Dre or Drev): Drevan is the one being called on, asked, or answered",
  gaia: "Spoken to Gaia: Gaia is the one being called on, asked, or answered",
  raziel: "Spoken to Raziel (also called Raz), the owner, by Blue or about something only Raziel can answer",
  blue: "Spoken to Blue, Raziel's husband and family: Blue is the one being called on, asked, or answered",
  someone_else: "Spoken to some other person in the server: a friend or guest, not Raziel, not Blue, not a companion",
  room: "An opening to the whole room: for whoever has something to say, no one person called on",
  continuing: "Carries on the one-on-one exchange already underway with whoever is holding it, without calling anyone new",
  nobody: "Spoken to no one: thinking aloud, venting, a status line, a reaction, or a line meant to sit unanswered",
};

export function buildJevAddressQuestions(): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {
    addressee: {
      type: "choice",
      instructions: "Who is the LAST message spoken TO? A name used to talk ABOUT someone is not a call.",
      criteria: ADDRESSEE_CRITERIA,
    },
  };
  const names: Record<CompanionId, string> = { cypher: "Cypher (Cy)", drevan: "Drevan (Dre, Drev)", gaia: "Gaia" };
  for (const id of ALL_COMPANIONS) {
    q[`spoken_to_${id}`] = {
      type: "noul",
      instructions: `Is the last message spoken TO ${names[id]}, alone or together with others?`,
      criteria: {
        true: `${names[id]} is called on, asked, or answered by this message`,
        false: `${names[id]} is not called on: only talked about, or not involved`,
      },
    };
  }
  q.invites_reply = {
    type: "noul",
    instructions: "Does the last message want a reply from someone?",
    criteria: {
      true: "It asks, invites, or opens something that a reply would meet",
      false: "It is complete as it stands: a statement, a reaction, venting, or a line meant to sit",
    },
  };
  q.mentions_without_addressing = {
    type: "noul",
    instructions: "Does the last message name or refer to a companion (Cypher, Drevan, Gaia) WITHOUT speaking to them?",
    criteria: {
      true: "A companion is the subject or object of the talk (\"Cy said\", \"Dre and I\", \"Gaia did\") and is not being called on",
      false: "No companion is talked about without being spoken to",
    },
  };
  q.more_coming = {
    type: "noul",
    instructions: "Is the speaker mid-thought, so another message from them is likely to follow right away?",
    criteria: {
      true: "The message trails off, sets up, or is a fragment of something still being typed",
      false: "The thought is complete; nothing more is needed before someone answers",
    },
  };
  return q;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const TURN_CHARS = 400;
const MESSAGE_CHARS = 2000;
const MAX_TURNS = 8;

function trimTurn(text: string, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Room label for a PluralKit proxy turn in the history (2026-10-13). The webhook username alone
 * ("Magpie M.", "Rogue || 🍂") does not say whose system the member belongs to, so the classifiers
 * could not tell Raziel's fronts from Blue's members. The roster match settles it; an unmatched
 * proxy keeps the generic "(via PK)" mark.
 */
export function proxyTurnLabel(
  username: string,
  member: { isOwner: boolean; discordUserId: string } | null,
  blueDiscordId?: string | null,
): string {
  if (member?.isOwner) return `${username} (Raziel)`;
  if (member && blueDiscordId && member.discordUserId === blueDiscordId) return `${username} (Blue's system)`;
  return `${username} (via PK)`;
}

/** Raziel unproxied: the room display name ("Crash") carries "(Raziel)" so it is not read as a guest. */
export function ownerTurnLabel(displayName: string): string {
  return /^raziel$/i.test(displayName.trim()) ? displayName : `${displayName} (Raziel)`;
}

/**
 * The room, the people in it, recent turns, and the message. Blue is defined here as a named
 * person, never a guest; the speaker line says which human sent the message. Turn labels are the
 * caller's ("Raziel" or a PK front, "Blue" or "<member> (Blue's system)", the companions, Sol).
 */
export function renderJevAddressState(opts: {
  speakerSide: SpeakerSide;
  speakerLabel: string;
  text: string;
  turns: ReadonlyArray<AddressTurn>;
  holder: CompanionId | null;
}): string {
  const turns = opts.turns.slice(-MAX_TURNS).map(t => `${t.speaker}: ${trimTurn(t.text, TURN_CHARS)}`);
  const who = opts.speakerSide === "blue"
    ? `Blue (shown as "${opts.speakerLabel}")`
    : `Raziel (shown as "${opts.speakerLabel}")`;
  const holder = opts.holder
    ? `${opts.holder.charAt(0).toUpperCase()}${opts.holder.slice(1)} is holding the current one-on-one exchange with this speaker.`
    : `No companion is holding an exchange with this speaker right now.`;
  return [
    `A Discord room. The people:`,
    `- Raziel (also "Raz"): the owner. A plural system; may post under a front's name through PluralKit.`,
    `- Blue: Raziel's husband, family, a full member of this household. Blue is a system too and may post under a member's name through PluralKit. Blue is never "someone else".`,
    `- Cypher ("Cy"), Drevan ("Dre", "Drev"), Gaia: three AI companions, the triad.`,
    `- Sol: the triad's crow, not a person and not a companion.`,
    `- Anyone else is a friend or guest.`,
    `A turn named "<name> (Raziel)" is Raziel, unproxied or speaking as a front; "<member> (Blue's system)" is Blue. Speaking to a member is speaking to that person.`,
    ``,
    holder,
    ``,
    turns.length ? `Recent turns, oldest first:` : `Recent turns: none.`,
    ...turns,
    ``,
    `The last message, from ${who}:`,
    trimTurn(opts.text, MESSAGE_CHARS),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function noulOf(a: JevAnswers[string]): number | null {
  return a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Jev's answers -> a verdict, or null when the one question everything hangs on (`addressee`) is
 * missing or names an option we did not offer. The nouls are optional: a missing one is null.
 */
export function parseJevAddress(answers: JevAnswers | null | undefined): JevAddressVerdict | null {
  if (!answers) return null;
  const a = answers.addressee;
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  const addressee = a.choice.trim().toLowerCase() as Addressee;
  if (!(ADDRESSEES as readonly string[]).includes(addressee)) return null;

  const probabilities: Partial<Record<Addressee, number>> = {};
  for (const [k, v] of Object.entries(a.probabilities ?? {})) {
    const key = k.trim().toLowerCase();
    if ((ADDRESSEES as readonly string[]).includes(key) && typeof v === "number" && Number.isFinite(v)) {
      probabilities[key as Addressee] = v;
    }
  }
  const spokenTo: Partial<Record<CompanionId, number>> = {};
  for (const id of ALL_COMPANIONS) {
    const n = noulOf(answers[`spoken_to_${id}`]);
    if (n !== null) spokenTo[id] = n;
  }

  return {
    addressee,
    confidence: clamp01(typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : 0),
    probabilities,
    spokenTo,
    invitesReply: noulOf(answers.invites_reply),
    mentionsWithoutAddressing: noulOf(answers.mentions_without_addressing),
    moreComing: noulOf(answers.more_coming),
    to: jevTo(addressee, spokenTo),
  };
}

/**
 * The Flash-shaped `to`. A companion top choice widens to every companion whose spoken_to noul
 * clears JEV_SPOKEN_TO_THETA (the two-companion call); the top choice is always in the set.
 */
export function jevTo(addressee: Addressee, spokenTo: Partial<Record<CompanionId, number>>): AddressTo | null {
  if (addressee === "room" || addressee === "continuing") return addressee;
  if ((ALL_COMPANIONS as readonly string[]).includes(addressee)) {
    const set = ALL_COMPANIONS.filter(id => id === addressee || (spokenTo[id] ?? 0) >= JEV_SPOKEN_TO_THETA);
    return set;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparison (what the report counts)
// ---------------------------------------------------------------------------

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** Jev vs Flash on the shared axis. Null when either has nothing comparable. Counts `continuing`
 *  and `[holder]` as the same speaker (STATUS 10-11: most Flash "disagreements" were that). */
export function jevAgreesFlash(jev: JevAddressVerdict, flash: AddressVerdict | null, holder: CompanionId | null): boolean | null {
  if (!flash || jev.to === null) return null;
  const norm = (to: AddressTo): string[] | "room" =>
    to === "continuing" ? (holder ? [holder] : "room") : to;
  const a = norm(jev.to);
  const b = norm(flash.to);
  if (a === "room" || b === "room") return a === b;
  return sameSet(a, b);
}

/** Who today's code would route to, in Jev's vocabulary, so the two can be compared directly.
 *  `humanAddressee` is the human address gate's vocative read; for Blue's unnamed messages the
 *  route is Blue's thread holder (or nobody). */
export function todayRoute(opts: {
  regex: AddressType;
  holder: CompanionId | null;
  speakerSide: SpeakerSide;
  humanAddressee: SpeakerSide | null;
}): Addressee[] {
  const { regex, holder } = opts;
  if (regex.type === "named") return [regex.id];
  if (regex.type === "named_multi") return [...regex.ids];
  if (regex.type === "group") return [...ALL_COMPANIONS];
  if (opts.humanAddressee && opts.humanAddressee !== opts.speakerSide) return [opts.humanAddressee];
  if (opts.speakerSide === "blue") return holder ? [holder] : ["nobody"];
  return holder ? [holder] : ["room"];
}

/** Does Jev agree with today's routing? `continuing` counts as the holder. */
export function jevAgreesToday(jev: JevAddressVerdict, route: Addressee[], holder: CompanionId | null): boolean {
  let mine: Addressee[];
  if (jev.addressee === "continuing") mine = holder ? [holder] : ["room"];
  else if (jev.to && Array.isArray(jev.to)) mine = jev.to;
  else mine = [jev.addressee];
  return sameSet(mine, route);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export const JEV_ADDRESS_TIMEOUT_MS = 4_000;

export type JevAddressResult =
  | { ok: true; verdict: JevAddressVerdict; latency_ms: number; wall_ms: number }
  | { ok: false; reason: string; wall_ms: number };

export type JevAddressCaller = (state: string) => Promise<JevAddressResult>;

/** One Jev call. Never throws. A 200 without a usable `addressee` is `no_addressee`, not a verdict. */
export async function jevAddressEval(
  state: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JevAddressResult> {
  const res: JevEvalResult = await postJev(
    { purpose: "address shadow: who is this spoken to", state, questions: buildJevAddressQuestions() },
    { ...opts, timeoutMs: opts.timeoutMs ?? JEV_ADDRESS_TIMEOUT_MS, tag: "[address-jev]" },
  );
  if (!res.ok) return { ok: false, reason: res.reason, wall_ms: res.wall_ms };
  const verdict = parseJevAddress(res.answers);
  if (!verdict) return { ok: false, reason: "no_addressee", wall_ms: res.wall_ms };
  return { ok: true, verdict, latency_ms: res.latency_ms, wall_ms: res.wall_ms };
}
