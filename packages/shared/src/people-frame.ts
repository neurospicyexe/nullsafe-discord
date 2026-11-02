/**
 * People in the turn (B49 slice 1, docs/PLAN-people-nodes-2026-11-01.md).
 *
 * The triad meets people who are MENTIONED ("Kyle said...") or who are not PK speakers, and knew
 * nothing about them. Halseth's `GET /people/frame-index` serves Raziel's curated list with each line
 * already rendered (centre excluded, keep-off applied, care words dropped, ambiguous spellings removed),
 * so nothing here carries a rule. This file only: caches that index (PeopleIndex), resolves who is in
 * a turn from ids and curated spellings (resolvePeople, pure), renders the block (peopleBlock, pure),
 * and keeps a repeat guard (claimPeopleSeen).
 *
 * Doctrine, held here as well as on the server:
 *  - one centre: a self entry renders as Raziel's own name, and the centre is never an entry;
 *  - never guess: names match ONLY the index's curated spellings, case-sensitive and word-bounded,
 *    never the PluralKit roster (about 1,400 labels, many shared with characters);
 *  - identity comes from ids (PK system plus name, or the Discord user id), never from userTier;
 *  - every path fails to null; the reply never waits on any of it.
 */

import type { SeenRedis } from "./pk-profile-seen.js";

export type PeopleFrameMode = "off" | "shadow" | "live";
const MODES: readonly PeopleFrameMode[] = ["off", "shadow", "live"];
let warnedMode = false;

/** `PEOPLE_FRAME_<COMPANION>` wins over `PEOPLE_FRAME`. CODE DEFAULT shadow (logs counts, injects
 *  nothing); garbage falls to off. */
export function readPeopleFrameMode(env: NodeJS.ProcessEnv = process.env, companion?: string): PeopleFrameMode {
  const perKey = companion ? `PEOPLE_FRAME_${companion.toUpperCase()}` : null;
  const perRaw = perKey ? (env[perKey] ?? "").trim().toLowerCase() : "";
  const raw = perRaw || (env["PEOPLE_FRAME"] ?? "").trim().toLowerCase();
  if (!raw) return "shadow";
  if ((MODES as readonly string[]).includes(raw)) return raw as PeopleFrameMode;
  if (!warnedMode) {
    warnedMode = true;
    console.warn(`[people-frame] unknown ${perRaw ? perKey : "PEOPLE_FRAME"}="${raw}"; falling back to "off" (valid: ${MODES.join(" | ")})`);
  }
  return "off";
}
export function __resetPeopleFrameWarnings(): void { warnedMode = false; }

export interface FrameIndexEntry {
  id: string;
  label: string;
  kind: string;
  /** Finished, sanitized line from Halseth; no trailing period. */
  rendered: string;
  /** Curated spellings only (ambiguous ones already removed by Halseth). */
  spellings: string[];
  pk: { system: string; names: string[] } | null;
  discord_user_id: string | null;
}

export interface PeopleIndexSnapshot { entries: FrameIndexEntry[]; builtAt: number | null; fetchedAt: number }

const CENTRE_ID = "raziel";
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Parse Halseth's answer defensively. Anything malformed yields null (keep the last good index). */
export function parseFrameIndex(raw: unknown): FrameIndexEntry[] | null {
  if (!raw || typeof raw !== "object") return null;
  const people = (raw as { people?: unknown }).people;
  if (!Array.isArray(people)) return null;
  const out: FrameIndexEntry[] = [];
  for (const p of people) {
    const e = p as Partial<FrameIndexEntry> | null;
    if (!e || typeof e.id !== "string" || typeof e.label !== "string" || typeof e.rendered !== "string" || !e.rendered.trim()) continue;
    if (e.id === CENTRE_ID || e.kind === "centre") continue; // the centre is never an entry, whatever the server says
    const pk = e.pk && typeof e.pk === "object" && typeof (e.pk as { system?: unknown }).system === "string" && Array.isArray((e.pk as { names?: unknown }).names)
      ? { system: (e.pk as { system: string }).system, names: ((e.pk as { names: unknown[] }).names).filter((n): n is string => typeof n === "string") }
      : null;
    out.push({
      id: e.id, label: e.label, kind: typeof e.kind === "string" ? e.kind : "person", rendered: e.rendered,
      spellings: Array.isArray(e.spellings) ? e.spellings.filter((s): s is string => typeof s === "string" && s.length > 0) : [],
      pk, discord_user_id: typeof e.discord_user_id === "string" && e.discord_user_id ? e.discord_user_id : null,
    });
  }
  return out;
}

export interface PeopleCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

const CACHE_TTL_S = 6 * 60 * 60;
export const peopleIndexKey = (companion: string) => `ns:people:index:v1:${companion}`;
export function peopleRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env["PEOPLE_FRAME_REFRESH_MS"] ?? "").trim());
  return Number.isInteger(n) && n >= 10_000 ? n : 15 * 60 * 1000;
}

export interface PeopleIndexDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Wrap a Halseth round trip (the [turn] telemetry); defaults to identity. */
  time?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (m: string) => void;
}

/** The people index for one companion: fetched at boot and every 15 minutes, cached in Redis so a
 *  restart is warm, a failed refresh keeps the last good index, and no index means empty (the reply
 *  goes on). An answer that says `degraded` (keep-off unreadable) IS adopted: fail closed means an
 *  empty index, not the previous one that may predate a new keep-off term. */
export class PeopleIndex {
  private snap: PeopleIndexSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;
  constructor(private readonly companion: string, private readonly redis: PeopleCache | null, private readonly deps: PeopleIndexDeps = {}) {}

  private now() { return (this.deps.now ?? Date.now)(); }
  private log(m: string) { try { (this.deps.log ?? console.log)(`[people-frame] ${m}`); } catch { /* never */ } }

  get(): PeopleIndexSnapshot | null { return this.snap; }
  ageS(): number { return this.snap ? Math.max(0, Math.round((this.now() - this.snap.fetchedAt) / 1000)) : -1; }

  /** Warm from Redis, then fetch. Never throws. Concurrent calls share one load. */
  ensureLoaded(): Promise<void> {
    if (!this.loading) this.loading = this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  start(): void {
    if (this.timer) return;
    void this.ensureLoaded();
    this.timer = setInterval(() => { void this.ensureLoaded(); }, peopleRefreshMs(this.deps.env));
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async load(): Promise<void> {
    try {
      if (!this.snap && this.redis) await this.warm();
      await this.refresh();
    } catch (e) {
      this.log(`${this.companion} load failed: ${String(e).slice(0, 120)}`);
    }
  }

  private async warm(): Promise<void> {
    try {
      const raw = await this.redis!.get(peopleIndexKey(this.companion));
      if (!raw) return;
      const j = JSON.parse(raw) as { builtAt?: number | null; fetchedAt?: number; entries?: unknown };
      const entries = parseFrameIndex({ people: j.entries });
      if (entries) this.snap = { entries, builtAt: j.builtAt ?? null, fetchedAt: typeof j.fetchedAt === "number" ? j.fetchedAt : this.now() };
    } catch { /* a bad cache is no cache */ }
  }

  private async refresh(): Promise<void> {
    const env = this.deps.env ?? process.env;
    const base = env["HALSETH_URL"];
    const secret = env["HALSETH_SECRET"] ?? env["ADMIN_SECRET"];
    if (!base || !secret) return;
    const doFetch = this.deps.fetch ?? fetch;
    const time = this.deps.time ?? (<T,>(fn: () => Promise<T>) => fn());
    try {
      const url = `${base.replace(/\/+$/, "")}/people/frame-index?companion=${encodeURIComponent(this.companion)}`;
      const res = await time(() => doFetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(6_000) }));
      if (!res.ok) { this.log(`${this.companion} refresh http_${res.status}; keeping last index`); return; }
      const body = await res.json() as { built_at?: string; degraded?: string };
      const entries = parseFrameIndex(body);
      if (!entries) { this.log(`${this.companion} refresh bad shape; keeping last index`); return; }
      const t = Date.parse(body.built_at ?? "");
      this.snap = { entries, builtAt: Number.isFinite(t) ? t : null, fetchedAt: this.now() };
      if (body.degraded) this.log(`${this.companion} index degraded=${body.degraded} (empty, fail closed)`);
      if (this.redis) {
        await this.redis.set(peopleIndexKey(this.companion), JSON.stringify({ builtAt: this.snap.builtAt, fetchedAt: this.snap.fetchedAt, entries }), "EX", CACHE_TTL_S).catch(() => {});
      }
    } catch (e) {
      this.log(`${this.companion} refresh failed: ${String(e).slice(0, 120)}; keeping last index`);
    }
  }
}

let shared: PeopleIndex | null = null;
/** One index per process (a bot is one companion); built and started on first use. */
export function peopleIndexFor(companion: string, redis: PeopleCache | null, deps?: PeopleIndexDeps): PeopleIndex {
  if (!shared) { shared = new PeopleIndex(companion, redis, deps); shared.start(); }
  return shared;
}
export function __resetPeopleIndex(): void { shared?.stop(); shared = null; }

// ---------------------------------------------------------------------------------------------

export const PEOPLE_CAP = 4;
export const PEOPLE_BLOCK_MAX_CHARS = 600;

export type ResolvedVia = "speaker" | "mention" | "name";
export interface ResolvedPerson { entry: FrameIndexEntry; via: ResolvedVia }

export interface ResolveInput {
  index: FrameIndexEntry[];
  /** The live message text. */
  text: string;
  /** The same speaker's earlier messages gathered into this turn. */
  burstTexts?: string[];
  /** Who is speaking: a PK member (system plus name) or an unproxied Discord user id. */
  speaker?: { pk?: { system: string; name: string } | null; discordUserId?: string | null } | null;
  /** Discord user ids @mentioned in the turn. */
  mentionedUserIds?: string[];
  replyTargetUserId?: string | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-sensitive, whole word in any script: no letter or digit may touch either end. */
function wordBoundedAt(text: string, spelling: string): number {
  if (!spelling) return -1;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc(spelling)}(?![\\p{L}\\p{N}])`, "u").exec(text);
  return m ? m.index : -1;
}

/** Who is in this turn. Pure. Speaker first, then @mentions by id (then the reply target), then names in
 *  the live text and the gathered burst by order of first appearance. Deduped, the centre dropped,
 *  capped at PEOPLE_CAP. Names match the index's curated spellings ONLY. */
export function resolvePeople(input: ResolveInput): ResolvedPerson[] {
  const entries = input.index.filter((e) => e.id !== CENTRE_ID && e.kind !== "centre");
  const out: ResolvedPerson[] = [];
  const seen = new Set<string>();
  const add = (entry: FrameIndexEntry | undefined, via: ResolvedVia) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push({ entry, via });
  };

  const sp = input.speaker;
  if (sp?.pk?.name) {
    const n = normName(sp.pk.name);
    add(entries.find((e) => e.pk && e.pk.system === sp.pk!.system && e.pk.names.some((x) => normName(x) === n)), "speaker");
  }
  if (sp?.discordUserId) add(entries.find((e) => e.discord_user_id === sp.discordUserId), "speaker");

  for (const id of input.mentionedUserIds ?? []) add(entries.find((e) => e.discord_user_id === id), "mention");
  if (input.replyTargetUserId) add(entries.find((e) => e.discord_user_id === input.replyTargetUserId), "mention");

  const texts = [input.text, ...(input.burstTexts ?? [])];
  const hits: Array<{ entry: FrameIndexEntry; at: number }> = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    let best = -1;
    for (let t = 0; t < texts.length && best < 0; t++) {
      for (const s of e.spellings) {
        const at = wordBoundedAt(texts[t]!, s);
        if (at >= 0) { best = t * 1_000_000 + at; break; }
      }
    }
    if (best >= 0) hits.push({ entry: e, at: best });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) add(h.entry, "name");
  return out.slice(0, PEOPLE_CAP);
}

const clean = (s: string) => s.replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();

/** The block, or null. Pure. The speaker's own line is skipped when the PK profile block already
 *  introduced them this turn. Hard cap 600 chars: whole lines dropped from the end. */
export function peopleBlock(resolved: ResolvedPerson[], opts: { speakerProfileInjected?: boolean } = {}): string | null {
  const lines = resolved
    .filter((r) => !(r.via === "speaker" && opts.speakerProfileInjected))
    .map((r) => clean(r.entry.rendered).replace(/[.\s]+$/, ""))
    .filter(Boolean);
  const head = "[People in this turn (who they are, for you to know, not to recite): ";
  const build = (ls: string[]) => `${head}${ls.map((l) => `${l}.`).join(" ")}]`;
  let kept = lines;
  while (kept.length > 0 && build(kept).length > PEOPLE_BLOCK_MAX_CHARS) kept = kept.slice(0, -1);
  return kept.length > 0 ? build(kept) : null;
}

// ---------------------------------------------------------------------------------------------
// Repeat guard: the block rides the live turn, which the gateway keeps in the transcript, so each
// person is injected once per companion+channel+transcript per window (generalises claimPkProfile).

const DEFAULT_REPEAT_S = 21600;
export function peopleRepeatS(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env["PEOPLE_FRAME_REPEAT_S"] ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_REPEAT_S;
}

export interface PeopleSeenFacts { companion: string; channelId: string; personId: string; sessionId: string }
export const peopleSeenKey = (f: PeopleSeenFacts) => `ns:people:seen:${f.companion}:${f.channelId}:${f.personId}:${f.sessionId}`;

/** "inject" the first time, "skip" after. Fails OPEN: no Redis or an error returns "inject". */
export async function claimPeopleSeen(redis: SeenRedis | null, f: PeopleSeenFacts, ttlS: number = peopleRepeatS()): Promise<"inject" | "skip"> {
  if (!redis) return "inject";
  try {
    return (await redis.set(peopleSeenKey(f), "1", "EX", ttlS, "NX")) === "OK" ? "inject" : "skip";
  } catch {
    return "inject";
  }
}

export interface PeopleTurnInput extends ResolveInput {
  companion: string;
  channelId: string;
  sessionId: string;
  mode: PeopleFrameMode;
  /** True when pkProfileBlock introduced the speaker this turn. */
  speakerProfileInjected: boolean;
  redis: SeenRedis | null;
  indexAgeS: number;
}

/** One turn, end to end: resolve, claim (live only), render, log counts. Never throws; the block is
 *  null in off and shadow. */
export async function peopleForTurn(input: PeopleTurnInput, log: (m: string) => void = console.log): Promise<string | null> {
  try {
    if (input.mode === "off") return null;
    const resolved = resolvePeople(input);
    const speaker = resolved.some((r) => r.via === "speaker") ? 1 : 0;
    const mentions = resolved.filter((r) => r.via !== "speaker").length;
    let block: string | null = null;
    let repeatSkipped = 0;
    if (input.mode === "live" && resolved.length > 0) {
      const fresh: ResolvedPerson[] = [];
      for (const r of resolved) {
        const c = await claimPeopleSeen(input.redis, { companion: input.companion, channelId: input.channelId, personId: r.entry.id, sessionId: input.sessionId });
        if (c === "inject") fresh.push(r); else repeatSkipped++;
      }
      block = peopleBlock(fresh, { speakerProfileInjected: input.speakerProfileInjected });
    }
    log(`[people-frame] ${input.companion} mode=${input.mode} resolved=${resolved.length} speaker=${speaker} mentions=${mentions} notes=0 chars=${block?.length ?? 0} repeat_skipped=${repeatSkipped} index_age_s=${input.indexAgeS}`);
    return block;
  } catch (e) {
    try { log(`[people-frame] ${input.companion} failed: ${String(e).slice(0, 120)}`); } catch { /* never */ }
    return null;
  }
}
