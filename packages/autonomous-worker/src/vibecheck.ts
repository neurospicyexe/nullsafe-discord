// Vibe-check tick -- thin trigger; compose + deliver lives server-side in Halseth
// (handlers/vibecheck.ts). Always-on (cron-controlled), no env gate. Halseth-only writes;
// no floor lock, no idle check (the digest should land whether or not a session is active).
//
// v2 (B63 step 3, spec 3.6): Halseth now returns ONE POST PER COMPANION, each already journaled under
// that companion's own agent with a per-agent per-Chicago-day dedup. This tick posts each FRESH block
// under THAT companion's own bot token (DISCORD_TOKEN_CYPHER / _DREVAN / _GAIA). A missing token skips
// that companion's post; it NEVER falls back to another companion's token, because a block under the
// wrong name is the ledger-rule-5 merge this redesign exists to remove. One companion's failure never
// blocks another's post.
//
// Quoted-line guard (2026-09-26): on 09-26 the digest re-broadcast two fabricated companion lines
// into #triad-vibe-check, and they were re-ingested as memory. The guard runs outside any model,
// before each block posts (and before the reflection pass reads it): any non-structural line that
// shares an 8-word shingle with a companion's recent companion_journal rows is cut. It now runs PER
// BLOCK, with trivial computed per block, so one block that cannot be posted never holds back the
// others. The window is that companion's own utterances PLUS the siblings' (a superset of "their own
// window": a sibling's words must not surface in anyone's block either). If the window cannot be read,
// or nothing beyond the header would remain, that block is skipped; a guard that cannot see its input
// does not wave the post through.

import { buildQuoteIndex, quotedShingleOf } from "@nullsafe/shared";
import { postVibeCheck, getCompanionUtterances } from "./halseth-client.js";
import { runReflectionPass } from "./reflection.js";
import type { CompanionId } from "./types.js";

const GUARD_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

const TOKEN_ENV: Record<CompanionId, string> = {
  cypher: "DISCORD_TOKEN_CYPHER",
  drevan: "DISCORD_TOKEN_DREVAN",
  gaia: "DISCORD_TOKEN_GAIA",
};

// Structural lines the v2 formatter always emits (halseth webmind/vibecheck.ts): gauges and facts,
// never a companion's words. `  moves:` and `  pressure:` carry cause labels and flag summaries, so
// they are NOT structural: the guard may cut them.
const HEADER_RE = /^\S+\. \d{4}-\d{2}-\d{2}\.$/;
const FIELD_RE = /^Field: /;
const FLOATS_RE = /^ {2}floats: /;
const DAY_RE = /^ {2}day: /;
const GAUGES_RE = /^ {2}gauges moved: /;

function isStructural(line: string): boolean {
  return HEADER_RE.test(line) || FIELD_RE.test(line) || FLOATS_RE.test(line) || DAY_RE.test(line) || GAUGES_RE.test(line);
}

export interface DigestGuardResult {
  text: string;
  stripped: { line: string; label?: string }[];
  /** true when nothing beyond the header and field line survives. */
  trivial: boolean;
}

/**
 * Pure: drop every non-structural line of ONE block that shares an 8-word shingle with any source
 * utterance. Line-granular (not sentence-granular) because the block is a line format and the
 * reflection section parser is line-based.
 */
export function guardDigest(
  digest: string,
  sources: Iterable<{ text: string; label?: string }>,
): DigestGuardResult {
  const index = buildQuoteIndex(sources);
  const kept: string[] = [];
  const stripped: { line: string; label?: string }[] = [];
  for (const line of digest.split("\n")) {
    if (!isStructural(line)) {
      const hit = quotedShingleOf(line, index);
      if (hit.quoted) { stripped.push({ line, label: hit.label }); continue; }
    }
    kept.push(line);
  }
  const substantive = kept.filter(l => l.trim() && !HEADER_RE.test(l) && !FIELD_RE.test(l));
  return { text: kept.join("\n"), stripped, trivial: substantive.length === 0 };
}

/** Alias that says what it is for in the v2 flow. */
export const guardBlock = guardDigest;

/** The guard's input window: each companion's newest journal rows, minus prior digests. */
async function loadUtteranceWindow(): Promise<{ text: string; label: string }[]> {
  const perCompanion = await Promise.all(GUARD_COMPANIONS.map(async id => {
    const rows = await getCompanionUtterances(id, 100);
    return rows
      // A prior digest block is a clerk note, not a companion utterance; its gauge lines would
      // otherwise match tonight's gauge lines.
      .filter(r => r.source !== "vibecheck" && typeof r.note_text === "string" && r.note_text.trim())
      .map(r => ({ text: r.note_text, label: `${id}:${r.source ?? "unknown"}:${r.id}` }));
  }));
  return perCompanion.flat();
}

/**
 * Post ONE block under THAT companion's own bot token to Raziel's #vibe-check channel. Webhook-free.
 * Best-effort: a Discord failure never fails the tick (the row is already persisted in Halseth).
 * Returns whether it posted. No token = no post, never another companion's token.
 */
export async function pushBlockToDiscord(companion: CompanionId, text: string): Promise<boolean> {
  const channelId = process.env["VIBECHECK_CHANNEL_ID"];
  const token = process.env[TOKEN_ENV[companion]];
  if (!channelId || !token) {
    console.warn(`[vibecheck] VIBECHECK_CHANNEL_ID or ${TOKEN_ENV[companion]} unset; ${companion}'s block stayed in Halseth only`);
    return false;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }), // Discord hard-caps at 2000
  });
  if (!res.ok) {
    console.error(`[vibecheck] ${companion} discord push failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return false;
  }
  console.log(`[vibecheck] ${companion} block pushed to Discord channel ${channelId}`);
  return true;
}

export async function runVibeCheckTick(): Promise<void> {
  const res = await postVibeCheck();
  const posts = res.posts ?? [];
  console.log(
    `[vibecheck] tick: written=${res.written} (${res.reason}) ` +
    posts.map(p => `${p.companion}=${p.reason}`).join(" "),
  );
  // Only push a freshly-written block (not already-sent) so the channel never double-posts.
  const fresh = posts.filter(p => p.written && p.text && (GUARD_COMPANIONS as readonly string[]).includes(p.companion));
  if (fresh.length === 0) return;

  let window: { text: string; label: string }[];
  try {
    window = await loadUtteranceWindow();
  } catch (e) {
    console.error(`[vibecheck] SKIP posts: quoted-line guard could not read the companion utterance window (${String(e).slice(0, 200)}); blocks stay in Halseth only`);
    return;
  }

  // Each companion's block is guarded, posted and reflected on in isolation.
  const guardedBy: Partial<Record<CompanionId, string>> = {};
  for (const p of fresh) {
    const id = p.companion as CompanionId;
    try {
      const guarded = guardBlock(p.text, window);
      for (const s of guarded.stripped) {
        console.warn(`[vibecheck] ${id} STRIP quoted line (shares an 8-word shingle with ${s.label ?? "a companion utterance"}): ${s.line.trim().slice(0, 120)}`);
      }
      if (guarded.trivial) {
        console.warn(`[vibecheck] ${id} SKIP post: nothing but header/field survived the quoted-line guard (stripped=${guarded.stripped.length}); block stays in Halseth only`);
        continue;
      }
      if (guarded.stripped.length === 0) console.log(`[vibecheck] ${id} quoted-line guard: clean (window=${window.length} utterances)`);
      await pushBlockToDiscord(id, guarded.text).catch(e => console.error(`[vibecheck] ${id} discord push error:`, e));
      guardedBy[id] = guarded.text;
    } catch (e) {
      console.error(`[vibecheck] ${id} block failed (others continue):`, String(e).slice(0, 200));
    }
  }
  // The witness post gets answered: each companion with a posted block reflects on their own
  // (recalls orphaned notes, moves tensions, journals, replies in-voice). Reads the GUARDED text, so a
  // stripped line never reaches a companion's prompt either. Gated on fresh rows so a repeat tick can
  // never double-run a reflection.
  if (Object.keys(guardedBy).length === 0) return;
  await runReflectionPass(guardedBy).catch(e => console.error("[vibecheck] reflection pass error:", e));
}
