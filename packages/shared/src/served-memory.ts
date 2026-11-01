// served-memory.ts -- per-turn audit of WHICH memory items were injected into a reply (2026-11-01,
// Halseth task 538ab03b item 1). Before this the handler injected vault recall, own notes, tripwires,
// facts, cross-room lines and more, and nothing recorded which, so "why did he say that" could not
// be answered from evidence.
//
// One JSONL row per reply turn, written once at the end of the turn beside the `[turn]` line:
//
//   {"at":"...","c":"drevan","ch":"...","msg":"...","transcript":"...","outcome":"posted",
//    "sources":{"vault":["discord-live/123/456"],"own_notes":["n_ab12"],"facts":["f_9"]},"n":3}
//
// IDS ONLY. Never memory text; the row type has no field that could hold it. Sources are collected
// by the handler through `noteServed()` (a no-op outside a turn) onto the ambient TurnTrace.
//
// SERVED_MEMORY_AUDIT=off/0/false/no is the kill switch (default ON). SERVED_MEMORY_LOG overrides the
// path (default /app/logs/served-memory.jsonl). Never throws, never blocks: the append is detached.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { currentTurn } from "./turn-telemetry.js";

const OFF = new Set(["off", "0", "false", "no"]);
export const SERVED_MEMORY_DEFAULT_LOG = "/app/logs/served-memory.jsonl";

export function servedMemoryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !OFF.has((env["SERVED_MEMORY_AUDIT"] ?? "").trim().toLowerCase());
}

export function servedMemoryPath(env: Record<string, string | undefined> = process.env): string {
  return (env["SERVED_MEMORY_LOG"] ?? "").trim() || SERVED_MEMORY_DEFAULT_LOG;
}

/** Sources the handler reports. Free-form string keys are allowed; these are the ones in use. */
export type ServedSource =
  | "vault" | "own_notes" | "tripwire" | "facts" | "cross_room" | "watchalong" | "thread_spine";

export interface ServedMemoryRow {
  at: string;
  c: string;
  ch: string;
  msg: string;
  transcript: string | null;
  outcome: string;
  sources: Record<string, string[]>;
  n: number;
}

const ID_CAP = 200;
const PER_SOURCE_CAP = 40;

/** Keep only short, id-looking strings: an id is never prose, so a stray text field cannot slip in. */
export function cleanIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const s = String(raw).trim();
    if (!s || s.length > ID_CAP || /\s/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= PER_SOURCE_CAP) break;
  }
  return out;
}

export function buildServedRow(i: {
  at: string; companion: string; channelId: string; messageId: string;
  transcriptId: string | null; outcome: string; served: ReadonlyMap<string, ReadonlySet<string>>;
}): ServedMemoryRow {
  const sources: Record<string, string[]> = {};
  let n = 0;
  for (const [k, set] of i.served) {
    const ids = cleanIds([...set]);
    if (ids.length) { sources[k] = ids; n += ids.length; }
  }
  return { at: i.at, c: i.companion, ch: i.channelId, msg: i.messageId, transcript: i.transcriptId, outcome: i.outcome, sources, n };
}

/** Detached append. Resolves never-rejecting; a missing directory is created best-effort. */
export function appendServedRow(row: ServedMemoryRow, env: Record<string, string | undefined> = process.env): void {
  try {
    if (!servedMemoryEnabled(env)) return;
    const explicit = (env["SERVED_MEMORY_LOG"] ?? "").trim();
    // Unit tests must not scribble on the default path; an explicit path still writes.
    if (!explicit && env["NODE_ENV"] === "test") return;
    const file = servedMemoryPath(env);
    const line = JSON.stringify(row) + "\n";
    void (async () => {
      try {
        try { await fsp.mkdir(path.dirname(file), { recursive: true }); } catch { /* best effort */ }
        await fsp.appendFile(file, line, "utf8");
      } catch { /* an audit log is never the reason a turn fails */ }
    })();
  } catch { /* never throws */ }
}

/** Handler hook: report ids injected into the ambient turn. No-op outside a turn. Never throws. */
export function noteServed(source: ServedSource | string, ids: readonly unknown[]): void {
  try { currentTurn()?.addServed(source, cleanIds(ids)); } catch { /* never throws */ }
}

/** Handler hook: the gateway transcript id for the turn, once known. */
export function noteTranscript(id: string | null | undefined): void {
  try { if (id) currentTurn()?.setTranscript(id); } catch { /* never throws */ }
}
