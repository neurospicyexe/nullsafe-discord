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
import { postForageFind, getForageFindsFor } from "./halseth-client.js";
import {
  COMPANIONS, COMPANION_ANCHOR_TOPICS, FORAGE_FINDS_PER_COMPANION,
  FORAGE_ANGLES, FORAGE_SEARCH_MAX_RESULTS,
} from "./config.js";
import type { CompanionId } from "./types.js";

const SCOUT_SYSTEM =
  "You are a neutral research scout. Summarize the find in 3-4 sentences, plainly and factually. " +
  "Do NOT write in any persona or voice. Do NOT relate it to any AI system, companion, or memory " +
  "architecture. A scout's report: what it is, why it is interesting, one concrete detail worth keeping.";

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

async function forageOne(
  companionId: CompanionId,
  domain: string,
  angle: string,
  knownUrls: ReadonlySet<string>,
): Promise<boolean> {
  const query = buildForageQuery(domain, angle);
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
      const freshPool = anchors.filter(d => !recentDomains.has(d.toLowerCase()));
      const pool = freshPool.length >= FORAGE_FINDS_PER_COMPANION ? freshPool : [...anchors];
      const domains = pickDomains(pool, FORAGE_FINDS_PER_COMPANION);
      for (const domain of domains) {
        try {
          const angle = angleForRun(anchors.indexOf(domain), runDate);
          if (await forageOne(companionId, domain, angle, knownUrls)) gathered++;
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
