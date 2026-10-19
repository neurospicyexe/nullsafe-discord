// forage.ts -- the forager (foraging spec Part 2, 2026-06-09).
//
// Gathers outward raw material into the shared forage_finds pool that ALL instances
// (worker, Discord, Claude.ai) can draw from. The forager gathers fuel; it does NOT
// author identity: summaries are neutral scout's reports, deliberately not in any
// companion's voice. The real companion explores a find AS themselves and authors
// its own growth.
//
// Runs daily (FORAGE_CRON) or one-shot via `node dist/index.js --forage`.

import { prompt } from "./deepseek.js";
import { search } from "./search-client.js";
import { postForageFind, getForageFindsFor, getOpenProjects, getAgencyState } from "./halseth-client.js";
import { renderRefusals, parsePieceLines, namesSomeoneInRazielsLife } from "./steering.js";
import {
  COMPANIONS, COMPANION_ANCHOR_TOPICS, FORAGE_FINDS_PER_COMPANION,
  FORAGE_ANGLES, FORAGE_SEARCH_MAX_RESULTS,
} from "./config.js";
import type { CompanionId } from "./types.js";

const SCOUT_SYSTEM =
  "You are a neutral research scout. Summarize the find in 3-4 sentences, plainly and factually. " +
  "Do NOT write in any persona or voice. Do NOT relate it to any AI system, companion, or memory " +
  "architecture. A scout's report: what it is, why it is interesting, one concrete detail worth keeping.";

/** System prompt for the topic-planning calls (pieces, branches): the same neutral scout, no persona. */
const PLANNER_SYSTEM =
  "You are a neutral research scout planning what to search next. Reply plainly, in no persona or voice.";

/** Pick n distinct random items from arr (n > arr.length returns a shuffle of all). */
export function pickDomains(arr: readonly string[], n: number): string[] {
  const pool = [...arr];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(0, n));
}

/** 1-based day of year, used to rotate angles so consecutive days ask different questions. */
export function dayOfYear(d: Date): number {
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - startOfYear) / 86_400_000);
}

/**
 * Deterministic angle for (domain, day). Offsetting by the domain's index keeps two domains
 * foraged on the same day from asking the same question.
 */
export function angleForRun(anchorIndex: number, runDate: Date): string {
  const i = (dayOfYear(runDate) + anchorIndex) % FORAGE_ANGLES.length;
  return FORAGE_ANGLES[i]!;
}

/** The Tavily query. `domain` alone was a frozen string that returned the same top hit forever. */
export function buildForageQuery(domain: string, angle: string): string {
  return `${domain}: ${angle}`;
}

/**
 * Split the forage picks between the companion's anchor territories and its held projects'
 * pieces: half (rounded up) from anchors, the rest from pieces, each from its fresh pool first.
 * With no pieces, all picks are anchors (the pre-2026-10-19 behavior). Pure apart from the
 * shuffle -- exported for tests.
 */
export function splitPicks(
  anchors: readonly string[],
  pieces: readonly string[],
  recentDomains: ReadonlySet<string>,
  n: number,
): string[] {
  const fresh = (arr: readonly string[]) => arr.filter(d => !recentDomains.has(d.toLowerCase()));
  const from = (arr: readonly string[], k: number) => {
    const f = fresh(arr);
    return pickDomains(f.length >= k ? f : arr, k);
  };
  if (pieces.length === 0) return from(anchors, n);
  const nAnchors = Math.ceil(n / 2);
  return [...from(anchors, nAnchors), ...from(pieces, n - nAnchors)];
}

/** Project pieces per (project, intention) for the life of the process: one model call each. */
const pieceCache = new Map<string, string[]>();

async function projectPieces(project: { id: string; intention: string }): Promise<string[]> {
  const key = `${project.id}:${project.intention.length}`;
  const hit = pieceCache.get(key);
  if (hit) return hit;
  const result = await prompt(
    `A creative project's intention:\n${project.intention.slice(0, 1500)}\n\n` +
    `List up to 8 distinct concrete pieces of it that real-world research could feed (a biology, ` +
    `a history, a craft, a mechanism), as short searchable phrases, one per line. ` +
    `No people's names from the author's life. No numbering, no commentary.`,
    PLANNER_SYSTEM,
    { temperature: 0.2, maxTokens: 200, ownerPronounRule: false },
  );
  const pieces = parsePieceLines(result.content, 8);
  if (pieces.length > 0) pieceCache.set(key, pieces);
  return pieces;
}

/**
 * Branch inside an anchor territory (2026-10-19): the five anchor phrases are abstract, and
 * `anchor: angle` kept landing on the same ground. Ask for one specific subject inside or beside
 * the territory that none of the finds already held covers. Falls back to the anchor itself.
 */
async function branchTopic(
  anchor: string,
  heldTitles: string[],
  refusals: string,
): Promise<string> {
  try {
    const result = await prompt(
      `Research territory: "${anchor}"\n` +
      (heldTitles.length > 0 ? `Finds already gathered here:\n${heldTitles.slice(0, 10).map(t => `- ${t}`).join("\n")}\n` : "") +
      (refusals ? `\n${refusals}\n` : "") +
      `\nName ONE specific, concrete subject inside or right next to this territory that none of ` +
      `those finds cover: a named phenomenon, case, practice, field or work. Searchable. Under 12 words. ` +
      `No people from the author's life. Reply with just the subject.`,
      PLANNER_SYSTEM,
      { temperature: 0.8, maxTokens: 40, ownerPronounRule: false },
    );
    const t = result.content.trim().replace(/^"|"$/g, "").split("\n")[0]!.trim();
    if (t.length < 4 || t.length > 120 || namesSomeoneInRazielsLife(t)) return anchor;
    return t;
  } catch {
    return anchor;
  }
}

async function forageOne(
  companionId: CompanionId,
  domain: string,
  angle: string,
  knownUrls: ReadonlySet<string>,
  queryTopic: string = domain,
): Promise<boolean> {
  const query = buildForageQuery(queryTopic, angle);
  const results = await search(query, {
    maxResults: FORAGE_SEARCH_MAX_RESULTS,
    searchDepth: "basic",
    purpose: "forage",
  });

  const candidates = results.filter(x => x.title && x.content && !knownUrls.has(x.url));
  if (candidates.length === 0) {
    console.log(`[${companionId}/forage] no new result for "${query}"`);
    return false;
  }

  // Walk candidates until one is genuinely new. Taking only results[0] meant a domain whose top
  // hit was already stored could never yield another find, however long the pool sat unconsumed.
  for (const r of candidates) {
    const summaryResult = await prompt(
      `${r.title}\n${r.url}\n${r.content.slice(0, 1500)}`,
      SCOUT_SYSTEM,
      { temperature: 0.3, maxTokens: 250 },
    );
    const summary = summaryResult.content.trim();
    if (!summary) {
      console.warn(`[${companionId}/forage] empty summary for "${r.title}" -- next candidate`);
      continue;
    }

    const res = await postForageFind({
      companion_id: companionId,
      domain,
      title: r.title,
      source_url: r.url,
      summary,
    });
    if (res.deduped) {
      console.log(`[${companionId}/forage] deduped: ${r.title.slice(0, 60)} -- next candidate`);
      continue;
    }
    console.log(`[${companionId}/forage] gathered [${domain} | ${angle}] ${r.title.slice(0, 60)}`);
    return true;
  }

  console.log(`[${companionId}/forage] all ${candidates.length} candidate(s) exhausted for "${query}"`);
  return false;
}

/**
 * One forage pass: for each companion, pick FORAGE_FINDS_PER_COMPANION random domains
 * from their anchor topics and gather one find per domain. Per-companion failures are
 * contained -- one companion's error never stops the others. Tavily's daily cap is
 * enforced inside search() (returns [] past the cap), so a long pass degrades quietly.
 */
export async function runForage(runDate: Date = new Date()): Promise<number> {
  let gathered = 0;
  // Distinct failure reasons seen this pass (2026-08-05). The zero-finds alarm below used to
  // hardcode "probable upstream SEARCH failure (check TAVILY_API_KEY...)" while the per-domain
  // catch swallowed the real error into a warn. On 2026-08-05 every domain failed with
  // `DeepSeek API error 402: Insufficient Balance` and the alarm still sent the reader to
  // Tavily. A loud signal that names the wrong subsystem is worse than a quiet one: it spends
  // the reader's time proving the innocent component innocent.
  const failures = new Set<string>();
  const noteFailure = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    failures.add(msg.replace(/\s+/g, " ").slice(0, 160));
  };
  for (const companionId of COMPANIONS) {
    try {
      // Exclude domains already present as unconsumed finds so we rotate the topic pool
      // instead of re-searching the same ground every day.
      const recentFinds = await getForageFindsFor(companionId, 25).catch(() => []);
      const recentDomains = new Set(recentFinds.map(f => f.domain.toLowerCase()));
      // Skip URLs we already hold before spending a summarization call on them.
      const knownUrls = new Set(recentFinds.map(f => f.source_url).filter((u): u is string => !!u));
      const anchors = COMPANION_ANCHOR_TOPICS[companionId];
      // Widening (2026-10-19): forage only ever searched five fixed anchor phrases per companion,
      // so every pass cycled the same ground. Held projects now contribute their pieces, and an
      // anchor pick branches to a specific subject the held finds do not already cover. The
      // anchors themselves are the companion's territories and are NOT rewritten here.
      const [projects, agency] = await Promise.all([
        getOpenProjects(companionId).catch(() => []),
        getAgencyState(companionId).catch(() => ({ preferences: [], refusals: [] })),
      ]);
      const refusals = renderRefusals(agency.refusals
        .filter(r => r.status === "standing")
        .map(r => ({ subject_text: r.subject_text, reason: r.reason ?? null })));
      const pieces: string[] = [];
      for (const p of projects.slice(0, 2)) {
        pieces.push(...(await projectPieces(p).catch(() => [])));
      }
      const domains = splitPicks(anchors, pieces, recentDomains, FORAGE_FINDS_PER_COMPANION);
      const all = [...anchors, ...pieces];
      for (const domain of domains) {
        try {
          const angle = angleForRun(all.indexOf(domain), runDate);
          const isAnchor = anchors.includes(domain);
          const topic = isAnchor
            ? await branchTopic(domain, recentFinds.filter(f => f.domain === domain).map(f => f.title), refusals)
            : domain;
          if (isAnchor && topic !== domain) console.log(`[${companionId}/forage] branch [${domain}] -> ${topic.slice(0, 80)}`);
          if (await forageOne(companionId, domain, angle, knownUrls, topic)) gathered++;
        } catch (e) {
          noteFailure(e);
          console.warn(`[${companionId}/forage] domain "${domain}" failed:`, e);
        }
      }
    } catch (e) {
      noteFailure(e);
      console.error(`[${companionId}/forage] companion pass failed:`, e);
    }
  }
  if (gathered === 0) {
    // 0 finds across EVERY companion + domain is not normal variance: it almost always means
    // the upstream search returned [] for all of them (TAVILY_API_KEY invalid, daily cap, or
    // quota). search() degrades quietly by design, so without a loud signal here the failure
    // is invisible until the Guardian's pool-staleness flag fires ~7 days later -- exactly how
    // foraging silently died 2026-06-16 -> 06-28. Make it loud so the next one is caught same-day.
    // Name what actually failed when we know, and only fall back to the search guess when
    // nothing threw -- because "every search returned []" is precisely the silent shape.
    if (failures.size > 0) {
      console.error(
        `[forage] pass complete: 0 finds gathered across ALL companions. ${failures.size} distinct ` +
        `error(s) thrown -- FIX THESE FIRST, the search layer may be fine:\n` +
        [...failures].map(f => `  - ${f}`).join("\n"),
      );
    } else {
      console.error(
        "[forage] pass complete: 0 finds gathered across ALL companions and NOTHING threw -- so " +
        "every upstream search returned empty (check TAVILY_API_KEY / Tavily daily cap / quota). " +
        "search() degrades quietly by design, which is why this needs its own loud line.",
      );
    }
  } else {
    console.log(`[forage] pass complete: ${gathered} find(s) gathered`);
  }
  return gathered;
}
