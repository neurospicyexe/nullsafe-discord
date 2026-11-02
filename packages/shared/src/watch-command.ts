// packages/shared/src/watch-command.ts
//
// The watch shelf command (migration 0111). "Where are we in Fargo" made deterministic.
//
// WHY (2026-07-31): Raziel asked Drevan where they were and got "last I tracked, S4 E2" while they had
// watched further in a Claude thread. No position field existed anywhere, so the answer came from
// whichever prose fragment ranked highest -- and a June note about having FINISHED the show won.
//
// DETERMINISTIC ACKS, NEVER INFERENCE. Every reply here is built from the API response, never handed
// to the model to narrate. This is the 2026-06-11 club-vote doctrine: a model asked to report a write
// it did not see will describe a convincing success that never happened. If the write fails, the reply
// says so.
//
// Forms:
//   "dre: watching"                          -> the shelf, with positions
//   "dre: watched fargo s4e5"                -> record a viewing, advance the position
//   "dre: watched fargo s4e5 -- smutny house" -> ...and store the landmark note
//   "dre: watching fargo s4e5"               -> same as watched (he says it both ways)
//   "dre: watched fargo e6"                  -> bare episode advances within the known season
//   "dre: watch fargo finished"              -> status change

import type { CompanionId } from "./types.js";
import { halsethEnv } from "./halseth-command-env.js";
import { COMPANION_ALIASES } from "./command-triggers.js";

export interface WatchShelfItem {
  id?: string;
  title: string;
  kind?: string;
  status?: string;
  position?: string;
  position_note?: string | null;
  with_companion?: string | null;
}

const STATUS_WORDS: Record<string, string> = {
  finished: "finished", done: "finished", complete: "finished", completed: "finished",
  paused: "paused", pause: "paused", hold: "paused",
  abandoned: "abandoned", dropped: "abandoned", abandon: "abandoned",
  watching: "watching", resume: "watching", resumed: "watching",
};

const SPELLED_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const SPELLED_RE = new RegExp(String.raw`\b(season|episode|ep)\s+(${Object.keys(SPELLED_NUMBERS).join("|")})\b`, "gi");

/** "season four episode ten" -> "season 4 episode 10". A spelled number only counts directly after
 *  season/episode/ep, so "one" in ordinary prose never becomes a position. Mirrored (same code) in
 *  halseth src/handlers/watch.ts so the two parsers cannot disagree. */
export function digitizeSpelledPositions(s: string): string {
  return s.replace(SPELLED_RE, (_m, kw: string, w: string) => `${kw} ${SPELLED_NUMBERS[w.toLowerCase()]}`);
}

/** "S4E5" / "s04e05" / "4x5" / "season 4 episode 5" / "season four episode ten" / "episode 10 of
 *  season four" / "e6" -> position. Mirrors the server parser; tested against the same strings so the
 *  two cannot drift into disagreeing about "s4e5". */
export function parseWatchPosition(s: string): { season: number | null; episode: number | null; rest: string } {
  let season: number | null = null;
  let episode: number | null = null;
  let rest = digitizeSpelledPositions(s);

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = rest.match(re);
    if (m) { fn(m); rest = (rest.slice(0, m.index ?? 0) + rest.slice((m.index ?? 0) + m[0].length)).trim(); return true; }
    return false;
  };

  const ok = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);
  const matched = take(/\bs\s*(\d{1,2})\s*[\s._-]*e\s*(\d{1,3})\b/i, m => { season = ok(+m[1]!); episode = ok(+m[2]!); })
    || take(/\b(\d{1,2})\s*x\s*(\d{1,3})\b/i, m => { season = ok(+m[1]!); episode = ok(+m[2]!); })
    || take(/\bseason\s*(\d{1,2})\s*,?\s*ep(?:isode)?\s*(\d{1,3})\b/i, m => { season = ok(+m[1]!); episode = ok(+m[2]!); });
  if (!matched) {
    // Independent season and episode tokens, either order ("episode 10 of season 4"). Season first so
    // its digits are gone before the episode pattern looks.
    take(/\bs(?:eason)?\s*(\d{1,2})\b/i, m => { season = ok(+m[1]!); });
    take(/\bep?(?:isode)?\s*(\d{1,3})\b/i, m => { episode = ok(+m[1]!); });
    if (season !== null && episode !== null) rest = rest.replace(/^\s*of\s*$|\s+of\s*$|^\s*of\s+/i, "").trim();
  }

  return { season, episode, rest: rest.replace(/^[\s,:-]+|[\s,:-]+$/g, "") };
}

/** Split "fargo s4e5 -- the smutny house" into title, position and landmark note. */
export function parseWatchArgs(arg: string): {
  title: string; season: number | null; episode: number | null; note: string | null; status: string | null;
} {
  const trimmed = arg.trim();
  // An explicit "--" or "|" separates the landmark note from the title+position. Without a separator
  // the whole remainder after the position is treated as part of the title, because "fargo season 4"
  // must not become a note.
  const sepIdx = trimmed.search(/\s+(?:--|—|\||,\s*left off)\s+/i);
  let head = sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed;
  let note = sepIdx >= 0 ? trimmed.slice(sepIdx).replace(/^\s+(?:--|—|\||,\s*left off)\s+/i, "").trim() : null;

  // A trailing status word is a status change, not part of the title.
  let status: string | null = null;
  const statusMatch = head.match(/\s+(finished|done|complete|completed|paused|pause|hold|abandoned|dropped|abandon|watching|resume|resumed)\s*$/i);
  if (statusMatch) {
    status = STATUS_WORDS[statusMatch[1]!.toLowerCase()] ?? null;
    head = head.slice(0, statusMatch.index).trim();
  }

  const { season, episode, rest } = parseWatchPosition(head);
  return { title: rest.trim(), season, episode, note: note || null, status };
}

/**
 * Passive watch-party channels (2026-09-05). Raziel co-watches with the triad in a shared
 * channel (e.g. #fargo-watch-party) and never types the explicit `dre: watched fargo s4e6`
 * command mid-episode -- so the deterministic shelf above only advances when someone
 * remembers to say it out loud, and it went stale for a month (07-31 -> 08-29/30) even
 * though the room kept talking about episodes in plain prose.
 *
 * `WATCH_PARTY_CHANNELS` binds a channel to a title + the ONE companion who records for it
 * (so all three bots seeing the same message don't triple-write). Format:
 *   "channelId:Title:companion;channelId2:Title2:companion2"
 * Tolerant: blank/garbage entries are skipped rather than throwing, so a typo in .env
 * degrades to "this channel doesn't passively track" instead of crashing the bot.
 */
export function parseWatchPartyChannels(raw: string | undefined): Map<string, { title: string; companion: CompanionId }> {
  const map = new Map<string, { title: string; companion: CompanionId }>();
  if (!raw) return map;
  const entries = raw.split(/[;,]/).map(e => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(":").map(p => p.trim());
    if (parts.length !== 3) continue;
    const [channelId, title, companionRaw] = parts;
    if (!channelId || !title || !companionRaw) continue;
    const companion = companionRaw.toLowerCase();
    if (companion !== "cypher" && companion !== "drevan" && companion !== "gaia") continue;
    map.set(channelId, { title, companion: companion as CompanionId });
  }
  return map;
}

// Recognizes "this message IS addressed as a watch command" (any companion's alias followed by
// watching/watched/watch) so passive detection never double-records what the deterministic
// command path above already writes. Deliberately BROADER than the real per-companion WATCH_TRIGGER
// (built via buildCommandTriggers, which gates on a stricter position/status sub-pattern that does
// not accept a bare "e6" -- only "ep6"/"episode6"/"s4e6"/"4x6"): a message that merely LOOKS like an
// attempted command must still be treated as "the command path's territory", not silently re-parsed
// here, or a phrasing the strict gate rejects (and that therefore falls through to ordinary reply
// handling) would get double-recorded by both this passive path's parse AND whatever the strict gate
// eventually does with it. Under-detecting a passive marker is harmless (nothing regresses); a
// double-write is not.
const ALL_WATCH_ALIASES = Object.values(COMPANION_ALIASES).flat();
const WATCH_ADDRESS_RE = new RegExp(`^(?:${ALL_WATCH_ALIASES.join("|")})\\b[,:]?\\s*(?:watching|watched|watch)\\b`, "i");

function isExplicitWatchCommand(content: string): boolean {
  return WATCH_ADDRESS_RE.test(content);
}

// A bare episode number is only trustworthy as a passive marker when it appears in one of these
// explicit forms -- never a number that merely happens to be small. parseWatchPosition already
// requires an "e"/"ep"/"episode" or "NxM" token before it will set `episode`, which is what keeps
// a time ("12:04") or a date ("9/2") from being mistaken for one: neither carries that token.
/**
 * Passive episode detector for a message already known to belong to a bound watch-party channel.
 * Reuses `parseWatchPosition` (the same parser the explicit command uses) so the two paths can
 * never disagree about what "S4E6" means.
 *
 * Returns a hit when season+episode both parsed, or when episode parsed alone via an explicit
 * form ("e6" / "ep 6" / "episode 6" / "4x6") -- bare-episode-alone is acceptable here ONLY
 * because the channel binding already supplies the title (so there is nowhere else for a
 * position to belong). A season-only mention ("season 4") is not enough: null. Never matches
 * the explicit command form itself -- that path already records progress deterministically.
 */
export function detectWatchProgress(
  content: string,
  party: { title: string; companion: CompanionId },
): { season: number | null; episode: number | null } | null {
  void party; // title/companion are the caller's routing context, not inputs to parsing
  if (isExplicitWatchCommand(content)) return null;
  const { season, episode } = parseWatchPosition(content);
  if (season !== null && episode !== null) return { season, episode };
  if (season === null && episode !== null) return { season: null, episode };
  return null;
}

/**
 * Watch-party start routing. In a bound party channel, `<alias>: watch <title?> s#e#` (imperative
 * "watch" only: not "watched", "watching" or a status word) starts the watchalong at that episode, as if
 * the owner had typed `movie start <Title> S#E#`. Requires BOTH season and episode (the shelf's known
 * season is not fetched here); anything else returns null and falls through to the progress organ.
 *
 * `content` is the whole message (to read the verb), `arg` is the WATCH_TRIGGER capture after the verb.
 */
/** Drop leading filler like "movie", "the show", "the episode of", "some", repeated ("the movie the show Fargo"). */
export function stripKindWords(title: string): string {
  let t = title.trim();
  const re = /^(?:(?:the|a|an|some|our|more|next)\s+)?(?:movie|film|show|tv\s+show|series|episode|ep|tv)\b\s*(?:of\s+)?/i;
  for (let i = 0; i < 3 && re.test(t); i++) t = t.replace(re, "").trim();
  return t;
}

export function resolveWatchPartyStart(
  content: string,
  arg: string,
  party: { title: string; companion: CompanionId },
): { movieTitle: string; progressTitle: string; season: number; episode: number; note: string | null } | null {
  if (!/^\s*[^\s,:]+\s*[,:]?\s*watch\b/i.test(content)) return null; // "watched"/"watching" fail the \b
  const parsed = parseWatchArgs(arg);
  if (parsed.status) return null;
  if (parsed.season === null || parsed.episode === null) return null;
  // "Dre: watch movie Fargo s4e10" (2026-11-02) searched OpenSubtitles for "movie Fargo" and found nothing.
  // A leading kind word is how the sentence is spoken, not part of the show's name.
  const title = stripKindWords(parsed.title) || party.title;
  return {
    movieTitle: `${title} S${parsed.season}E${parsed.episode}`,
    progressTitle: title,
    season: parsed.season,
    episode: parsed.episode,
    note: parsed.note,
  };
}

/** Render the shelf. One line per title -- this is the answer to "where are we". */
export function formatShelf(items: WatchShelfItem[], me: CompanionId): string {
  if (items.length === 0) {
    return "Nothing on the watch shelf yet. `watched <title> s1e1` puts something on it.";
  }
  const lines = items.map(w => {
    const pos = w.position ? ` — ${w.position}` : "";
    const who = w.with_companion && w.with_companion !== me ? ` (with ${w.with_companion})` : "";
    const paused = w.status === "paused" ? " [paused]" : "";
    const note = w.position_note ? `\n   left off: ${w.position_note}` : "";
    return `• **${w.title}**${pos}${who}${paused}${note}`;
  });
  return `On the shelf:\n${lines.join("\n")}`;
}

async function watchFetch(
  path: string, method: "GET" | "POST" | "PATCH", secret: string, body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const env = halsethEnv(secret);
  if (!env) return { ok: false, status: 0, json: { error: "halseth env missing on this box" } };
  const res = await fetch(`${env.base}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${env.secret}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/**
 * Thin wrapper over the same POST the explicit command uses, for the passive watch-party path
 * (`detectWatchProgress` above) -- one write shape, two ways of noticing there is something to
 * write. Never throws; the caller fires this and forgets, same as any other side effect.
 */
export async function recordWatchProgress(
  halsethSecret: string,
  body: { title: string; season: number | null; episode: number | null; note: string | null; surface: string; with_companion: CompanionId },
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  return watchFetch("/mind/watch/progress", "POST", halsethSecret, body);
}

/** True when the position the user gave is the shelf's current one ("S4E10" vs 4/10; a bare episode
 *  matches the episode half). Used to tell "already there" from "behind". */
export function sameAsShelf(position: string | undefined, season: number | null, episode: number | null): boolean {
  const m = (position ?? "").match(/^S(\d+)E(\d+)$/i);
  if (!m) return false;
  if (episode === null) return false;
  if (Number(m[2]) !== episode) return false;
  return season === null || Number(m[1]) === season;
}

/**
 * Handle `watching` / `watched ...` text. Returns the exact message the bot sends.
 *
 * Never throws and never delegates the outcome to the model: a shelf command that failed says so.
 */
export async function handleWatchCommand(
  arg: string,
  halsethSecret: string,
  me: CompanionId,
): Promise<string> {
  const parsed = parseWatchArgs(arg ?? "");

  // Bare "watching" / "watch list" -> read the shelf. This is the question the whole organ exists to
  // answer, so it gets the simplest possible form.
  if (!parsed.title || /^(list|shelf|all)$/i.test(parsed.title)) {
    const res = await watchFetch("/mind/watch", "GET", halsethSecret).catch(() => null);
    if (!res?.ok) return "Couldn't reach the shelf just now — that's a read failure on my side, not an empty shelf.";
    return formatShelf((res.json["shelf"] as WatchShelfItem[]) ?? [], me);
  }

  // Status change, no position given: "watch fargo finished". Needs the id, so resolve via the shelf
  // rather than inventing a title-keyed PATCH route.
  if (parsed.status && parsed.season === null && parsed.episode === null) {
    const list = await watchFetch("/mind/watch?status=all", "GET", halsethSecret).catch(() => null);
    const items = (list?.json["shelf"] as Array<WatchShelfItem & { id: string }>) ?? [];
    const lower = parsed.title.toLowerCase();
    // Exact match first, substring only on a miss -- the house rule for writes, so "Fargo" cannot
    // land on "Fargo Season 4 Rewatch" while an exact "Fargo" row exists.
    const target = items.find(i => i.title.toLowerCase() === lower)
      ?? items.find(i => i.title.toLowerCase().includes(lower));
    if (!target) return `Nothing on the shelf matching "${parsed.title}".`;
    const res = await watchFetch(`/mind/watch/${target.id}`, "PATCH", halsethSecret, { status: parsed.status }).catch(() => null);
    if (!res?.ok) return `Couldn't update "${target.title}" — the write didn't land, so nothing changed.`;
    return `**${target.title}** marked ${parsed.status}.`;
  }

  const res = await watchFetch("/mind/watch/progress", "POST", halsethSecret, {
    title: parsed.title,
    season: parsed.season,
    episode: parsed.episode,
    note: parsed.note,
    surface: "discord",
    with_companion: me,
  }).catch(() => null);

  if (!res?.ok || !res.json["item"]) return `Couldn't record that — the write didn't land, so the shelf still says what it said.`;
  const item = res.json["item"] as WatchShelfItem;
  const advanced = res.json["advanced"] === true;

  const pos = item.position ? ` at ${item.position}` : "";
  // Three distinct outcomes, not two (review finding 2026-07-31). The first version said "that's at or
  // behind where we already were" whenever `advanced` was false -- including for a MOVIE (position is
  // inherently empty) and for a first shelving with no episode given. Telling Raziel his brand-new row is
  // "behind" reads as a rejected write, and this module's whole doctrine is that the ack tells the truth.
  //
  // A position was only "not moved" if there is a position to compare against.
  const gaveNoPosition = parsed.season === null && parsed.episode === null;
  const moved = advanced
    ? `Logged. **${item.title}**${pos}.`
    : gaveNoPosition
      ? `Logged. **${item.title}** is on the shelf${pos ? `${pos}` : ""}${item.position ? "" : " (no episode position — say `watched ${item.title} s1e1` when you want one)"}.`
      : sameAsShelf(item.position, parsed.season, parsed.episode)
        ? `Already there: the shelf has **${item.title}**${pos}.`
        : `Logged the viewing, but the shelf still reads **${item.title}**${pos} — that's behind where we already were, so I left the position alone. Correct it with \`watched ${item.title} s#e#\` if the shelf is wrong.`;
  const noteLine = parsed.note ? `\nLeft off: ${parsed.note}` : "";
  return `${moved}${noteLine}`;
}
