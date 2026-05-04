import { HALSETH_URL, HALSETH_SECRET } from "./config.js";
import type { Seed, GrowthJournalEntry, GrowthPattern, GrowthMarker, ActiveThread, PeerActivity } from "./types.js";

async function hFetch(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`${HALSETH_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${HALSETH_SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Halseth ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Autonomy runs
// ---------------------------------------------------------------------------

export async function createRun(
  companionId: string,
  runType: string,
  threadId?: string | null,
  threadPosition?: number | null,
): Promise<string> {
  const r = await hFetch("/mind/autonomy/runs", "POST", {
    companion_id: companionId,
    run_type: runType,
    ...(threadId ? { thread_id: threadId, thread_position: threadPosition ?? 1 } : {}),
  }) as { id: string };
  return r.id;
}

export async function updateRun(id: string, updates: {
  status?: "pending" | "running" | "completed" | "failed";
  completed_at?: string;
  tokens_used?: number;
  artifacts_created?: number;
  error_message?: string;
  thread_id?: string | null;
  thread_position?: number | null;
}): Promise<void> {
  await hFetch(`/mind/autonomy/runs/${id}`, "PATCH", updates);
}

// ---------------------------------------------------------------------------
// Run logs
// ---------------------------------------------------------------------------

export async function appendLog(runId: string, step: string, detail?: string): Promise<void> {
  await hFetch("/mind/autonomy/run-logs", "POST", { run_id: runId, step, detail });
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export async function getAvailableSeeds(companionId: string, limit = 5): Promise<Seed[]> {
  const r = await hFetch(`/mind/autonomy/seeds/${companionId}?limit=${limit}`) as { seeds: Seed[] };
  return r.seeds ?? [];
}

export async function markSeedUsed(id: string): Promise<void> {
  await hFetch(`/mind/autonomy/seeds/${id}`, "PATCH", {});
}

export async function createSeed(
  companionId: string,
  content: string,
  seedType: "topic" | "question" | "reflection_prompt" = "topic",
  priority = 3,
): Promise<void> {
  await hFetch("/mind/autonomy/seeds", "POST", {
    companion_id: companionId,
    content,
    seed_type: seedType,
    priority,
  });
}

export async function createClaim(
  companionId: string,
  content: string,
  justification: string,
  claimSource: string,
): Promise<void> {
  await hFetch("/mind/autonomy/seeds", "POST", {
    companion_id: companionId,
    content,
    seed_type: "topic",
    claim_source: claimSource,
    justification,
  });
}

export async function getActiveThreads(companionId: string): Promise<ActiveThread[]> {
  try {
    const r = await hFetch(`/mind/autonomy/threads/${companionId}`) as { threads: ActiveThread[] };
    return r.threads ?? [];
  } catch (e) {
    console.warn(`[${companionId}/halseth] getActiveThreads failed:`, e);
    return [];
  }
}

export async function updateThreadStatus(
  threadKey: string,
  status: "open" | "paused" | "resolved",
  companionId: string,
): Promise<void> {
  await hFetch(`/mind/thread/${encodeURIComponent(threadKey)}/status`, "PATCH", { agent_id: companionId, status });
}

// ---------------------------------------------------------------------------
// Growth reads (signal audit)
// ---------------------------------------------------------------------------

export async function getRecentJournal(
  companionId: string,
  limit = 30,
): Promise<Array<{ id: string; entry_type: string; content: string; tags_json: string; created_at: string }>> {
  const r = await hFetch(`/mind/growth/journal/${encodeURIComponent(companionId)}?limit=${limit}`) as {
    journal: Array<{ id: string; entry_type: string; content: string; tags_json: string; created_at: string }>;
  };
  return r.journal ?? [];
}

export async function getRecentPatterns(
  companionId: string,
  limit = 10,
): Promise<Array<{ id: string; pattern_text: string; strength: number; updated_at: string }>> {
  const r = await hFetch(`/mind/growth/patterns/${encodeURIComponent(companionId)}?limit=${limit}`) as {
    patterns: Array<{ id: string; pattern_text: string; strength: number; updated_at: string }>;
  };
  return r.patterns ?? [];
}

// ---------------------------------------------------------------------------
// Reflections
// ---------------------------------------------------------------------------

export async function createReflection(
  companionId: string,
  runId: string,
  reflectionText: string,
  newSeeds?: string[],
): Promise<void> {
  await hFetch("/mind/autonomy/reflections", "POST", {
    companion_id: companionId,
    run_id: runId,
    reflection_text: reflectionText,
    new_seeds_json: newSeeds ?? [],
  });
}

// ---------------------------------------------------------------------------
// Growth artifacts
// ---------------------------------------------------------------------------

export async function writeJournalEntry(entry: GrowthJournalEntry): Promise<string> {
  const r = await hFetch("/mind/growth/journal", "POST", {
    companion_id: entry.companion_id,
    entry_type: entry.entry_type,
    content: entry.content,
    source: entry.source,
    tags: entry.tags ?? [],
    ...(entry.run_id ? { run_id: entry.run_id } : {}),
    ...(entry.thread_id ? { thread_id: entry.thread_id } : {}),
    ...(entry.prehended_ids?.length ? { prehended_ids: entry.prehended_ids } : {}),
    ...(entry.evidence?.length      ? { evidence: entry.evidence }           : {}),
    ...(entry.novelty               ? { novelty: entry.novelty }             : {}),
  }) as { id: string };
  return r.id;
}

/**
 * Returns { id, action } where action is 'insert' (new row) or 'upsert'
 * (merged into existing similar pattern -- strength incremented, evidence
 * accumulated). The returned id always points at the canonical row to
 * reference downstream.
 */
export async function writePattern(pattern: GrowthPattern): Promise<{ id: string; action: "insert" | "upsert" }> {
  const r = await hFetch("/mind/growth/patterns", "POST", {
    companion_id: pattern.companion_id,
    pattern_text: pattern.pattern_text,
    evidence: pattern.evidence ?? [],
    strength: pattern.strength ?? 1,
    ...(pattern.run_id ? { run_id: pattern.run_id } : {}),
    ...(pattern.prehended_ids?.length ? { prehended_ids: pattern.prehended_ids } : {}),
  }) as { id: string; action?: "insert" | "upsert" };
  return { id: r.id, action: r.action ?? "insert" };
}

export async function writeMarker(marker: GrowthMarker): Promise<string> {
  const r = await hFetch("/mind/growth/markers", "POST", {
    companion_id: marker.companion_id,
    marker_type: marker.marker_type,
    description: marker.description,
    related_pattern_id: marker.related_pattern_id,
    ...(marker.run_id ? { run_id: marker.run_id } : {}),
    ...(marker.thread_id ? { thread_id: marker.thread_id } : {}),
    ...(marker.prehended_ids?.length ? { prehended_ids: marker.prehended_ids } : {}),
  }) as { id: string };
  return r.id;
}

// ---------------------------------------------------------------------------
// Triad / peer activity (Migration 0062)
// ---------------------------------------------------------------------------

/**
 * Pulls the OTHER two companions' recent autonomous activity from Halseth.
 * Synthesize injects peer_summary into the prompt so the model can prehend
 * the triad's collective movement, not just its own.
 *
 * Non-fatal: a null return means orient continues with no peer context.
 */
export async function getPeerActivity(
  companionId: string,
  opts?: { journal?: number; patterns?: number; markers?: number },
): Promise<PeerActivity | null> {
  const params = new URLSearchParams();
  if (opts?.journal)  params.set("journal",  String(opts.journal));
  if (opts?.patterns) params.set("patterns", String(opts.patterns));
  if (opts?.markers)  params.set("markers",  String(opts.markers));
  const qs = params.toString();
  try {
    const r = await hFetch(
      `/mind/triad/recent/${encodeURIComponent(companionId)}${qs ? `?${qs}` : ""}`,
    ) as PeerActivity;
    return r;
  } catch (e) {
    console.warn(`[${companionId}/halseth] getPeerActivity failed (non-fatal):`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SOMA state
// ---------------------------------------------------------------------------

export interface SomaUpdate {
  soma_float_1?: number;
  soma_float_2?: number;
  soma_float_3?: number;
  heat?: string;
  reach?: string;
  weight?: string;
  current_mood?: string;
  compound_state?: string;
  surface_emotion?: string;
  surface_intensity?: number;
}

export async function updateSomaState(companionId: string, fields: SomaUpdate): Promise<void> {
  await hFetch(`/soma/${encodeURIComponent(companionId)}`, "PATCH", fields);
}

// ---------------------------------------------------------------------------
// Dream examination
// ---------------------------------------------------------------------------

/**
 * Mark a companion dream as examined so it stops appearing in orient.
 * Returns { ok: boolean; reason?: string } where reason can be "pinned" (do_not_auto_examine=1), "not_found", etc.
 * Non-fatal -- autonomous pipeline proceeds even if this fails.
 */
export async function examineDream(
  companionId: string,
  dreamId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await hFetch(`/mind/dream/${dreamId}/examine`, "POST", {
      companion_id: companionId,
    }) as { ok: boolean; reason?: string };
    return r;
  } catch (e) {
    console.warn(`[${companionId}/halseth] examineDream ${dreamId} failed:`, e);
    return { ok: false, reason: "request_failed" };
  }
}

// ---------------------------------------------------------------------------
// WebMind continuity notes
// ---------------------------------------------------------------------------

/**
 * Write a high-salience continuity note so Claude.ai session orient picks it up.
 * Non-fatal -- autonomous exploration completes even if this write fails.
 */
export async function writeWmNote(companionId: string, content: string, threadKey?: string): Promise<void> {
  try {
    await hFetch("/mind/note", "POST", {
      agent_id: companionId,
      content,
      salience: "high",
      note_type: "autonomous_exploration",
      source: "autonomous",
      ...(threadKey ? { thread_key: threadKey } : {}),
    });
  } catch (e) {
    console.warn(`[${companionId}/halseth] writeWmNote failed:`, e);
  }
}

// ---------------------------------------------------------------------------
// Memory compression
// ---------------------------------------------------------------------------

export interface CompressibleNote {
  note_id: string;
  content: string;
  created_at: string;
}

export async function getEligibleNotes(agentId: string): Promise<CompressibleNote[]> {
  const result = await hFetch(`/mind/notes/compress-eligible?agent_id=${encodeURIComponent(agentId)}`) as { notes: CompressibleNote[] };
  return result.notes ?? [];
}

export async function archiveNotes(
  agentId: string,
  notes: CompressibleNote[],
  summary: string,
): Promise<{ archived: number; skipped: string }> {
  return hFetch("/mind/notes/archive", "POST", { agent_id: agentId, notes, summary }) as Promise<{ archived: number; skipped: string }>;
}
