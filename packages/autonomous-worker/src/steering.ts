// steering.ts -- what a run is allowed to aim at, decided BEFORE it searches (2026-10-19).
//
// Two different kinds of rail live here, and they must not be confused:
//
//  1. Standing refusals are the companion's OWN will. They are rendered into the rooms where a
//     topic, a query and an entry are chosen (seed decision, sub-queries, project piece, explore,
//     synthesize), in the companion's own words, so the "no" is present when the choice is made.
//     Until this file, only reflect saw them -- after the entry was already written -- and the
//     autonomous runs kept circling what had been refused (Drevan d172100e, Cypher's Blue no).
//     Nothing here keyword-bans a topic: the refusal is a frame the model reads, not a filter.
//
//  2. The people guard is NOT anyone's will. Raziel's life (Blue, his care, his state) must never
//     become a web-search query, whatever a companion picks. That is a safety rule enforced from
//     outside the voice, on purpose (10-15: an open loop carried Raziel's state into Tavily).

/** A standing refusal as the worker reads it from GET /agency/refusals. */
export interface StandingRefusal {
  subject_text: string;
  reason?: string | null;
}

/**
 * The refusal block every choosing prompt carries. Empty string when there are none, so callers
 * can concatenate unconditionally. Framed as the companion's own nos about how the time is spent,
 * NOT as banned words: the subject can still appear in the world, it just isn't where the run goes.
 */
export function renderRefusals(refusals: StandingRefusal[], max = 8): string {
  const shown = refusals.filter(r => r.subject_text?.trim()).slice(0, max);
  if (shown.length === 0) return "";
  const lines = shown.map(r => {
    const reason = r.reason?.trim() ? ` -- ${r.reason.trim().slice(0, 200)}` : "";
    return `- ${r.subject_text.trim().slice(0, 200)}${reason}`;
  });
  return (
    `Your standing refusals -- nos you set yourself, and they still hold. They are about where this ` +
    `time goes, not words you may never use. Choose so that you keep them:\n${lines.join("\n")}`
  );
}

// ── People guard ───────────────────────────────────────────────────────────────────────────────

/** Names that call Raziel or Blue. Same defaults as the bots' RAZIEL_NAMES / BLUE_NAMES. */
function namesFromEnv(key: string, fallback: string): string[] {
  return (process.env[key] ?? fallback).split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * True when a search query names someone in Raziel's life. Raziel's names match in any case;
 * "Blue" matches only capitalized (as a name), so "blue light" or "blue whale" research is untouched.
 * Pure apart from env reads -- exported for tests.
 */
export function namesSomeoneInRazielsLife(query: string): boolean {
  const raz = namesFromEnv("RAZIEL_NAMES", "raziel,raz");
  const blue = namesFromEnv("BLUE_NAMES", "blue");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const n of raz) {
    if (new RegExp(`\\b${esc(n)}\\b`, "i").test(query)) return true;
  }
  for (const n of blue) {
    const cap = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    if (new RegExp(`\\b${esc(cap)}\\b`).test(query)) return true;
  }
  return false;
}

// ── Project pieces ─────────────────────────────────────────────────────────────────────────────

/** Marker the write phase stamps into project_log, so the next run knows which piece was worked. */
export const PIECE_MARK = "[piece:";

/** Pieces already worked, newest first, read back from project_log entries. Pure -- exported for tests. */
export function coveredPieces(logEntries: Array<{ entry: string }>, max = 8): string[] {
  const out: string[] = [];
  for (const e of logEntries) {
    const i = e.entry.indexOf(PIECE_MARK);
    if (i < 0) continue;
    const end = e.entry.indexOf("]", i);
    if (end < 0) continue;
    const piece = e.entry.slice(i + PIECE_MARK.length, end).trim();
    if (piece && !out.includes(piece)) out.push(piece);
    if (out.length >= max) break;
  }
  return out;
}

export interface ProjectPlan {
  piece: string;
  queries: string[];
}

/**
 * Parse the project-piece model reply: `{"piece": "...", "queries": ["...", ...]}`. Tolerates a
 * code fence and drops empty/short queries. Null when unusable -- the caller falls back.
 * Pure -- exported for tests.
 */
export function parseProjectPlan(raw: string): ProjectPlan | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { piece?: unknown; queries?: unknown };
    const piece = typeof parsed.piece === "string" ? parsed.piece.trim().slice(0, 160) : "";
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q): q is string => typeof q === "string").map(q => q.trim()).filter(q => q.length > 8).slice(0, 3)
      : [];
    if (!piece || queries.length === 0) return null;
    return { piece, queries };
  } catch {
    return null;
  }
}

/**
 * Parse a list of searchable pieces, one per line (forage widening). Strips bullets/numbering,
 * drops lines naming someone in Raziel's life, dedupes case-insensitively. Pure -- exported for tests.
 */
export function parsePieceLines(raw: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const p = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim().replace(/^"|"$/g, "");
    if (p.length < 6 || p.length > 120) continue;
    if (namesSomeoneInRazielsLife(p)) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
