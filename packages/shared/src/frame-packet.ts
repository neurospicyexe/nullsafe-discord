// Per-turn current-frame packet (2026-11-01, Halseth task 7855415f). One bounded `[Right now]` block
// on the live user turn: Raziel's top open tasks, this companion's own projects, one rotating spark,
// and a calendar slot. The clock (`[Now: ...]`), place, front and imp tint already ride every turn;
// the degraded-source idea (orient-blocks "MISSING, not empty") was boot-only. This carries it per turn.
//
// Rules:
//   * Every field is bounded and omitted when EMPTY. When a source FAILS (null / throw / too slow
//     with nothing cached) the field renders one short "(tasks unavailable)" marker instead: a
//     confident blank reads as "nothing is open", which is a claim.
//   * Never blocks the reply: each source gets FRAME_SOURCE_TIMEOUT_MS; a slow source keeps loading
//     in the background (deduped) and the turn uses the last good value or the marker.
//   * Health-looking text never enters (Raziel's meds/care/biometrics are not prompt material; see
//     HEALTH_TABLES in halseth/src/director/supply-query.ts). Titles that look health-related are dropped.
//   * Mode (`FRAME_PACKET`): off | shadow | on, CODE DEFAULT shadow. Shadow builds the block and logs
//     `[frame] <c> fields= chars=` (never the text); only `on` injects.
//   * Calendar is a pluggable slot with NO reader today: returns nothing, renders nothing, and the boot
//     log says so once. No credentials live here.

import { neutralizeRecalled } from "./recalled-text.js";
import type { LibrarianClient } from "./librarian.js";
import { liveTasks } from "./task-check.js";
import { normalizeModeToken } from "./off-switch.js";

export type FramePacketMode = "off" | "shadow" | "on";
const VALID_MODES: readonly FramePacketMode[] = ["off", "shadow", "on"];
let warnedUnknownMode = false;

/** `FRAME_PACKET`, trimmed and lowercased. Unset or garbage falls to the code default, shadow. */
export function readFramePacketMode(env: NodeJS.ProcessEnv = process.env): FramePacketMode {
  const raw = normalizeModeToken(env.FRAME_PACKET);
  if (!raw) return "shadow";
  if ((VALID_MODES as readonly string[]).includes(raw)) return raw as FramePacketMode;
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    console.warn(`[frame] unknown FRAME_PACKET="${raw}"; falling back to "shadow" (valid: ${VALID_MODES.join(" | ")})`);
  }
  return "shadow";
}

export function __resetFramePacketWarnings(): void { warnedUnknownMode = false; }

export const FRAME_HEADER = "[Right now]";
export const FRAME_TOTAL_CAP = 500;
export const FRAME_CACHE_TTL_MS = 10 * 60_000;
/** A failed read is retried sooner than a good one is refreshed. */
export const FRAME_FAIL_TTL_MS = 60_000;
export const FRAME_SOURCE_TIMEOUT_MS = 1_500;
export const FRAME_TASK_MAX = 3;
export const FRAME_TASK_TITLE_CAP = 60;
export const FRAME_PROJECT_MAX = 2;
export const FRAME_PROJECT_TITLE_CAP = 60;
export const FRAME_SPARK_CAP = 120;
export const FRAME_CALENDAR_MAX = 3;
export const FRAME_CALENDAR_ITEM_CAP = 60;

export type FrameFieldName = "tasks" | "projects" | "spark" | "calendar";

/** null = the source FAILED; [] = it answered and there is nothing. A throw counts as a failure. */
export type FrameListSource = () => Promise<string[] | null>;

export interface FrameSources {
  tasks: FrameListSource;
  projects: FrameListSource;
  /** The whole spark pool; the packet picks one per Chicago hour. */
  spark: FrameListSource;
  /** Pluggable slot. null = no reader configured (nothing renders). */
  calendar: FrameListSource | null;
}

// Titles/lines that look health, meds, care or biometrics related. Deliberately broad: a dropped task
// title costs a line; a health fact in a companion's mouth costs trust (director care_fact, 2026-10-02).
const HEALTH_LIKE = new RegExp(
  "\\b(" + [
    "meds?", "medic\\w*", "dos(?:e|es|ing|age)", "pills?", "prescri\\w*", "pharmac\\w*", "refills?",
    "insulin", "glucose", "blood\\s*sugar", "bg", "a1c", "cgm", "diabet\\w*",
    "doctor", "dr\\.?", "physician", "psychiatr\\w*", "therap\\w*", "counsel\\w*", "clinic", "hospital",
    "symptom\\w*", "diagnos\\w*", "migraine", "seizure", "injection", "vaccin\\w*",
    "biometric\\w*", "hrv", "heart\\s*rate", "blood\\s*pressure", "bp", "sleep", "health\\w*", "wellness",
    "appointment", "lab\\s*(?:work|results?)", "mg", "mcg",
  ].join("|") + ")\\b",
  "i",
);

/** True when a line looks health/care related and must not ride a companion's prompt. */
export function looksHealthRelated(text: string): boolean {
  return HEALTH_LIKE.test(text);
}

/** One line, brackets and control tokens defused, whitespace collapsed, trimmed to `cap`. */
export function frameClean(raw: unknown, cap: number): string {
  if (typeof raw !== "string") return "";
  let s = neutralizeRecalled(raw).replace(/[\[\]\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > cap) s = `${s.slice(0, Math.max(1, cap - 3)).trimEnd()}...`;
  return s;
}

/** Items cleaned, health-looking ones dropped, empties dropped, capped to `max`. */
function cleanItems(items: readonly string[], max: number, cap: number): string[] {
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw === "string" && looksHealthRelated(raw)) continue;
    const s = frameClean(raw, cap);
    if (!s || looksHealthRelated(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** One spark per Chicago hour (Chicago is a whole-hour offset, so UTC hour boundaries are its hour boundaries). */
export function sparkIndex(now: number, poolSize: number): number {
  if (poolSize <= 0) return 0;
  return Math.floor(now / 3_600_000) % poolSize;
}

type CacheEntry = { at: number; ok: boolean; value: string[] };

export interface FramePacketOpts {
  sources: FrameSources;
  companion: string;
  /** Test seams. */
  sourceTimeoutMs?: number;
  cacheTtlMs?: number;
  failTtlMs?: number;
}

export interface FramePacketResult {
  /** The block, or null when nothing rendered. */
  text: string | null;
  fields: FrameFieldName[];
  chars: number;
}

export class FramePacket {
  private cache = new Map<FrameFieldName, CacheEntry>();
  private inflight = new Map<FrameFieldName, Promise<CacheEntry>>();
  private readonly timeoutMs: number;
  private readonly ttl: number;
  private readonly failTtl: number;

  constructor(private readonly opts: FramePacketOpts) {
    this.timeoutMs = opts.sourceTimeoutMs ?? FRAME_SOURCE_TIMEOUT_MS;
    this.ttl = opts.cacheTtlMs ?? FRAME_CACHE_TTL_MS;
    this.failTtl = opts.failTtlMs ?? FRAME_FAIL_TTL_MS;
  }

  private load(name: FrameFieldName, src: FrameListSource, now: number): Promise<CacheEntry> {
    const running = this.inflight.get(name);
    if (running) return running;
    const p = (async (): Promise<CacheEntry> => {
      try {
        const v = await src();
        return Array.isArray(v) ? { at: now, ok: true, value: v } : { at: now, ok: false, value: [] };
      } catch {
        return { at: now, ok: false, value: [] };
      }
    })().then(entry => {
      // A failure never evicts the last good value; it only stamps when to retry.
      const prev = this.cache.get(name);
      if (entry.ok || !prev?.ok) this.cache.set(name, entry);
      else this.cache.set(name, { ...prev, at: entry.at });
      return entry;
    }).finally(() => { this.inflight.delete(name); });
    this.inflight.set(name, p);
    return p;
  }

  /** The field's list (`ok`) or a failure. Never waits longer than the source timeout. */
  private async read(name: FrameFieldName, src: FrameListSource, now: number): Promise<{ ok: boolean; value: string[] }> {
    const hit = this.cache.get(name);
    if (hit && now - hit.at < (hit.ok ? this.ttl : this.failTtl)) return hit.ok ? { ok: true, value: hit.value } : { ok: false, value: [] };
    const pending = this.load(name, src, now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.timeoutMs); });
    const got = await Promise.race([pending, slow]);
    if (timer) clearTimeout(timer);
    if (got) return { ok: got.ok, value: got.value };
    // Too slow: keep loading in the background; this turn uses the last good value or says unavailable.
    const stale = this.cache.get(name);
    return stale?.ok ? { ok: true, value: stale.value } : { ok: false, value: [] };
  }

  async build(now: number = Date.now()): Promise<FramePacketResult> {
    const s = this.opts.sources;
    const [tasks, projects, spark, calendar] = await Promise.all([
      this.read("tasks", s.tasks, now),
      this.read("projects", s.projects, now),
      this.read("spark", s.spark, now),
      s.calendar ? this.read("calendar", s.calendar, now) : Promise.resolve(null),
    ]);

    const lines: Array<{ name: FrameFieldName; line: string }> = [];
    const list = (name: FrameFieldName, label: string, r: { ok: boolean; value: string[] }, max: number, cap: number) => {
      if (!r.ok) { lines.push({ name, line: `${label}: (${name} unavailable)` }); return; }
      const items = cleanItems(r.value, max, cap);
      if (items.length) lines.push({ name, line: `${label}: ${items.join("; ")}` });
    };
    list("tasks", "Open tasks", tasks, FRAME_TASK_MAX, FRAME_TASK_TITLE_CAP);
    list("projects", "Your projects", projects, FRAME_PROJECT_MAX, FRAME_PROJECT_TITLE_CAP);
    if (!spark.ok) {
      lines.push({ name: "spark", line: "Spark: (spark unavailable)" });
    } else {
      const pool = cleanItems(spark.value, spark.value.length, FRAME_SPARK_CAP);
      const pick = pool[sparkIndex(now, pool.length)];
      if (pick) lines.push({ name: "spark", line: `Spark: ${pick}` });
    }
    if (calendar) list("calendar", "Calendar", calendar, FRAME_CALENDAR_MAX, FRAME_CALENDAR_ITEM_CAP);

    // Hard cap: drop whole fields from the tail (calendar, spark, projects, tasks) until it fits; a
    // field is never cut mid-line into a half-claim.
    const render = () => `${FRAME_HEADER}\n${lines.map(l => l.line).join("\n")}`;
    while (lines.length > 0 && render().length > FRAME_TOTAL_CAP) lines.pop();
    if (lines.length === 0) return { text: null, fields: [], chars: 0 };
    const text = render();
    return { text, fields: lines.map(l => l.name), chars: text.length };
  }
}

/** The `[frame] <c> fields= chars=` line. Names and counts only, never the text. */
export function frameLogLine(companion: string, r: Pick<FramePacketResult, "fields" | "chars">): string {
  return `[frame] ${companion} fields=${r.fields.join(",")} chars=${r.chars}`;
}

/**
 * Boot line: names the calendar slot's state once, so "no calendar" is a stated fact and not a
 * silent absence. Returns the lines it logged (test seam).
 */
export function announceFramePacket(sources: Pick<FrameSources, "calendar">, log: (m: string) => void = console.log): string[] {
  const out: string[] = [];
  if (!sources.calendar) out.push("[frame] calendar source not configured");
  for (const m of out) log(m);
  return out;
}

const COMPANION_ASSIGNEES = new Set(["cypher", "drevan", "gaia"]);

/**
 * Live sources off the Librarian client. EVERY one is a pure GET (never `botOrient()`: Halseth's
 * execBotOrient warms heat and runs markAnswersDelivered, which consumes Raziel's answered questions):
 *   tasks    = `listTasks()`: Halseth GET /tasks (handlers/history.ts getTasks, SELECT only), urgent first,
 *              minus rows assigned to a companion.
 *   projects = `projectsOpen()`: GET /mind/projects/:id?status=open (handlers/projects.ts getProjects, SELECT
 *              on companion_projects, mig 0122), top 2.
 *   spark    = unconsumed forage finds (`forageFindsPeek`: GET /mind/forage/:id, SELECT only) plus recent
 *              listens (`recentMediaPeek`: GET /mind/media/recent, SELECT only), the same material the
 *              autonomous seed draws on; one picked per Chicago hour. Fails only if BOTH reads fail.
 *   calendar = no reader exists; null slot.
 * null from a read = FAILED, which the packet renders as a marker, never as empty.
 */
export type FrameLibrarian = Pick<LibrarianClient, "listTasks" | "projectsOpen" | "forageFindsPeek" | "recentMediaPeek">;

export function librarianFrameSources(librarian: FrameLibrarian, calendar: FrameListSource | null = null): FrameSources {
  return {
    tasks: async () => {
      const rows = await librarian.listTasks();
      if (rows === null) return null;
      return liveTasks(rows)
        .filter(r => !r.assigned_to || !COMPANION_ASSIGNEES.has(r.assigned_to.trim().toLowerCase()))
        .map(r => r.title);
    },
    projects: async () => {
      const rows = await librarian.projectsOpen();
      if (rows === null) return null;
      return rows.filter(p => p.status === "open").map(p => p.title);
    },
    spark: async () => {
      const [finds, media] = await Promise.all([librarian.forageFindsPeek(), librarian.recentMediaPeek()]);
      if (finds === null && media === null) return null;
      return [
        ...(finds ?? []).map(f => `a find: ${f.title}`),
        ...(media ?? []).filter(m => m.title).map(m => `a listen: ${m.title}${m.artist ? ` by ${m.artist}` : ""}`),
      ];
    },
    calendar,
  };
}

const packets = new Map<string, FramePacket>();

/** The process's packet for a companion, built on first use; announces the calendar slot once. */
export function framePacketFor(librarian: FrameLibrarian, companion: string): FramePacket {
  let p = packets.get(companion);
  if (!p) {
    const sources = librarianFrameSources(librarian);
    announceFramePacket(sources);
    p = new FramePacket({ sources, companion });
    packets.set(companion, p);
  }
  return p;
}

export function __resetFramePackets(): void { packets.clear(); }
