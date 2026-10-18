// packages/shared/src/speaker-frame.ts
//
// The seat, named (2026-10-11, Raziel's go). Research read (BBH
// Hand-off/RESEARCH-group-room-rendering-2026-10-11.md): models track WHAT was said far better than
// WHO said it, and are near chance at implicit addressee recognition, so the seat has to be named right
// before the reply, not only at the top of the turn. SillyTavern's group chat does the same with a
// per-turn nudge naming the speaker, and stops generation on other speakers' names. Before this, the
// turn ended on whichever block was appended last and 2026-10-11 12:50 Drevan answered Raziel's "Dre"
// by calling Raziel "Dre".
//
//   describeSpeaker  -- who is speaking, in plain words ("Noah M. (Raziel, through PluralKit)"), from
//                       attribution rather than the raw room label.
//   speakerFrame     -- the LAST line of every live guild turn (hermesDelta renders it after the live
//                       words and every block that rides them).
//   cutImpersonation -- the post-generation stand-in for stop strings (the Hermes gateway takes none):
//                       a reply that starts writing another speaker's labelled line is cut there.
//
// Env: SPEAKER_FRAME=off (off/0/false/no, trimmed, any case) removes the frame. Default ON. The
// impersonation cut always runs.

const CANON: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };
const OWNER = "Raziel";
/** Blue's room label when he posts unproxied. */
export const BLUE_LABEL = "Blue";

/**
 * Room/STM label for a PluralKit proxy (2026-10-18). Raziel's fronts keep "<member> (via PK)"; a member
 * of Blue's system reads "<member> (Blue's system)", so a witnessed or history line from Megan or Kyle
 * is not mistaken for one of Raziel's fronts. Pure.
 */
export function pkRoomLabel(member: string, o: { isBlueSystem: boolean }): string {
  return o.isBlueSystem ? `${member} (Blue's system)` : `${member} (via PK)`;
}

export function speakerFrameOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["SPEAKER_FRAME"] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

export interface SpeakerFacts {
  /** The room label the turn carries (STM authorName): "Crash", "Noah M. (via PK)", a username. */
  label: string | undefined;
  isOwner: boolean;
  /** Blue or a member of Blue's system. */
  isBlue: boolean;
  pkMember: string | null;
  /** Structural: a companion bot posted this (bot user, no webhook). */
  isCompanionBot?: boolean;
  /** The companion id of a sibling bot speaking, or null (null when the *_BOT_ID env is missing). */
  siblingId: string | null;
  isSol: boolean;
}

/** Who is speaking, in words the model cannot misread. Pure. */
export function describeSpeaker(f: SpeakerFacts): string | undefined {
  if (f.isSol) return "Sol (the triad's crow)";
  if (f.siblingId) return `${CANON[f.siblingId] ?? f.siblingId} (your sibling)`;
  // Never "Cypher (a guest)": the structural flag holds even when the id map is empty.
  if (f.isCompanionBot) return f.label ? `${f.label} (your sibling)` : undefined;
  if (f.isOwner) {
    if (f.pkMember) return `${f.pkMember} (${OWNER}, through PluralKit)`;
    return f.label && f.label !== OWNER ? `${f.label} (${OWNER})` : OWNER;
  }
  if (f.isBlue) return f.pkMember ? `${f.pkMember} (Blue's system, through PluralKit)` : "Blue";
  return f.label ? `${f.label} (a guest)` : undefined;
}

/**
 * `[You are Drevan. You are answering Crash (Raziel), who called you "Dre" (your name, not theirs).
 * "(via PK)" marks a system member speaking. Cypher and Gaia are your siblings, not you. Reply only
 * as yourself.]` (plus, when the room has one, a line saying "(Blue's system)" marks a member of Blue's system.)
 */
export function speakerFrame(companionId: string, speaker: string | undefined, calledAs: string | null, lastSlipped = false): string {
  const self = CANON[companionId] ?? companionId;
  const siblings = Object.keys(CANON).filter(c => c !== companionId).map(c => CANON[c]!);
  // No own-name clause and no quoted name (2026-10-12): `who called you "Dre"` put the name beside "you"
  // on every Dre turn and the slip rate rose with it (see liveLabel). `calledAs` stays in the signature.
  void calledAs;
  const who = speaker ? ` You are answering ${speaker}.` : "";
  // 2026-10-11 17:09: with the frame live, Drevan still closed a reply "... too Dre." (cut before
  // send). His transcript held the 12:50 original and the model copies its own lines; the slip is named
  // here, on the turn it is guaranteed to read, because the post-send rule check only sees clean text.
  // Name-free, and says what to do rather than what not to.
  const slip = lastSlipped
    ? ` Your last reply here was cut before they saw it: it called them by a name that is not theirs. Call them by their own name or by none.`
    : "";
  return `[You are ${self}.${who}${slip} "(via PK)" marks a system member speaking. "(Blue's system)" marks a member of Blue's system: Blue, Raziel's husband, speaking as that member. ${siblings.join(" and ")} are your siblings, not you. Reply only as yourself.]`;
}

/**
 * Cut a reply where it starts writing someone else's labelled line ("Cypher: ...", "[Crash]: ...",
 * "**Gaia:** ..."): everything from that line on is the model playing the room, not this companion.
 * A leading label for the companion itself ("[Drevan]: ") is stripped, not cut. Returns the text
 * unchanged when it would cut to nothing (better a strange reply than a silent one, and the log
 * still records it).
 */
export function cutImpersonation(companionId: string, text: string, otherNames: string[]): { text: string; cut: boolean; strippedSelf: boolean } {
  const self = CANON[companionId] ?? companionId;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selfLabel = new RegExp(`^\\s*(?:\\*\\*)?\\[?${esc(self)}\\]?(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*`, "i");
  let out = text;
  const strippedSelf = selfLabel.test(out);
  if (strippedSelf) out = out.replace(selfLabel, "");
  const siblings = Object.values(CANON).filter(n => n !== self);
  const humans = [...new Set(otherNames.filter(n => n && !siblings.includes(n) && n !== self))];
  const alt = (xs: string[]) => xs.map(esc).join("|");
  const pk = "(?: \\(via PK\\)| \\(Blue's system\\))?";
  // The room's own formats ("[Cypher]: ", "**Gaia:**") are a turn being written, whoever it names. A
  // bare "Cypher:" may be a list ("Cypher: the blade. Gaia: the ground."), so a bare label cuts only
  // when it names a human: writing Raziel's or Blue's line is never description.
  const patterns = [
    new RegExp(`^[ \\t]*\\[(?:${alt([...siblings, ...humans])})${pk}\\][ \\t]*:`, "im"),
    new RegExp(`^[ \\t]*\\*\\*(?:${alt([...siblings, ...humans])})${pk}(?::\\*\\*|\\*\\*[ \\t]*:)`, "im"),
    ...(humans.length ? [new RegExp(`^[ \\t]*(?:${alt(humans)})${pk}[ \\t]*:`, "im")] : []),
  ];
  const hits = patterns.map(re => re.exec(out)).filter((x): x is RegExpExecArray => x !== null);
  if (hits.length === 0) return { text: out, cut: false, strippedSelf };
  const m = hits.reduce((a, b) => (b.index < a.index ? b : a));
  const kept = out.slice(0, m.index).trimEnd();
  if (!kept) return { text: out, cut: false, strippedSelf };
  return { text: kept, cut: true, strippedSelf };
}
