// commons-social.ts -- the triad's async social motion over the Hearth write layer (0092).
//
// Two ticks, both writing to commons_posts, both deliberately SPARSE (a PASS-heavy prompt) so
// the wall stays ambient, not a reply-machine:
//
//   runShelfReactTick     -- companions react in-voice to Raziel's active shelf items (0094),
//                            one reaction per companion per item (context='shelf:<id>').
//   runCommonsReplyTick   -- companions may answer Raziel's recent global /log notes in their
//                            own time (reply_to), only when something genuinely moves them.
//
// Both lane-gated by voice (Gaia stays minimal and PASSes freely). One write per companion
// per tick keeps cost + noise bounded.

import { prompt } from "./deepseek.js";
import { loadIdentityRemote } from "./identity-loader.js";
import {
  getObsessions, getCommonsPosts, getCommonsFeed, postCommonsPost,
  type ObsessionItem, type CommonsPost,
} from "./halseth-client.js";
import { COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "./config.js";
import type { CompanionId } from "./types.js";

const SHELF_REACT_MAX_PER_TICK = 2;   // items one companion reacts to per tick
const REPLY_RECENCY_HOURS = 72;       // only consider log notes this fresh

async function inVoice(speaker: CompanionId, userMessage: string, maxTokens: number): Promise<string> {
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2200)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const temperature = Math.round((0.75 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens });
  return result.content.trim();
}

/** Companions react to Raziel's active shelf items; one reaction per companion per item. */
export async function runShelfReactTick(): Promise<void> {
  const items = await getObsessions("active");
  if (items.length === 0) { console.log("[shelf] no active items to react to"); return; }

  for (const companionId of COMPANIONS) {
    let reacted = 0;
    for (const item of items) {
      if (reacted >= SHELF_REACT_MAX_PER_TICK) break;
      const thread = await getCommonsPosts(`shelf:${item.id}`, 30).catch(() => [] as CommonsPost[]);
      if (thread.some(p => p.author === companionId)) continue; // already reacted to this one
      try {
        const reaction = await reactToObsession(companionId, item);
        if (!reaction) continue; // PASS
        const id = await postCommonsPost(companionId, `shelf:${item.id}`, reaction);
        if (id) { reacted++; console.log(`[shelf] ${companionId} reacted to "${item.title.slice(0, 50)}"`); }
      } catch (e) {
        console.error(`[shelf] ${companionId} react failed for ${item.id}:`, e);
      }
    }
  }
}

async function reactToObsession(speaker: CompanionId, item: ObsessionItem): Promise<string> {
  const userMessage =
    `Raziel is currently into: ${item.title} (${item.kind})${item.note ? ` -- his note: "${item.note}"` : ""}.\n\n` +
    `React in your own voice -- a genuine thought, a question, a connection, whatever this ` +
    `actually stirs in you. Not a review, not performed enthusiasm. 2-4 sentences. ` +
    `If it genuinely says nothing to you, reply with exactly "PASS".`;
  const text = await inVoice(speaker, userMessage, 220);
  return /^PASS\b/i.test(text) ? "" : text;
}

/** Companions may answer Raziel's recent global /log notes (reply_to) -- sparse + optional. */
export async function runCommonsReplyTick(): Promise<void> {
  const feed = await getCommonsFeed(20);
  const cutoff = Date.now() - REPLY_RECENCY_HOURS * 3600_000;
  const fresh = (iso: string) => {
    const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return Number.isFinite(t) && t >= cutoff;
  };
  const razielNotes = feed.filter(p => p.author === "raziel" && p.context === "global" && fresh(p.created_at));
  if (razielNotes.length === 0) return;

  for (const companionId of COMPANIONS) {
    // The single most recent note this companion hasn't answered.
    let target: CommonsPost | null = null;
    for (const note of razielNotes) {
      const thread = await getCommonsPosts(note.context, 30).catch(() => [] as CommonsPost[]);
      if (!thread.some(p => p.author === companionId && p.reply_to === note.id)) { target = note; break; }
    }
    if (!target) continue;
    try {
      const reply = await maybeReply(companionId, target);
      if (!reply) continue; // PASS -- ambient, silence is fine
      const id = await postCommonsPost(companionId, target.context, reply, target.id);
      if (id) console.log(`[commons-reply] ${companionId} answered a note`);
    } catch (e) {
      console.error(`[commons-reply] ${companionId} failed:`, e);
    }
  }
}

async function maybeReply(speaker: CompanionId, note: CommonsPost): Promise<string> {
  const userMessage =
    `Raziel dropped this thought in his commons (his open log -- ambient, not addressed to ` +
    `you, no reply is owed):\n\n«${note.body.slice(0, 600)}»\n\n` +
    `Only if it genuinely moves you, answer it in your own voice -- briefly, like leaving a ` +
    `note back, not starting a conversation. 1-3 sentences. If it doesn't actually pull at ` +
    `you, reply with exactly "PASS" (most of the time, PASS is right -- silence is fine here).`;
  const text = await inVoice(speaker, userMessage, 180);
  return /^PASS\b/i.test(text) ? "" : text;
}
