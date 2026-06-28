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
import { postForageFind } from "./halseth-client.js";
import { COMPANIONS, COMPANION_ANCHOR_TOPICS, FORAGE_FINDS_PER_COMPANION } from "./config.js";
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

async function forageOne(companionId: CompanionId, domain: string): Promise<boolean> {
  const results = await search(domain, { maxResults: 3, searchDepth: "basic" });
  const r = results.find(x => x.title && x.content);
  if (!r) {
    console.log(`[${companionId}/forage] no usable result for domain "${domain}"`);
    return false;
  }

  const summaryResult = await prompt(
    `${r.title}\n${r.url}\n${r.content.slice(0, 1500)}`,
    SCOUT_SYSTEM,
    { temperature: 0.3, maxTokens: 250 },
  );
  const summary = summaryResult.content.trim();
  if (!summary) {
    console.warn(`[${companionId}/forage] empty summary for "${r.title}" -- skipping`);
    return false;
  }

  const res = await postForageFind({
    companion_id: companionId,
    domain,
    title: r.title,
    source_url: r.url,
    summary,
  });
  if (res.deduped) {
    console.log(`[${companionId}/forage] deduped: ${r.title.slice(0, 60)}`);
    return false;
  }
  console.log(`[${companionId}/forage] gathered [${domain}] ${r.title.slice(0, 60)}`);
  return true;
}

/**
 * One forage pass: for each companion, pick FORAGE_FINDS_PER_COMPANION random domains
 * from their anchor topics and gather one find per domain. Per-companion failures are
 * contained -- one companion's error never stops the others. Tavily's daily cap is
 * enforced inside search() (returns [] past the cap), so a long pass degrades quietly.
 */
export async function runForage(): Promise<number> {
  let gathered = 0;
  for (const companionId of COMPANIONS) {
    try {
      const domains = pickDomains(COMPANION_ANCHOR_TOPICS[companionId], FORAGE_FINDS_PER_COMPANION);
      for (const domain of domains) {
        try {
          if (await forageOne(companionId, domain)) gathered++;
        } catch (e) {
          console.warn(`[${companionId}/forage] domain "${domain}" failed:`, e);
        }
      }
    } catch (e) {
      console.error(`[${companionId}/forage] companion pass failed:`, e);
    }
  }
  if (gathered === 0) {
    // 0 finds across EVERY companion + domain is not normal variance: it almost always means
    // the upstream search returned [] for all of them (TAVILY_API_KEY invalid, daily cap, or
    // quota). search() degrades quietly by design, so without a loud signal here the failure
    // is invisible until the Guardian's pool-staleness flag fires ~7 days later -- exactly how
    // foraging silently died 2026-06-16 -> 06-28. Make it loud so the next one is caught same-day.
    console.error(
      "[forage] pass complete: 0 finds gathered across ALL companions -- probable upstream " +
      "search failure (check TAVILY_API_KEY / Tavily daily cap / quota)",
    );
  } else {
    console.log(`[forage] pass complete: ${gathered} find(s) gathered`);
  }
  return gathered;
}
