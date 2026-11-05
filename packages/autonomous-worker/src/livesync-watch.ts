// livesync-watch.ts -- notice when Obsidian LiveSync (PC -> CouchDB on this VPS) stalls, try to
// heal it, and tell Raziel the same day when it cannot be healed.
//
// WHY HERE and not in the Halseth Guardian: Guardian detectors run inside the Cloudflare Worker,
// which can reach neither the VPS-local CouchDB (:5984) nor the reverse-tunnelled Obsidian REST
// API (127.0.0.1:27124). The autonomous worker runs on the VPS and can. Origin: 2026-11-02 20:55Z
// LiveSync on the PC paused after a plugin auto-update and nothing alarmed for 20 hours.
//
// Signal: the newest FILE doc's mtime in the CouchDB replica (machine writers land
// raziel/sessions/*-summary.md many times a day, so a healthy replica is rarely hours stale while
// the PC is on). Credentials come from Second Brain's own config file, so no new secrets in .env.
// Never logs credentials or file contents; paths are not even logged, only ages.
//
// The decision is a pure function (decideProbe) so the stale/fresh, PC on/off, healed/not and
// once-a-day rules are testable without a network.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import { notifyDiscord } from "./discord-notify.js";
import { isOffToken } from "@nullsafe/shared";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CMD_REPLICATE = "obsidian-livesync:livesync-replicate";
const CMD_REVIEW_PAUSE = "obsidian-livesync:livesync-review-compatibility-pause";

// ── knobs (env, with defaults) ───────────────────────────────────────────────────────────────────
function numEnv(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
export interface LiveSyncThresholds {
  /** PC on: stale beyond this many hours -> nudge, then flag. LIVESYNC_STALE_HOURS (3). */
  staleHours: number;
  /** PC off: only flag beyond this many hours. LIVESYNC_STALE_OFF_HOURS (24). */
  staleOffHours: number;
}
export function thresholdsFromEnv(): LiveSyncThresholds {
  return { staleHours: numEnv("LIVESYNC_STALE_HOURS", 3), staleOffHours: numEnv("LIVESYNC_STALE_OFF_HOURS", 24) };
}

// ── persisted state (once-a-day + clear-when-fresh) ──────────────────────────────────────────────
export interface LiveSyncState {
  /** Epoch ms of the last flag we raised; null when no flag is live. */
  flagRaisedAt: number | null;
  flagKind: "stalled" | "pc_off" | null;
}
export const EMPTY_STATE: LiveSyncState = { flagRaisedAt: null, flagKind: null };

// ── pure decision ────────────────────────────────────────────────────────────────────────────────
export type ProbeDecision =
  | { action: "fresh"; clearFlag: boolean }
  | { action: "nudge" }
  | { action: "flag"; kind: "stalled"; repeat: boolean }
  | { action: "flag"; kind: "pc_off"; repeat: boolean }
  | { action: "wait"; reason: "pc_off_within_grace" };

export interface ProbeInput {
  /** Age of the newest file doc, ms. */
  ageMs: number;
  pcOn: boolean;
  /** Set once a nudge has been sent this tick and the age re-read. */
  nudged?: boolean;
  now: number;
  state: LiveSyncState;
  t: LiveSyncThresholds;
}

/**
 * One pure step. The orchestrator calls it with `nudged` unset; on `nudge` it sends the command,
 * waits, re-reads the age and calls again with `nudged: true`.
 */
export function decideProbe(i: ProbeInput): ProbeDecision {
  const staleMs = i.t.staleHours * HOUR_MS;
  const offMs = i.t.staleOffHours * HOUR_MS;
  const live = i.state.flagRaisedAt !== null;
  // A flag raised <24h ago is not repeated; one older than that is raised again.
  const repeat = live && i.now - (i.state.flagRaisedAt as number) < DAY_MS;

  if (!i.pcOn) {
    // PC off is not an alarm by itself: only the long-stale case flags, with its own wording.
    if (i.ageMs > offMs) return { action: "flag", kind: "pc_off", repeat };
    return { action: "wait", reason: "pc_off_within_grace" };
  }
  if (i.ageMs <= staleMs) return { action: "fresh", clearFlag: live };
  if (!i.nudged) return { action: "nudge" };
  return { action: "flag", kind: "stalled", repeat };
}

// ── wording ──────────────────────────────────────────────────────────────────────────────────────
export function fmtLocal(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(ms));
}
export function fmtAge(ms: number): string {
  const h = ms / HOUR_MS;
  return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}
export function composeFlagText(kind: "stalled" | "pc_off", newestMtime: number, ageMs: number): string {
  if (kind === "stalled") {
    return (
      `[stuck:livesync] Obsidian on the PC stopped syncing at ${fmtLocal(newestMtime)} (${fmtAge(ageMs)} ago); ` +
      `a Sync-now nudge did not heal it. Open Obsidian and approve the sync window, or restart it. ` +
      `The "why paused" dialog is waiting on the PC screen.`
    );
  }
  return (
    `[stuck:livesync] The vault replica has seen nothing new since ${fmtLocal(newestMtime)} (${fmtAge(ageMs)} ago) ` +
    `and the PC seems off (Obsidian is unreachable). Turn it on and open Obsidian to catch up.`
  );
}

// ── I/O: CouchDB ─────────────────────────────────────────────────────────────────────────────────
interface SbConfig {
  couchdb: { url: string; db: string; username: string; password: string };
  obsidian_rest: { url: string; api_key: string };
}
function loadConfig(): SbConfig | null {
  const p = process.env["LIVESYNC_SB_CONFIG"] ?? "/home/nullsafe/nullsafe-second-brain/second-brain.config.json";
  try {
    const c = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SbConfig>;
    if (!c.couchdb?.url || !c.couchdb.db || !c.obsidian_rest?.url) return null;
    return c as SbConfig;
  } catch {
    return null;
  }
}

/**
 * Newest FILE doc mtime (ms). _changes interleaves chunk "leaf" docs that carry no path/mtime, so
 * page through descending changes until a doc with both appears. Returns null if none found or the
 * request fails.
 */
export async function newestFileMtime(cfg: SbConfig["couchdb"], fetchFn: typeof fetch = fetch): Promise<number | null> {
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  const base = `${cfg.url.replace(/\/$/, "")}/${cfg.db}/_changes`;
  const PAGE = 50;
  let best: number | null = null;
  for (let page = 0; page < 6; page++) {
    const res = await fetchFn(`${base}?descending=true&limit=${PAGE}&skip=${page * PAGE}&include_docs=true`, {
      headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ doc?: { path?: string; mtime?: number; deleted?: boolean }; deleted?: boolean }> };
    const rows = body.results ?? [];
    for (const r of rows) {
      const d = r.doc;
      if (!d || r.deleted || d.deleted || typeof d.path !== "string" || typeof d.mtime !== "number") continue;
      if (best === null || d.mtime > best) best = d.mtime;
    }
    if (best !== null || rows.length < PAGE) return best;
  }
  return best;
}

// ── I/O: Obsidian Local REST (self-signed, loopback tunnel) ──────────────────────────────────────
function restCall(cfg: SbConfig["obsidian_rest"], method: "GET" | "POST", urlPath: string, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(cfg.url.replace(/\/$/, "") + urlPath); } catch { return resolve(null); }
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname, method,
        headers: { Authorization: `Bearer ${cfg.api_key}`, "Content-Length": 0 },
        // Self-signed cert on a loopback reverse-SSH tunnel: verification is skipped for
        // loopback ONLY; any other host is verified normally.
        rejectUnauthorized: !(u.hostname === "127.0.0.1" || u.hostname === "localhost"), timeout: timeoutMs },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? null)); },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── state file ───────────────────────────────────────────────────────────────────────────────────
function statePath(): string {
  const want = process.env["LIVESYNC_STATE_FILE"] ?? "/app/logs/livesync-watch-state.json";
  return fs.existsSync(path.dirname(want)) ? want : path.join(os.tmpdir(), "livesync-watch-state.json");
}
export function loadState(): LiveSyncState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<LiveSyncState>;
    if (typeof s.flagRaisedAt === "number") return { flagRaisedAt: s.flagRaisedAt, flagKind: s.flagKind === "pc_off" ? "pc_off" : "stalled" };
  } catch { /* none yet */ }
  return { ...EMPTY_STATE };
}
function saveState(s: LiveSyncState): void {
  try { fs.writeFileSync(statePath(), JSON.stringify(s)); } catch (e) { console.warn("[livesync] state write failed:", String(e)); }
}

// ── orchestrator ─────────────────────────────────────────────────────────────────────────────────
export interface LiveSyncDeps {
  cfg: SbConfig | null;
  newest: () => Promise<number | null>;
  restPing: () => Promise<boolean>;
  restCommand: (id: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  notify: (text: string) => Promise<boolean>;
  now: () => number;
  state: LiveSyncState;
  saveState: (s: LiveSyncState) => void;
  t: LiveSyncThresholds;
  nudgeWaitMs: number;
}

export type LiveSyncOutcome =
  | "skipped" | "unreadable" | "fresh" | "recovered" | "healed" | "waiting_pc_off"
  | "flagged_stalled" | "flagged_pc_off" | "flag_suppressed";

/** One probe. Never throws. */
export async function runLiveSyncProbe(d: LiveSyncDeps): Promise<LiveSyncOutcome> {
  try {
    let mtime = await d.newest();
    if (mtime === null) { console.warn("[livesync] could not read newest file mtime (CouchDB unreadable or empty)"); return "unreadable"; }
    const pcOn = await d.restPing();
    let ageMs = d.now() - mtime;
    let step = decideProbe({ ageMs, pcOn, now: d.now(), state: d.state, t: d.t });

    if (step.action === "nudge") {
      const ok = await d.restCommand(CMD_REPLICATE);
      await d.sleep(d.nudgeWaitMs);
      const again = await d.newest();
      if (again !== null) { mtime = again; ageMs = d.now() - mtime; }
      const healed = ok && ageMs <= d.t.staleHours * HOUR_MS;
      console.log(`[livesync] nudged: command ${ok ? "sent" : "FAILED"}, age ${fmtAge(ageMs)} after, ${healed ? "healed" : "still stale"}`);
      step = decideProbe({ ageMs, pcOn, nudged: true, now: d.now(), state: d.state, t: d.t });
      if (step.action === "fresh") return "healed";
    }

    switch (step.action) {
      case "fresh": {
        if (step.clearFlag) {
          d.saveState({ ...EMPTY_STATE });
          d.state = { ...EMPTY_STATE };
          console.log("[livesync] fresh again; flag cleared");
          await d.notify("[stuck:livesync] cleared: the vault is syncing again.");
          return "recovered";
        }
        return "fresh";
      }
      case "wait":
        console.log(`[livesync] stale ${fmtAge(ageMs)} but PC off (within ${d.t.staleOffHours}h grace); no alarm`);
        return "waiting_pc_off";
      case "flag": {
        if (step.repeat) {
          console.log(`[livesync] flag ${step.kind} already raised within 24h (age ${fmtAge(ageMs)}); not repeating`);
          return "flag_suppressed";
        }
        const text = composeFlagText(step.kind, mtime, ageMs);
        console.warn(`[livesync] ${step.kind}: age ${fmtAge(ageMs)}`);
        const sent = await d.notify(text);
        // Only claim the flag (and burn the once-a-day slot) if Raziel was actually told.
        if (sent) {
          const next: LiveSyncState = { flagRaisedAt: d.now(), flagKind: step.kind };
          d.saveState(next);
          d.state = next;
        }
        if (step.kind === "stalled") {
          const shown = await d.restCommand(CMD_REVIEW_PAUSE);
          console.log(`[livesync] review-compatibility-pause dialog ${shown ? "requested" : "request FAILED"}`);
        }
        return step.kind === "stalled" ? "flagged_stalled" : "flagged_pc_off";
      }
      default:
        return "skipped";
    }
  } catch (e) {
    console.error("[livesync] probe failed:", String(e));
    return "unreadable";
  }
}

let running = false;

/** Scheduler entry. LIVESYNC_WATCH=off kills it. */
export async function runLiveSyncWatchTick(): Promise<LiveSyncOutcome> {
  if (isOffToken(process.env["LIVESYNC_WATCH"])) return "skipped";
  if (running) return "skipped";
  const cfg = loadConfig();
  if (!cfg) { console.warn("[livesync] second-brain config unreadable; watch idle"); return "skipped"; }
  running = true;
  try {
    const channel = process.env["LIVESYNC_NOTICE_CHANNEL_ID"] ?? process.env["VIBECHECK_CHANNEL_ID"];
    return await runLiveSyncProbe({
      cfg,
      newest: () => newestFileMtime(cfg.couchdb).catch(() => null),
      restPing: async () => (await restCall(cfg.obsidian_rest, "GET", "/")) !== null,
      restCommand: async (id) => {
        const code = await restCall(cfg.obsidian_rest, "POST", `/commands/${id}/`);
        return code !== null && code < 300;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      notify: async (text) => (await notifyDiscord(channel, text, "livesync")).sent,
      now: () => Date.now(),
      state: loadState(),
      saveState,
      t: thresholdsFromEnv(),
      nudgeWaitMs: numEnv("LIVESYNC_NUDGE_WAIT_MS", 120_000),
    });
  } finally {
    running = false;
  }
}
