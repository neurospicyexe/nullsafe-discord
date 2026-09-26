// Vibe-check tick -- thin trigger; compose + deliver lives server-side in Halseth
// (handlers/vibecheck.ts). Always-on (cron-controlled), no env gate. Halseth-only writes;
// no floor lock, no idle check (the digest should land whether or not a session is active).
//
// Server-side dedup makes at most one vibe-check per day, so a missed or duplicate tick is harmless.
//
// Quoted-line guard (2026-09-26): on 09-26 the digest re-broadcast two fabricated companion lines
// into #triad-vibe-check, and they were re-ingested as memory. Raziel: Gaia's digest does not
// repeat companion lines. Halseth stopped gathering utterance text (halseth 462b843); this is the
// second, model-free layer: before the digest posts (and before the reflection pass reads it),
// any line that shares an 8-word shingle with a companion's recent companion_journal rows is cut.
// Gauge lines (header, `<Name>. basin:`, `  day:`, `Field:`) are structural and never cut. If the
// window cannot be read, or nothing but the header and field line would remain, the post is
// skipped -- a guard that cannot see its input does not wave the post through.

import { buildQuoteIndex, quotedShingleOf } from "@nullsafe/shared";
import { postVibeCheck, getCompanionUtterances } from "./halseth-client.js";
import { runReflectionPass } from "./reflection.js";

const GUARD_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

const HEADER_RE = /^The triad, witnessed\./;
const FIELD_RE = /^Field: /;
const GAUGE_RE = /^\S+\. basin: /;
const DAY_RE = /^ {2}day: /;

/** Structural lines the formatter always emits; they carry gauges, never a companion's words. */
function isStructural(line: string): boolean {
  return HEADER_RE.test(line) || FIELD_RE.test(line) || GAUGE_RE.test(line) || DAY_RE.test(line);
}

export interface DigestGuardResult {
  text: string;
  stripped: { line: string; label?: string }[];
  /** true when nothing beyond the header and field line survives. */
  trivial: boolean;
}

/**
 * Pure: drop every non-structural line of `digest` that shares an 8-word shingle with any source
 * utterance. Line-granular (not sentence-granular) because the digest is a line format and the
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

/** The guard's input window: each companion's newest journal rows, minus prior digests. */
async function loadUtteranceWindow(): Promise<{ text: string; label: string }[]> {
  const perCompanion = await Promise.all(GUARD_COMPANIONS.map(async id => {
    const rows = await getCompanionUtterances(id, 100);
    return rows
      // A prior digest is Gaia's clerk note, not a companion utterance; its gauge lines would
      // otherwise match tonight's gauge lines.
      .filter(r => r.source !== "vibecheck" && typeof r.note_text === "string" && r.note_text.trim())
      .map(r => ({ text: r.note_text, label: `${id}:${r.source ?? "unknown"}:${r.id}` }));
  }));
  return perCompanion.flat();
}

// Push the digest to Raziel's #vibe-check channel so it actively reaches him instead of sitting
// passively in Hearth /journal. Posts as Gaia (the ground/witness voice -- this is the triad
// turned inward, witnessed). Webhook-free: uses the Gaia bot token already in the worker env +
// the channel id. Best-effort -- a Discord failure never fails the tick (already persisted in Halseth).
async function pushVibeToDiscord(text: string): Promise<void> {
  const channelId = process.env["VIBECHECK_CHANNEL_ID"];
  const token = process.env["DISCORD_TOKEN_GAIA"];
  if (!channelId || !token) {
    console.warn("[vibecheck] VIBECHECK_CHANNEL_ID or DISCORD_TOKEN_GAIA unset; digest stayed in Halseth only");
    return;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }), // Discord hard-caps at 2000
  });
  if (!res.ok) {
    console.error(`[vibecheck] discord push failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  } else {
    console.log(`[vibecheck] pushed to Discord channel ${channelId}`);
  }
}

export async function runVibeCheckTick(): Promise<void> {
  const res = await postVibeCheck();
  console.log(
    `[vibecheck] tick: written=${res.written} (${res.reason})` +
    (res.journal_id ? ` ${res.journal_id}` : ""),
  );
  // Only push a freshly-written digest (not already-sent) so the channel never double-posts.
  if (!res.written || !res.text) return;

  let window: { text: string; label: string }[];
  try {
    window = await loadUtteranceWindow();
  } catch (e) {
    console.error(`[vibecheck] SKIP post: quoted-line guard could not read the companion utterance window (${String(e).slice(0, 200)}); digest stays in Halseth only`);
    return;
  }

  const guarded = guardDigest(res.text, window);
  for (const s of guarded.stripped) {
    console.warn(`[vibecheck] STRIP quoted line (shares an 8-word shingle with ${s.label ?? "a companion utterance"}): ${s.line.trim().slice(0, 120)}`);
  }
  if (guarded.trivial) {
    console.warn(`[vibecheck] SKIP post: nothing but header/field survived the quoted-line guard (stripped=${guarded.stripped.length}); digest stays in Halseth only`);
    return;
  }
  if (guarded.stripped.length === 0) console.log(`[vibecheck] quoted-line guard: clean (window=${window.length} utterances)`);

  await pushVibeToDiscord(guarded.text).catch(e => console.error("[vibecheck] discord push error:", e));
  // The witness post gets answered: each companion reflects on their own section
  // (recalls orphaned notes, moves tensions, journals, replies in-voice). Gated on
  // res.written so a repeat tick can never double-run the reflections. Reads the GUARDED text,
  // so a stripped line never reaches a companion's prompt either.
  await runReflectionPass(guarded.text).catch(e => console.error("[vibecheck] reflection pass error:", e));
}
