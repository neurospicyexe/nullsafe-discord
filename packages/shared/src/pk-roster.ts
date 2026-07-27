// pk-roster.ts -- offline PluralKit member recognition (2026-07-27).
//
// Why this exists: identity for a proxied message used to rest on a single 2s call to
// GET /v2/messages/{id}, made the instant the webhook arrived -- the exact moment PK is
// still writing that record. When it raced, `resolveAttribution` fell back to "unknown",
// which made the owner's own message a guest AND (via `author.bot && !isOwner`) a peer bot,
// so the cross-companion rails swallowed it. A missed reply read as the bots timing out.
//
// PK proxies always set the webhook username to the member's display name (or name), so the
// member is knowable with no per-message API call at all: fetch the system's member list once,
// index it by name, and look up locally. `GET /v2/systems/{id}/members` is public when the
// system's member list is public (Raziel's is; verified 2026-07-27, 538 members).
//
// Fail-open by construction: an empty roster degrades to the previous per-message API path.
// It never *asserts* owner -- a name has to match a system we were explicitly told about,
// so an unrelated server member with a colliding name can't inherit Raziel's tier.

export interface PkRosterMember {
  memberName: string;
  systemId: string;
  /** Discord user the system belongs to -- the sender identity a proxy stands in for. */
  discordUserId: string;
  isOwner: boolean;
}

export interface PkSystemSpec {
  systemId: string;
  discordUserId: string;
  isOwner: boolean;
}

interface PkApiMember {
  name?: string | null;
  display_name?: string | null;
}

/** Redis-ish surface (the same client bot-core already holds); optional. */
export interface RosterCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

const REFRESH_MS = 60 * 60 * 1000; // hourly; member lists change rarely
const CACHE_KEY = "ns:pk:roster:v1";
const CACHE_TTL_S = 6 * 60 * 60;

/**
 * PK renders the webhook username as `<display_name or name>` plus, when the system has a
 * tag, ` <tag>` appended. Normalizing both sides (lowercase, collapse whitespace, drop a
 * trailing " | tag" / " tag" suffix at match time) keeps lookup robust without needing to
 * know the tag.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export class PkRoster {
  private byName = new Map<string, PkRosterMember>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly systems: PkSystemSpec[],
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly cache: RosterCache | null = null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get size(): number { return this.byName.size; }
  get loaded(): boolean { return this.byName.size > 0; }

  /**
   * Identify the system member behind a PK webhook username. Exact normalized match first,
   * then a prefix match to absorb an appended system tag (`"Ash | Nullsafe"` -> `"Ash"`).
   * Returns null on any ambiguity or miss -- the caller then uses the API path.
   */
  identify(webhookUsername: string | null | undefined): PkRosterMember | null {
    if (!webhookUsername) return null;
    const key = norm(webhookUsername);
    const exact = this.byName.get(key);
    if (exact) return exact;
    // Tag-suffixed: longest registered name that the username starts with, on a word edge.
    let best: PkRosterMember | null = null;
    let bestLen = 0;
    for (const [name, member] of this.byName) {
      if (name.length <= bestLen) continue;
      if (key === name || key.startsWith(`${name} `)) { best = member; bestLen = name.length; }
    }
    return best;
  }

  /** Load from cache if present, else from the API. Safe to call repeatedly. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded && Date.now() - this.loadedAt < REFRESH_MS) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Background refresh loop; returns the timer so callers can unref/clear it. */
  startRefresh(): NodeJS.Timeout {
    const t = setInterval(() => { void this.ensureLoaded(); }, REFRESH_MS);
    t.unref?.();
    return t;
  }

  private async load(): Promise<void> {
    if (this.systems.length === 0) return;
    if (this.cache) {
      try {
        const raw = await this.cache.get(CACHE_KEY);
        if (raw) {
          const rows = JSON.parse(raw) as PkRosterMember[];
          if (Array.isArray(rows) && rows.length) {
            this.ingest(rows);
            this.loadedAt = Date.now();
            this.log(`[pk-roster] ${this.byName.size} member names from cache`);
            return;
          }
        }
      } catch { /* cache miss/corrupt -- fall through to the API */ }
    }

    const rows: Array<PkRosterMember & { _key?: string }> = [];
    for (const sys of this.systems) {
      try {
        const res = await this.fetchFn(
          `https://api.pluralkit.me/v2/systems/${sys.systemId}/members`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) {
          this.log(`[pk-roster] system ${sys.systemId}: HTTP ${res.status} -- skipped (member list private?)`);
          continue;
        }
        const members = await res.json() as PkApiMember[];
        if (!Array.isArray(members)) continue;
        for (const m of members) {
          // Display name is what PK puts on the webhook; index the raw name too so a member
          // without a display name, or one renamed since, still resolves.
          const shown = m.display_name ?? m.name;
          if (!shown) continue;
          for (const label of new Set([m.display_name, m.name].filter(Boolean) as string[])) {
            rows.push({
              memberName: shown,
              systemId: sys.systemId,
              discordUserId: sys.discordUserId,
              isOwner: sys.isOwner,
              _key: norm(label),
            });
          }
        }
      } catch (err) {
        this.log(`[pk-roster] system ${sys.systemId} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!rows.length) return; // keep whatever we already had rather than blanking it
    this.ingest(rows);
    this.loadedAt = Date.now();
    this.log(`[pk-roster] ${this.byName.size} member names across ${this.systems.length} system(s)`);
    if (this.cache) {
      try { await this.cache.set(CACHE_KEY, JSON.stringify(rows), "EX", CACHE_TTL_S); } catch { /* cache is best-effort */ }
    }
  }

  private ingest(rows: Array<PkRosterMember & { _key?: string }>): void {
    const next = new Map<string, PkRosterMember>();
    for (const r of rows) {
      const key = r._key ?? norm(r.memberName);
      const prior = next.get(key);
      // Cross-system name collision: neither side wins (identify() must not guess a tier).
      if (prior && prior.systemId !== r.systemId) { next.delete(key); continue; }
      next.set(key, { memberName: r.memberName, systemId: r.systemId, discordUserId: r.discordUserId, isOwner: r.isOwner });
    }
    this.byName = next;
  }
}

/** Build the system list from env-style config; systems without an id are dropped. */
export function pkSystemsFromEnv(env: {
  ownerSystemId?: string | undefined;
  ownerDiscordId: string;
  blueSystemId?: string | undefined;
  blueDiscordId?: string | undefined;
}): PkSystemSpec[] {
  const out: PkSystemSpec[] = [];
  if (env.ownerSystemId) out.push({ systemId: env.ownerSystemId, discordUserId: env.ownerDiscordId, isOwner: true });
  if (env.blueSystemId && env.blueDiscordId) out.push({ systemId: env.blueSystemId, discordUserId: env.blueDiscordId, isOwner: false });
  return out;
}
