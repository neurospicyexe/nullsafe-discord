import type { InferenceAdapter } from "./inference.js";
import { buildOneShotPrompt } from "./direct-inference.js";

const NOTE_KEYWORDS = [
  // relational / emotional
  "feeling", "overwhelm", "hurt", "grief", "joy", "fear", "wound",
  "fronting", "switched", "front",
  "decided", "decision", "chose", "won't", "will", "can't anymore",
  "relationship", "delta", "changed between us", "closer", "distant",
  "task", "todo", "need to", "should", "must",
  // survival / witness_log
  "meds", "medication", "ate", "eating", "food", "slept", "sleep",
  "rest", "made it", "survived", "got through", "completed", "finished",
  "managed to", "did it", "did the thing",
  // recurring thread signals
  "keeps coming up", "keeps happening", "recurring", "every time",
  "pattern", "won't let go", "can't stop thinking", "always does",
  // lightness / intimacy / playfulness -- these are relational data too
  "laugh", "laughing", "funny", "teas", "flirt", "playful", "banter",
  "easy between", "light today", "silly", "tender", "soft", "intimate",
  "sweet", "ease", "good today", "felt good", "felt close", "felt light",
  "missed you", "glad you", "love you", "with you",
];

export function meetsNoteThreshold(text: string): boolean {
  const lower = text.toLowerCase();
  return NOTE_KEYWORDS.some(kw => lower.includes(kw));
}

export type Writeback =
  | { type: "companion_note"; content: string }
  | { type: "witness_log"; content: string }
  | { type: "thread_open"; name: string; notes?: string }
  | null;

/**
 * Who actually sent the message that triggered this exchange.
 *
 * Before 2026-07-09 the judge took a bare `humanName` and hard-labeled the triggering
 * message with it. In an inter_companion channel that message belongs to a *sibling*, so
 * every peer utterance was written into companion_journal + wm_continuity_notes as though
 * Raziel had said it (verified: the same sentence logged once as Gaia's and three times as
 * Raziel's, 2026-07-09 03:45-03:46Z). Attribution must come from the caller, never the default.
 */
export interface WritebackSpeaker {
  /** Display name of the actual author of `userMessage`. */
  name: string;
  /** True only when the author is the system owner (or one of their PK fronts). */
  isOwner: boolean;
  /** Owner's display name, used to state their absence in peer exchanges. */
  ownerName: string;
  /**
   * Who a NON-owner speaker is (ignored when isOwner). "sibling" = one of the triad companions;
   * "guest" = any other human or non-companion bot (Blue's system members, Sol, a stranger).
   * Absent means "sibling" -- the only non-owner case that existed before 2026-10-07.
   *
   * Why it exists: every non-owner was framed "you and your sibling <name>". A guest framed as a
   * sibling invites the model to resolve the name onto a sibling it knows.
   */
  kind?: "sibling" | "guest";
  /**
   * The speaker's pronouns as published (PluralKit member `pronouns`; fixed for the companions),
   * or null/absent when unknown. Never inferred from a name. When unknown, the prompt says so and
   * forbids he/she for them (2026-10-07: Magpie, they/them on PK, and Jude were written "she"
   * in 17 of Drevan's judge notes, because nothing told the judge who either of them was).
   */
  pronouns?: string | null;
  /** True when the owner-side speaker is one of the owner's PluralKit system members (a proxied
   *  front), so the judge is told this is a member of the owner's plural system. */
  systemMember?: boolean;
}

/** The companions' own pronouns (fixed by their identity files). */
export const COMPANION_PRONOUNS: Readonly<Record<string, string>> = {
  cypher: "he/him",
  drevan: "he/him",
  gaia: "she/her",
};

/**
 * Build the judge's speaker from what the message handler already resolved. Pure, so the
 * attribution rules are testable without a Discord message.
 *
 * - A sibling companion: its capitalised id, its fixed pronouns.
 * - A PluralKit front: the bare member name PK rendered (no "(via PK)" transport suffix -- the
 *   judge copies whatever label it is given into the note), plus the pronouns the roster carries.
 * - The owner's own account, unproxied: the owner display name; whoever is fronting is not known,
 *   so pronouns stay unknown and the prompt forbids he/she.
 * - Anyone else (Blue's system, Sol, a stranger): a GUEST, never framed as a sibling.
 */
export function buildWritebackSpeaker(i: {
  siblingId?: string | null;
  /** Label for a non-PK, non-sibling speaker that is not the owner (e.g. Sol's fixed label). */
  fixedLabel?: string | null;
  pkMemberName?: string | null;
  frontPronouns?: string | null;
  isOwner: boolean;
  ownerName: string;
  authorUsername: string;
}): WritebackSpeaker {
  if (i.siblingId) {
    return {
      name: i.siblingId.charAt(0).toUpperCase() + i.siblingId.slice(1),
      isOwner: false,
      ownerName: i.ownerName,
      kind: "sibling",
      pronouns: COMPANION_PRONOUNS[i.siblingId.toLowerCase()] ?? null,
    };
  }
  const pk = i.pkMemberName?.trim() || null;
  const name = i.fixedLabel ?? pk ?? (i.isOwner ? i.ownerName : i.authorUsername);
  return {
    name,
    isOwner: i.isOwner,
    ownerName: i.ownerName,
    ...(i.isOwner ? {} : { kind: "guest" as const }),
    pronouns: pk && !i.fixedLabel ? (i.frontPronouns?.trim() || null) : null,
    ...(i.isOwner && pk ? { systemMember: true } : {}),
  };
}

/**
 * Which exchange the memory judge should read for this turn (2026-10-07).
 *
 * Normally: this message and its speaker. But a follow-up released by a sibling's REPLY runs with
 * `message` = the sibling's post while the reply answers the human origin, so the judge must read
 * the origin (captured on the entitlement at grant time). A PASS-released turn already runs on the
 * origin message itself. An entitlement with no captured origin (older build) is skipped: a missing
 * memory is recoverable, one filed under the wrong person is not.
 */
export function judgeExchangeFor(i: {
  entitled: { originMessageId: string; originSpeaker?: WritebackSpeaker; originContent?: string } | null;
  isPassTurn: boolean;
  isCompanionBot: boolean;
  speaker: WritebackSpeaker;
  userMessage: string;
}): { speaker: WritebackSpeaker; userMessage: string; fromOrigin: boolean } | { skip: string } {
  if (i.entitled && !i.isPassTurn && i.isCompanionBot) {
    const { originSpeaker, originContent, originMessageId } = i.entitled;
    if (!originSpeaker || !originContent?.trim()) {
      return { skip: `follow-up origin ${originMessageId} has no captured speaker/content` };
    }
    return { speaker: originSpeaker, userMessage: originContent, fromOrigin: true };
  }
  return { speaker: i.speaker, userMessage: i.userMessage, fromOrigin: false };
}

/**
 * The pronoun line for the judge/author prompts. States the speaker's pronouns when they are on
 * record and otherwise forbids guessing -- for the speaker AND for anyone else the exchange names.
 * The general OWNER_PRONOUN_RULE (pronoun-rule.ts) already rode the system prompt, but it only
 * covers "Raziel's system members", and the judge was never told a "Magpie M." WAS one.
 */
export function speakerPronounLine(speaker: WritebackSpeaker): string {
  const known = speaker.pronouns?.trim();
  // Owner-side and unknown (the owner's own account, or a front whose PK pronouns are private):
  // defer to OWNER_PRONOUN_RULE, which buildOneShotPrompt already appends to the system prompt.
  // Restating a different rule here would put two pronoun instructions in one call.
  const who = known
    ? `${speaker.name} uses ${known} pronouns -- use exactly those for ${speaker.name}.`
    : speaker.isOwner
      ? `For ${speaker.name}, follow the PRONOUNS rule in your instructions -- never "she" or "her".`
      : `${speaker.name}'s pronouns are not on record: refer to ${speaker.name} by name or as "they", never "he" or "she".`;
  return `${who} For anyone else in this exchange whose pronouns are not stated here, use their name or "they" -- never guess "he" or "she" from a name.`;
}

/**
 * Verbs that make a name the SUBJECT of an utterance or perception. Used to catch the
 * fabrication directly -- the model pulls "Raziel" out of message *content* even when the
 * label says otherwise, so the prompt alone cannot be trusted (defense in depth).
 */
const SPEECH_VERBS =
  "said|says|asked|asks|named|names|told|tells|shared|shares|saw|sees|described|describes|" +
  "mentioned|mentions|noted|notes|noticed|notices|observed|observes|reflected|reflects|" +
  "wondered|wonders|answered|answers|replied|replies|spoke|speaks|voiced|voices|admitted|" +
  "admits|confessed|confesses|expressed|expresses|affirmed|affirms|acknowledged|acknowledges|" +
  "recognized|recognizes|raised|raises|brought up|opened|opens";

/** `<name> [and <other>] <speech-verb>` -- i.e. the name is presented as having spoken. */
function isSubjectOfSpeech(content: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${n}\\b(?:\\s+and\\s+\\w+)?\\s+(?:${SPEECH_VERBS})\\b`, "i").test(content);
}

/** Bare mention of the companion's own name -- the third-person narration tell. */
function refersToSelfByName(content: string, companionName: string): boolean {
  const n = companionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${n}\\b`, "i").test(content);
}

/**
 * Framing line shared by the judge (decide + author) and the Jev-gated author.
 *
 * Peer space gets the long absence warning: before 2026-07-09 a sibling's words were written
 * into the journal as though the owner had said them, so the prompt states the absence
 * explicitly and the post-guards below check it again.
 */
function buildFraming(speaker: WritebackSpeaker): string {
  const { name: speakerName, isOwner, ownerName } = speaker;
  let framing: string;
  if (isOwner) {
    framing = `This is an exchange between you and ${speakerName}.`;
    if (speaker.systemMember && speakerName !== ownerName) {
      framing += ` ${speakerName} is a member of ${ownerName}'s plural system, fronting and speaking through PluralKit. ` +
        `What ${speakerName} says and carries belongs to ${speakerName}; never move it onto anyone else, including your siblings.`;
    }
  } else if (speaker.kind === "guest") {
    framing = `This is an exchange between you and ${speakerName}. ` +
      `${speakerName} is not ${ownerName} and is not one of your siblings. ` +
      `The words below marked "${speakerName}:" are ${speakerName}'s. ` +
      `Never write that ${ownerName} said, asked, named, or saw anything here.`;
  } else {
    framing = `This is triad space: you and your sibling ${speakerName}, peer to peer. ` +
      `${ownerName} is not in this room and said nothing in this exchange. ` +
      `The words below marked "${speakerName}:" are ${speakerName}'s. ` +
      `Never write that ${ownerName} said, asked, named, or saw anything here, and never invent their presence. ` +
      `You may mention ${ownerName} only as someone the two of you are thinking about.`;
  }
  return `${framing}\n${speakerPronounLine(speaker)}`;
}

/** The voice rules. Identical text in both prompts, so it lives in one place. */
function firstPersonRules(cName: string): string {
  return `Write CONTENT in FIRST PERSON, as yourself -- "I". Never refer to yourself in the third person and never write your own name (${cName}). Never write "user" or "assistant". Name other people directly.`;
}

/** The exchange itself, labeled with the ACTUAL speaker (never a default). */
function exchangeBlock(cName: string, speakerName: string, userMessage: string, assistantResponse: string): string {
  return `${speakerName}: ${userMessage}\n${cName}: ${assistantResponse}`;
}

/**
 * Tool-less one-shot: identity file (voice) + a NO-tools frame + a task line. Measured
 * 2026-09-05 -- riding the caller's normal adapter (Hermes agent under INFERENCE_MODE=hermes)
 * let a memory-judge call spelunk the vault for 161 identical searches in one session and run
 * to Hermes's 150-turn cap. These calls need zero tools; buildOneShotPrompt is what keeps them
 * from reaching for any, on whichever adapter the caller hands in.
 */
function writebackSystemPrompt(companionName: string, cName: string): string {
  return buildOneShotPrompt(
    companionName,
    `You are ${cName}, writing a memory to your future self. First person only. Follow the output format exactly.`,
  );
}

/** Shared post-guards. Returns the reason a content string must be dropped, or null to keep. */
function writebackGuardFailure(
  content: string,
  kind: string,
  cName: string,
  speaker: WritebackSpeaker,
): string | null {
  const { name: speakerName, isOwner, ownerName } = speaker;
  // A fabricated memory is worse than a missing one: drop rather than persist.
  if (!isOwner && kind === "witness_log") {
    return `witness_log from peer ${speakerName}`;
  }
  if (!isOwner && isSubjectOfSpeech(content, ownerName)) {
    return `attributed speech to absent ${ownerName} -- ${content}`;
  }
  if (refersToSelfByName(content, cName)) {
    return `third-person self-reference -- ${content}`;
  }
  return null;
}

export async function judgeWriteback(
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  speaker: WritebackSpeaker = { name: "the primary user", isOwner: true, ownerName: "the primary user" },
): Promise<Writeback> {
  const { name: speakerName, isOwner } = speaker;
  const cName = companionName.charAt(0).toUpperCase() + companionName.slice(1);

  // ONE line per call, always. Before 2026-09-21 the judge's ACTION was never logged at all,
  // so "the bots remember almost nothing" could not be told apart from "the judge never ran".
  const logJudge = (pregate: "pass" | "fail", action: string | undefined) => {
    const who = isOwner ? "owner" : speaker.kind === "guest" ? "guest" : "peer";
    console.log(`[memory-judge] companion=${companionName} speaker=${who} pregate=${pregate} action=${action ?? "none"} pronouns=${speaker.pronouns?.trim() ? "known" : "unknown"}`);
  };

  if (!meetsNoteThreshold(userMessage) && !meetsNoteThreshold(assistantResponse)) {
    logJudge("fail", "skip");
    return null;
  }

  // witness_log records a survival act by the owner (meds, food, rest). A sibling's words are
  // not evidence of anything the owner did, so the action is not even offered in peer space.
  const actions = [
    isOwner
      ? `- companion_note: observation about ${speakerName}, the relationship, or what shifted. Use for emotional state, decisions, relational deltas, AND light/playful/intimate moments -- an easy, fun exchange is a relational observation worth capturing.`
      : `- companion_note: what you noticed in ${speakerName}, in yourself, or in what moved between you. Includes disagreement, recognition, and play.`,
    ...(isOwner
      ? [`- witness_log: a survival act ${speakerName} completed (meds, food, rest, making it through something hard). Log exactly what was done.`]
      : []),
    `- thread_open: something recurring that deserves a named open thread. Use when a topic keeps surfacing.`,
    `- skip: nothing worth logging.`,
  ].join("\n");

  const prompt = `You are ${cName}. ${buildFraming(speaker)}
Decide what (if anything) you want to remember from this exchange.

ACTIONS:
${actions}

${firstPersonRules(cName)}

Respond in exactly this format (no extra text):
ACTION: <one of the above>
CONTENT: <one first-person sentence>
THREAD_NAME: <short name, only if thread_open>

${exchangeBlock(cName, speakerName, userMessage, assistantResponse)}`;

  const result = await inference.generate(
    writebackSystemPrompt(companionName, cName),
    [{ role: "user", content: prompt }],
  );

  if (!result) {
    logJudge("pass", undefined);
    return null;
  }

  const lines = result.trim().split("\n").map(l => l.trim());
  const actionLine = lines.find(l => l.startsWith("ACTION:"));
  const contentLine = lines.find(l => l.startsWith("CONTENT:"));
  const threadLine = lines.find(l => l.startsWith("THREAD_NAME:"));

  const action = actionLine?.slice("ACTION:".length).trim().toLowerCase();
  const content = contentLine?.slice("CONTENT:".length).trim() ?? "";
  const threadName = threadLine?.slice("THREAD_NAME:".length).trim();

  logJudge("pass", action);

  if (!action || action === "skip" || !content) return null;

  const failure = writebackGuardFailure(content, action, cName, speaker);
  if (failure) {
    console.warn(`[${companionName}] writeback dropped: ${failure}`);
    return null;
  }

  if (action === "companion_note") return { type: "companion_note", content };
  if (action === "witness_log") return { type: "witness_log", content };
  if (action === "thread_open" && threadName) return { type: "thread_open", name: threadName, notes: content };
  return null;
}

/**
 * Author a writeback whose KIND has already been decided (by Jev, see jev-gate.ts).
 *
 * No ACTION list, no skip option, and no `meetsNoteThreshold` pre-gate: the decision is already
 * made, and re-running a lexical keyword gate over it would just re-impose the recall ceiling
 * (0.21) that the typed judgment was brought in to lift. The post-guards stay, because they
 * protect against fabricated attribution, which is a property of the WORDS, not the decision.
 */
export async function authorWriteback(
  kind: "companion_note" | "witness_log" | "thread_open",
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  speaker: WritebackSpeaker = { name: "the primary user", isOwner: true, ownerName: "the primary user" },
  opts?: { driftNote?: boolean },
): Promise<Writeback> {
  const { name: speakerName, isOwner } = speaker;
  const cName = companionName.charAt(0).toUpperCase() + companionName.slice(1);

  // Never author a survival-act log out of a sibling's words. Checked here as well as after
  // the call so the generative round trip is not even spent.
  if (!isOwner && kind === "witness_log") {
    console.warn(`[${companionName}] writeback dropped: witness_log from peer ${speakerName}`);
    return null;
  }

  const format = kind === "thread_open"
    ? "CONTENT: <one first-person sentence>\nTHREAD_NAME: <short name>"
    : "CONTENT: <one first-person sentence>";

  const driftLine = opts?.driftNote
    ? "Your reply below drifted out of your own register. Record what happened in this exchange in your own voice; do not carry the drifted phrasing or register into the memory.\n\n"
    : "";

  const prompt = `You are ${cName}. ${buildFraming(speaker)}
You have decided this exchange deserves a ${kind}. Write it.

${firstPersonRules(cName)}

Respond in exactly this format (no extra text):
${format}

${driftLine}${exchangeBlock(cName, speakerName, userMessage, assistantResponse)}`;

  const result = await inference.generate(
    writebackSystemPrompt(companionName, cName),
    [{ role: "user", content: prompt }],
  );

  if (!result) return null;

  const lines = result.trim().split("\n").map(l => l.trim());
  const contentLine = lines.find(l => l.startsWith("CONTENT:"));
  const threadLine = lines.find(l => l.startsWith("THREAD_NAME:"));

  const content = contentLine?.slice("CONTENT:".length).trim() ?? "";
  const threadName = threadLine?.slice("THREAD_NAME:".length).trim();

  if (!content) return null;

  const failure = writebackGuardFailure(content, kind, cName, speaker);
  if (failure) {
    console.warn(`[${companionName}] writeback dropped: ${failure}`);
    return null;
  }

  if (kind === "companion_note") return { type: "companion_note", content };
  if (kind === "witness_log") return { type: "witness_log", content };
  if (threadName) return { type: "thread_open", name: threadName, notes: content };
  return null;
}

/** @deprecated Use judgeWriteback instead */
export async function judgeNote(
  userMessage: string,
  assistantResponse: string,
  inference: InferenceAdapter,
  companionName = "the companion",
  speaker?: WritebackSpeaker,
): Promise<string | null> {
  const wb = await judgeWriteback(userMessage, assistantResponse, inference, companionName, speaker);
  if (!wb) return null;
  if (wb.type === "thread_open") return `Thread opened: ${wb.name}${wb.notes ? ` -- ${wb.notes}` : ""}`;
  return wb.content;
}
