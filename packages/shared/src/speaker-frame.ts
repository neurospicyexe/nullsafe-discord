// packages/shared/src/speaker-frame.ts
//
// The last line of every live guild turn (2026-10-11, Raziel's go). Research read
// (Hand-off/RESEARCH-group-room-rendering-2026-10-11.md): models track WHAT was said far better than
// WHO said it, and are near chance at implicit addressee recognition, so the seat has to be named
// right before the reply, not only at the top of the turn. SillyTavern's group chat does the same with
// a per-turn nudge naming the speaker. Before this, the turn ended on whichever block was appended last
// (watchalong, B32, cross-room) and 2026-10-11 12:50 Drevan answered Raziel's "Dre" by calling Raziel
// "Dre".
//
// Env: SPEAKER_FRAME=off (off/0/false/no, trimmed, any case) removes it. Default ON.

const CANON: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

export function speakerFrameOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["SPEAKER_FRAME"] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

/**
 * `[You are Drevan. You are answering Crash, who called you "Dre" (your name, not theirs). Cypher and
 * Gaia are your siblings, not you. Reply only as yourself.]`
 * `speaker` is the live turn's label (STM authorName); omitted when unknown. `calledAs` only when the
 * speaker used one of this companion's names.
 */
export function speakerFrame(companionId: string, speaker: string | undefined, calledAs: string | null): string {
  const self = CANON[companionId] ?? companionId;
  const siblings = Object.keys(CANON).filter(c => c !== companionId).map(c => CANON[c]!);
  const sibs = siblings.length === 2 ? `${siblings[0]} and ${siblings[1]} are your siblings` : `${siblings.join(", ")} are your siblings`;
  const who = speaker
    ? ` You are answering ${speaker}${calledAs ? `, who called you "${calledAs}" (your name, not theirs)` : ""}.`
    : "";
  return `[You are ${self}.${who} ${sibs}, not you. Reply only as yourself.]`;
}
