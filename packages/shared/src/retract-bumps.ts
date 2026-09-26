/**
 * Per-channel retract bumps (rotate-on-retract, 2026-09-26), with the load and the write made
 * honest (2026-09-26 review).
 *
 * WHAT A BUMP IS. Each `<prefix>: retract` increments a per-channel counter that is folded into
 * the Hermes transcript id as `:r<n>` (hermesSessionIds), so the next turn starts a fresh gateway
 * transcript that no longer holds the retracted reply. Persisted in the companion setting
 * `hermes_retract_bumps` ({ [channelId]: n }) so a restart cannot walk the count back down and
 * reopen the old transcript.
 *
 * THE TWO DEFECTS THIS FIXES.
 *   1. The first cut loaded the setting once per process and cached the promise. getSetting
 *      folds a failed read into null, so one Halseth hiccup at boot was cached as "no bumps" for
 *      the life of the process: every channel's transcript id walked back to r0.
 *   2. The next retract then wrote the in-memory map whole. After a failed load that map held
 *      only this channel, so the write ERASED every other channel's persisted bump.
 * Now: a failed load is remembered as a failure and retried on the next need (throttled, because
 * the load sits on the reply path); a write re-reads the persisted map strictly and merges it
 * (max per channel) first, and if that read fails it does not write at all -- a write then is the
 * overwrite bug itself. The write is awaited, bounded, and its outcome is returned so the ack can
 * say "rotated (not persisted: ...)" instead of claiming a durability it does not have.
 *
 * The in-memory bump always happens, persisted or not: the rotation is what stops the echo on
 * the very next turn, and it must never wait on Halseth.
 */

export const RETRACT_BUMPS_SETTING = "hermes_retract_bumps";

export interface RetractBumpsIo {
  /** Strict read: null only for a genuinely absent setting; THROWS on any failure. */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export type BumpResult =
  | { n: number; persisted: true }
  | { n: number; persisted: false; reason: string };

/** Parse the persisted map. Malformed or non-positive entries are dropped, never thrown. */
export function parseRetractBumps(raw: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [channelId, n] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out.set(channelId, Math.floor(n));
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out (${ms}ms)`)), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

const msg = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 80);

export class RetractBumps {
  private bumps = new Map<string, number>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private lastFailAt = -Infinity;
  private readonly retryAfterMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private io: RetractBumpsIo,
    opts: { retryAfterMs?: number; timeoutMs?: number; now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.retryAfterMs = opts.retryAfterMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.warn(l));
  }

  /** The bump for a channel as this process currently knows it. */
  get(channelId: string): number {
    return this.bumps.get(channelId) ?? 0;
  }

  /** Whether the persisted map has been read successfully at least once. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  private merge(persisted: Map<string, number>): void {
    for (const [channelId, n] of persisted) {
      if (n > (this.bumps.get(channelId) ?? 0)) this.bumps.set(channelId, n);
    }
  }

  /**
   * Load the persisted map once it can be read. Never throws. A failure is NOT cached as "no
   * bumps": the next call after `retryAfterMs` tries again (the throttle keeps an unreachable
   * Halseth from adding a read timeout to every reply).
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    if (this.now() - this.lastFailAt < this.retryAfterMs) return;
    this.loading = (async () => {
      try {
        this.merge(parseRetractBumps(await withTimeout(this.io.read(), this.timeoutMs, "bumps read")));
        this.loaded = true;
      } catch (e) {
        this.lastFailAt = this.now();
        this.log(`[retract-bumps] load failed, will retry: ${msg(e)}`);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * Bump a channel: re-read the persisted map, merge (max per channel), increment, persist.
   * The in-memory increment happens on every path; only persistence can fail, and it says why.
   */
  async bump(channelId: string): Promise<BumpResult> {
    let readOk = true;
    let readErr = "";
    try {
      this.merge(parseRetractBumps(await withTimeout(this.io.read(), this.timeoutMs, "bumps read")));
      this.loaded = true;
    } catch (e) {
      readOk = false;
      readErr = msg(e);
    }
    const n = this.get(channelId) + 1;
    this.bumps.set(channelId, n);
    if (!readOk) {
      return { n, persisted: false, reason: `could not read the persisted map to merge (${readErr})` };
    }
    try {
      await withTimeout(this.io.write(JSON.stringify(Object.fromEntries(this.bumps))), this.timeoutMs, "bumps write");
      return { n, persisted: true };
    } catch (e) {
      return { n, persisted: false, reason: msg(e) };
    }
  }
}
