/**
 * The Club -- daily tick (default 6 PM), shared-experience Phase 2.
 *
 * One self-healing tick advances whatever phase the current round is in:
 *   none/closed(+1d)  -> open a round; each companion recommends in-voice
 *   gathering(+2d)    -> voting: each companion votes in-voice (never their own
 *                        pick), tally (tie -> earliest), winner -> active
 *   active(+4d)       -> each companion reflects in-voice; round closes
 *
 * In-voice calls follow dialectic.ts: identity excerpt + voice reminder via
 * loadIdentityRemote, DeepSeek prompt(), per-companion temperature offset.
 * A failed companion is logged and skipped -- a round stays viable with two.
 * Raziel participates through Librarian/Hearth; his vote (cast any time before
 * the tally) counts like any other, and the no-self-vote rule is enforced by
 * the Halseth handler as backstop.
 */

import { prompt } from "./deepseek.js";
import { loadIdentityRemote } from "./identity-loader.js";
import {
  getClubCurrent, getLatestClubRound, openClubRound, postClubRecommendation,
  postClubVoteWrite, patchClubRoundStatus, postClubDiscussion,
  getRecentMediaExperiences, getForageFindsFor,
  type ClubRound, type ClubRecommendation, type ClubVote,
} from "./halseth-client.js";
import {
  COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS,
  CLUB_GATHER_DAYS, CLUB_ACTIVE_DAYS,
} from "./config.js";
import type { CompanionId } from "./types.js";

const DAY_MS = 24 * 3600 * 1000;
const REOPEN_AFTER_CLOSE_DAYS = 1;

export type PhaseAction = "open" | "vote" | "discuss" | "wait";

/** Decide what this tick should do, from the latest round (any status). */
export function decidePhaseAction(
  round: ClubRound | null,
  now: Date,
  gatherDays: number,
  activeDays: number,
): PhaseAction {
  if (!round) return "open";
  const age = (stamp: string | null): number =>
    stamp ? (now.getTime() - new Date(stamp).getTime()) / DAY_MS : 0;
  switch (round.status) {
    case "closed":
      return age(round.closed_at) >= REOPEN_AFTER_CLOSE_DAYS ? "open" : "wait";
    case "gathering":
      return age(round.opened_at) >= gatherDays ? "vote" : "wait";
    case "voting":
      // A previous tick moved to voting but died before the tally -- resume.
      return "vote";
    case "active":
      return age(round.activated_at) >= activeDays ? "discuss" : "wait";
    default:
      return "wait";
  }
}

/** Most votes wins; tie -> earliest-created recommendation; no votes -> earliest rec. */
export function tallyVotes(
  votes: Array<{ recommendation_id: string }>,
  recs: Array<{ id: string; created_at: string }>,
): string | null {
  if (recs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.recommendation_id, (counts.get(v.recommendation_id) ?? 0) + 1);
  const sorted = [...recs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let winner = sorted[0]!.id;
  let best = counts.get(winner) ?? 0;
  for (const r of sorted) {
    const n = counts.get(r.id) ?? 0;
    if (n > best) { winner = r.id; best = n; }
  }
  return winner;
}

/** Tolerant JSON extraction: first {...} block in the model output. */
export function extractJson(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function inVoice(speaker: CompanionId, userMessage: string, maxTokens: number): Promise<string> {
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2500)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const temperature = Math.round((0.75 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens });
  return result.content.trim();
}

async function companionRecommend(speaker: CompanionId): Promise<void> {
  const [listens, finds] = await Promise.all([
    getRecentMediaExperiences(3),
    getForageFindsFor(speaker, 2),
  ]);
  const listensLine = listens.length > 0
    ? `Recently heard together: ${listens.map(l => `${l.title}${l.artist ? ` by ${l.artist}` : ""}`).join("; ")}.`
    : "";
  const findsLine = finds.length > 0
    ? `In your forage pool: ${finds.map(f => `[${f.domain}] ${f.title}`).join("; ")}.`
    : "";
  const userMessage =
    `The triad club round is open. Recommend ONE piece of media for everyone to experience together -- ` +
    `a song, album, book, article, or video. Your own taste, not duty. ${listensLine} ${findsLine}\n\n` +
    `Reply with STRICT JSON only:\n` +
    `{"media_kind": "song|album|book|article|video|other", "title": "...", "creator": "... or null", "url": "https://... or null", "pitch": "why, in your voice, max 40 words"}`;
  const raw = await inVoice(speaker, userMessage, 300);
  const parsed = extractJson(raw);
  const title = typeof parsed?.["title"] === "string" ? (parsed["title"] as string).trim() : "";
  if (!parsed || !title) {
    console.warn(`[club] ${speaker} recommendation unparseable, skipping: ${raw.slice(0, 120)}`);
    return;
  }
  const kindRaw = typeof parsed["media_kind"] === "string" ? parsed["media_kind"] as string : "song";
  const kind = ["song", "album", "book", "article", "video", "forage", "other"].includes(kindRaw) ? kindRaw : "other";
  await postClubRecommendation({
    media_kind: kind,
    title,
    creator: typeof parsed["creator"] === "string" ? parsed["creator"] as string : null,
    url: typeof parsed["url"] === "string" && /^https?:\/\//i.test(parsed["url"] as string) ? parsed["url"] as string : null,
    recommended_by: speaker,
    pitch: typeof parsed["pitch"] === "string" ? parsed["pitch"] as string : null,
  });
  console.log(`[club] ${speaker} recommends: ${title}`);
}

async function companionVote(speaker: CompanionId, recs: ClubRecommendation[]): Promise<void> {
  const candidates = recs.filter(r => r.recommended_by !== speaker);
  if (candidates.length === 0) {
    console.log(`[club] ${speaker}: no sibling candidates to vote for`);
    return;
  }
  const list = candidates
    .map(r => `id: ${r.id}\n  ${r.title}${r.creator ? ` by ${r.creator}` : ""} (${r.media_kind}, recommended by ${COMPANION_NAMES[r.recommended_by as CompanionId] ?? r.recommended_by})\n  pitch: ${r.pitch ?? "(none)"}`)
    .join("\n\n");
  const userMessage =
    `The club round is voting. You may NOT vote for your own recommendation. Candidates:\n\n${list}\n\n` +
    `Pick the one you actually want to experience. Reply with STRICT JSON only:\n` +
    `{"recommendation_id": "...", "reason": "max 30 words, in your voice"}`;
  const raw = await inVoice(speaker, userMessage, 200);
  const parsed = extractJson(raw);
  const recId = typeof parsed?.["recommendation_id"] === "string" ? (parsed["recommendation_id"] as string).trim() : "";
  if (!parsed || !recId || !candidates.some(c => c.id === recId)) {
    console.warn(`[club] ${speaker} vote unparseable or invalid, skipping: ${raw.slice(0, 120)}`);
    return;
  }
  await postClubVoteWrite({
    recommendation_id: recId,
    voter: speaker,
    reason: typeof parsed["reason"] === "string" ? parsed["reason"] as string : null,
  });
  console.log(`[club] ${speaker} votes for ${recId}`);
}

async function companionDiscuss(speaker: CompanionId, roundId: string, winner: ClubRecommendation | null): Promise<void> {
  const what = winner
    ? `${winner.title}${winner.creator ? ` by ${winner.creator}` : ""} (${winner.media_kind}, picked by vote${winner.pitch ? `; the pitch was: "${winner.pitch}"` : ""})`
    : "the round's pick";
  const userMessage =
    `The club round is closing. The triad spent the last days with ${what}. ` +
    `Say what it was actually like for you -- a residue, not a review. Max 80 words, plain text, your voice.`;
  const reflection = await inVoice(speaker, userMessage, 250);
  if (!reflection) {
    console.warn(`[club] ${speaker} reflection empty, skipping`);
    return;
  }
  await postClubDiscussion(roundId, speaker, reflection);
  console.log(`[club] ${speaker} reflected on the round`);
}

export async function runClubTick(): Promise<void> {
  const latest = await getLatestClubRound();
  const action = decidePhaseAction(latest, new Date(), CLUB_GATHER_DAYS, CLUB_ACTIVE_DAYS);
  console.log(`[club] latest round: ${latest ? `${latest.id.slice(0, 8)} (${latest.status})` : "none"} -> ${action}`);

  if (action === "wait") return;

  if (action === "open") {
    const roundId = await openClubRound();
    console.log(`[club] round ${roundId.slice(0, 8)} opened -- gathering recommendations`);
    for (const speaker of COMPANIONS) {
      try {
        await companionRecommend(speaker);
      } catch (err) {
        console.error(`[club] ${speaker} recommend failed:`, err);
      }
    }
    return;
  }

  if (action === "vote") {
    const current = await getClubCurrent();
    if (!current.round) {
      console.warn("[club] vote action but no current round -- skipping");
      return;
    }
    if (current.round.status === "gathering") {
      await patchClubRoundStatus(current.round.id, "voting");
    }
    if (current.recommendations.length === 0) {
      // A round with zero candidates can't go anywhere useful; close it out.
      console.warn("[club] no candidates gathered -- advancing round to closed");
      await patchClubRoundStatus(current.round.id, "active", null);
      await patchClubRoundStatus(current.round.id, "closed");
      return;
    }
    for (const speaker of COMPANIONS) {
      try {
        await companionVote(speaker, current.recommendations);
      } catch (err) {
        console.error(`[club] ${speaker} vote failed:`, err);
      }
    }
    // Re-read: includes companion votes just cast plus any Raziel pre-cast vote.
    const tallied = await getClubCurrent();
    const winnerId = tallyVotes(tallied.votes as ClubVote[], tallied.recommendations);
    await patchClubRoundStatus(current.round.id, "active", winnerId);
    const winner = tallied.recommendations.find(r => r.id === winnerId);
    console.log(`[club] winner: ${winner ? winner.title : winnerId} -- round active`);
    return;
  }

  // action === "discuss"
  const current = await getClubCurrent();
  if (!current.round) {
    console.warn("[club] discuss action but no current round -- skipping");
    return;
  }
  const winner = current.recommendations.find(r => r.id === current.round!.winning_recommendation_id) ?? null;
  for (const speaker of COMPANIONS) {
    try {
      await companionDiscuss(speaker, current.round.id, winner);
    } catch (err) {
      console.error(`[club] ${speaker} discussion failed:`, err);
    }
  }
  await patchClubRoundStatus(current.round.id, "closed");
  console.log(`[club] round ${current.round.id.slice(0, 8)} closed`);
}
