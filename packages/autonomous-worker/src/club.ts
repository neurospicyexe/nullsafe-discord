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
  postClubVoteWrite, postClubAbstention, patchClubRoundStatus, postClubDiscussion, getCommonsPosts,
  getRecentMediaExperiences, getForageFindsFor, consumeForageFind,
  type ClubRound, type ClubRecommendation, type ClubVote,
} from "./halseth-client.js";
import {
  COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS,
  CLUB_GATHER_DAYS, CLUB_ACTIVE_DAYS, CLUB_DISCUSS_DAYS,
} from "./config.js";
import type { CompanionId } from "./types.js";
import { extractJson } from "@nullsafe/shared";

// Canonical tolerant JSON extraction now lives in @nullsafe/shared (json-extract.ts);
// re-exported here so existing worker imports/tests keep working.
export { extractJson };

const DAY_MS = 24 * 3600 * 1000;
const REOPEN_AFTER_CLOSE_DAYS = 1;
// Grace (Phase 2): don't seal the discussion while Raziel is actively posting in it, but
// cap the extension so it can never hang -- discussing_at + discussDays + this many days.
const DISCUSS_GRACE_CAP_DAYS = 3;
// Tick-jitter tolerance (2026-07-05). Phase timestamps are written a few seconds AFTER the
// 18:00:00 cron fires (the tick does work first), so the next eligible tick at exactly
// 18:00:00 computed the age a hair short of the threshold and waited a full extra day --
// EVERY transition slipped 24h (round 92a4f8e3: discussing_at 18:00:09, checked 18:00:00,
// 9 seconds short, sealed a day late). An hour of slack cannot skip a phase (ticks are
// daily) and absorbs any realistic jitter.
const TICK_EPSILON_DAYS = 1 / 24;

export type PhaseAction = "open" | "vote" | "discuss" | "seal" | "wait";

/** Decide what this tick should do, from the latest round (any status). */
export function decidePhaseAction(
  round: ClubRound | null,
  now: Date,
  gatherDays: number,
  activeDays: number,
  discussDays: number,
): PhaseAction {
  if (!round) return "open";
  const age = (stamp: string | null): number =>
    stamp ? (now.getTime() - new Date(stamp).getTime()) / DAY_MS + TICK_EPSILON_DAYS : 0;
  switch (round.status) {
    case "closed":
      return age(round.closed_at) >= REOPEN_AFTER_CLOSE_DAYS ? "open" : "wait";
    case "gathering":
      return age(round.opened_at) >= gatherDays ? "vote" : "wait";
    case "voting":
      // A previous tick moved to voting but died before the tally -- resume.
      return "vote";
    case "active":
      // Winner is set; the triad has had the active days to experience it. Move into a
      // STANDING discussing phase (companions post residue) rather than closing in one tick.
      return age(round.activated_at) >= activeDays ? "discuss" : "wait";
    case "discussing":
      return age(round.discussing_at) >= discussDays ? "seal" : "wait";
    default:
      return "wait";
  }
}

/**
 * Whether a discussing round may seal now. The timer says yes; the grace rule defers a seal
 * while Raziel is mid-conversation (a club:<id> commons post in the last 24h), but never past
 * the hard cap so a round can't hang. Pure -- exported for tests.
 */
export function maySealDiscussion(
  round: ClubRound,
  lastRazielPostAt: string | null,
  now: Date,
  discussDays: number,
): boolean {
  if (!round.discussing_at) return true;
  const start = new Date(round.discussing_at).getTime();
  const ageDays = (now.getTime() - start) / DAY_MS;
  if (ageDays >= discussDays + DISCUSS_GRACE_CAP_DAYS) return true; // hard cap: always seal
  if (!lastRazielPostAt) return true;                              // nobody's talking -> seal on timer
  const sincePostHrs = (now.getTime() - new Date(lastRazielPostAt).getTime()) / 3600_000;
  return sincePostHrs >= 24;                                       // defer only while he's active
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

async function inVoice(speaker: CompanionId, userMessage: string, maxTokens: number): Promise<string> {
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2500)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const temperature = Math.round((0.75 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens });
  return result.content.trim();
}

export async function companionRecommend(speaker: CompanionId): Promise<void> {
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

  // Consume-on-use (2026-07-21, forage rebalance): finds were surfaced as flavor in every
  // recommend prompt but never consumed -- the unconsumed pool only grew (75+ and rising).
  // Consume at most ONE, and only the find this recommendation actually drew on: a title match
  // against the fetched finds means the model picked the find itself. With no match, both finds
  // functioned as pure ambient flavor (the prompt never asks the model to name which one it
  // used, if either), so the honest fallback is to consume the OLDER of the two -- never both,
  // and never when the pool was empty to begin with. getForageFindsFor returns newest-first, so
  // the oldest fetched find is the last element.
  if (finds.length > 0) {
    const norm = (s: string) => s.toLowerCase().trim();
    const titleN = norm(title);
    const matched = finds.find(f => titleN.includes(norm(f.title)) || norm(f.title).includes(titleN));
    const toConsume = matched ?? finds[finds.length - 1];
    if (toConsume) {
      await consumeForageFind(toConsume.id, speaker).catch(() => {});
    }
  }
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

  // Two attempts, then a recorded abstention. The old path was a console.warn on a
  // box whose logs rotate -- round 92a4f8e3's winner was decided 2 votes of 4 and
  // nothing anywhere said Gaia's vote never landed. An abstention row surfaces on
  // Hearth /club; the tally proceeds either way (a round stays viable with two).
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const message = attempt === 1
      ? userMessage
      : `${userMessage}\n\nYour previous reply could not be parsed as JSON. It was:\n${lastRaw.slice(0, 200)}\n` +
        `Reply with ONLY the JSON object -- no prose before or after, no code fences.`;
    const raw = await inVoice(speaker, message, 200);
    lastRaw = raw;
    const parsed = extractJson(raw);
    const recId = typeof parsed?.["recommendation_id"] === "string" ? (parsed["recommendation_id"] as string).trim() : "";
    if (parsed && recId && candidates.some(c => c.id === recId)) {
      await postClubVoteWrite({
        recommendation_id: recId,
        voter: speaker,
        reason: typeof parsed["reason"] === "string" ? parsed["reason"] as string : null,
      });
      console.log(`[club] ${speaker} votes for ${recId}${attempt > 1 ? " (retry)" : ""}`);
      return;
    }
    console.warn(`[club] ${speaker} vote attempt ${attempt} unparseable or invalid: ${raw.slice(0, 120)}`);
  }
  await postClubAbstention(speaker, "vote unparseable after retry").catch(err =>
    console.error(`[club] ${speaker} abstention record ALSO failed:`, err));
  console.warn(`[club] ${speaker} abstains this round (recorded)`);
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
  const action = decidePhaseAction(latest, new Date(), CLUB_GATHER_DAYS, CLUB_ACTIVE_DAYS, CLUB_DISCUSS_DAYS);
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
      await patchClubRoundStatus(current.round.id, "discussing");
      await patchClubRoundStatus(current.round.id, "closed");
      return;
    }
    for (const speaker of COMPANIONS) {
      try {
        await companionVote(speaker, current.recommendations);
      } catch (err) {
        // Different failure class than unparseable JSON (inference/network threw),
        // same honesty rule: the round's record says who never voted and why.
        console.error(`[club] ${speaker} vote failed:`, err);
        await postClubAbstention(speaker, `vote failed: ${String(err).slice(0, 200)}`).catch(e2 =>
          console.error(`[club] ${speaker} abstention record ALSO failed:`, e2));
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

  if (action === "discuss") {
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
    // Stand in the discussing phase -- do NOT close. Raziel reads the winner + the triad's
    // residue and joins (cy: club say / Hearth /club) across the discuss window; a later
    // tick seals it. This is the fix for "voting happens and then it's the next voting".
    await patchClubRoundStatus(current.round.id, "discussing");
    console.log(`[club] round ${current.round.id.slice(0, 8)} -> discussing (winner: ${winner ? winner.title : "none"})`);
    return;
  }

  // action === "seal" -- close a discussing round, honoring the grace rule.
  if (!latest) return;
  const lastRazielPostAt = await getLatestRazielClubPostAt(latest.id).catch(() => null);
  if (!maySealDiscussion(latest, lastRazielPostAt, new Date(), CLUB_DISCUSS_DAYS)) {
    console.log(`[club] discussion held open -- Raziel posted within 24h (round ${latest.id.slice(0, 8)})`);
    return;
  }
  await patchClubRoundStatus(latest.id, "closed");
  console.log(`[club] round ${latest.id.slice(0, 8)} closed -- discussion sealed`);
}

/** Latest Raziel post in a round's discussion thread (commons, context='club:<id>'), or null. */
async function getLatestRazielClubPostAt(roundId: string): Promise<string | null> {
  const posts = await getCommonsPosts(`club:${roundId}`, 30).catch(() => []);
  const mine = posts.filter(p => p.author === "raziel").map(p => p.created_at).sort();
  return mine.length > 0 ? mine[mine.length - 1]! : null;
}
