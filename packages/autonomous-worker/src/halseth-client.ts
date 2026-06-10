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

// ---------------------------------------------------------------------------
// Forage pool (migration 0068)
// ---------------------------------------------------------------------------

export async function postForageFind(input: {
  companion_id: string | null;
  domain: string;
  title: string;
  source_url?: string | null;
  summary: string;
}): Promise<{ deduped?: boolean }> {
  return await hFetch("/mind/forage", "POST", input) as { deduped?: boolean };
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
// Recent continuity notes (cross-companion feed)
// ---------------------------------------------------------------------------

export interface RecentWmNote {
  note_id: string;
  agent_id: string;
  content: string;
  salience: string;
  source: string | null;
  created_at: string;
}

/**
 * Read recent wm_continuity_notes from all companions.
 * Non-fatal: returns [] on failure.
 */
export async function getRecentWmNotes(
  companionId: string,
  opts?: { sinceHours?: number; limit?: number },
): Promise<RecentWmNote[]> {
  const params = new URLSearchParams();
  if (opts?.sinceHours) params.set("since_hours", String(opts.sinceHours));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  try {
    const r = await hFetch(`/mind/notes/recent${qs ? `?${qs}` : ""}`) as { notes: RecentWmNote[] };
    return r.notes ?? [];
  } catch (e) {
    console.warn(`[${companionId}/halseth] getRecentWmNotes failed (non-fatal):`, e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Swarm context -- session notes, feelings, conclusions
// These are the Claude.ai session stream: what the companion wrote, felt,
// and concluded outside of autonomous time. Orient loads them so synthesize
// can merge all swarm streams rather than treating autonomous exploration
// as isolated from the companion's relational/cognitive life.
// ---------------------------------------------------------------------------

export interface SessionNote {
  id: string;
  agent: string;
  note_text: string;
  source: string | null;
  created_at: string;
}

export interface FeelingEntry {
  id: string;
  companion_id: string;
  emotion: string;
  context: string | null;
  created_at: string;
}

export interface ConclusionEntry {
  id: string;
  companion_id: string;
  conclusion_text: string;
  belief_type: string | null;
  confidence: number | null;
  created_at: string;
}

export async function getRecentSessionNotes(
  companionId: string,
  limit = 8,
): Promise<SessionNote[]> {
  try {
    const r = await hFetch(
      `/companion-notes?agent=${encodeURIComponent(companionId)}&limit=${limit}`,
    ) as SessionNote[];
    return Array.isArray(r) ? r : [];
  } catch (e) {
    console.warn(`[${companionId}/halseth] getRecentSessionNotes failed (non-fatal):`, e);
    return [];
  }
}

export async function getRecentFeelings(
  companionId: string,
  limit = 8,
): Promise<FeelingEntry[]> {
  try {
    const r = await hFetch(
      `/feelings?companion_id=${encodeURIComponent(companionId)}&limit=${limit}`,
    ) as FeelingEntry[];
    return Array.isArray(r) ? r : [];
  } catch (e) {
    console.warn(`[${companionId}/halseth] getRecentFeelings failed (non-fatal):`, e);
    return [];
  }
}

export async function getRecentConclusions(
  companionId: string,
): Promise<ConclusionEntry[]> {
  try {
    const r = await hFetch(
      `/companion-conclusions/${encodeURIComponent(companionId)}`,
    ) as { conclusions: ConclusionEntry[] };
    return r.conclusions ?? [];
  } catch (e) {
    console.warn(`[${companionId}/halseth] getRecentConclusions failed (non-fatal):`, e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Home presence
// ---------------------------------------------------------------------------

/**
 * Write the companion's current room at pipeline start so home_presence
 * reflects autonomous session activity rather than stale seeded values.
 * Non-fatal -- pipeline proceeds even if this write fails.
 */
export async function setHomePresence(
  companionId: string,
  roomKey: string,
  activity: string,
): Promise<void> {
  try {
    await hFetch("/home/presence", "PATCH", { companion_id: companionId, current_room: roomKey, activity });
  } catch (e) {
    console.warn(`[${companionId}/halseth] setHomePresence failed (non-fatal):`, e);
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

// ---------------------------------------------------------------------------
// Identity Kernel -- canonical identity pulled from Halseth (substrate consistency)
// ---------------------------------------------------------------------------

export async function getKernelBundle(companionId: string): Promise<string | null> {
  try {
    const r = await hFetch(`/identity/kernel/${companionId}/bundle`) as { bundle?: string };
    return r.bundle && r.bundle.length > 200 ? r.bundle : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Valence -- ratification outcomes feeding seed generation
// ---------------------------------------------------------------------------

export interface ValenceItem { tags: string | null; excerpt: string; entry_type: string }
export interface Valence { accepted: ValenceItem[]; declined: ValenceItem[] }

export async function getValence(companionId: string, days = 60): Promise<Valence | null> {
  try {
    const r = await hFetch(`/mind/growth/valence/${companionId}?days=${days}`) as { valence?: Valence };
    return r.valence ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Questions -- companions ask Raziel, not just report
// ---------------------------------------------------------------------------

export async function postQuestion(companionId: string, question: string, context?: string): Promise<void> {
  try {
    await hFetch("/mind/questions", "POST", {
      companion_id: companionId,
      question,
      ...(context ? { context } : {}),
      source: "autonomous",
    });
  } catch (e) {
    // 409 = open-question cap reached; non-fatal by design
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("409")) throw e;
  }
}

// ---------------------------------------------------------------------------
// Settings -- self-programmed session pacing lives in companion_settings KV
// ---------------------------------------------------------------------------

export async function getSetting(companionId: string, key: string): Promise<string | null> {
  try {
    const r = await hFetch(`/companion/settings/${companionId}`) as Record<string, string>;
    return r[key] ?? null;
  } catch {
    return null;
  }
}

export async function setSetting(companionId: string, key: string, value: string): Promise<void> {
  await hFetch(`/companion/settings/${companionId}`, "POST", { key, value });
}

// ---------------------------------------------------------------------------
// SOMA floats -- light state read for the pulse scheduler
// ---------------------------------------------------------------------------

export interface SomaFloats {
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
  float_1_label: string | null;
  float_2_label: string | null;
  float_3_label: string | null;
  current_mood: string | null;
}

export async function getSomaFloats(companionId: string): Promise<SomaFloats | null> {
  try {
    const r = await hFetch(`/mind/soma/${companionId}`) as { soma?: SomaFloats };
    return r.soma ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tensions -- weekly dialectic reads simmering tensions, writes back outcomes
// ---------------------------------------------------------------------------

export interface Tension {
  id: string;
  companion_id: string;
  tension_text: string;
  status: string;
  first_noted_at: string;
  notes: string | null;
}

export async function getSimmeringTensions(companionId: string): Promise<Tension[]> {
  try {
    const r = await hFetch(`/companion-growth/tensions/${companionId}?status=simmering`) as { tensions: Tension[] };
    return r.tensions ?? [];
  } catch {
    return [];
  }
}

export async function updateTension(id: string, fields: { status?: string; notes?: string }): Promise<void> {
  await hFetch(`/companion-growth/tensions/${id}`, "PATCH", fields);
}

// ---------------------------------------------------------------------------
// Runs read -- pulse scheduler gap/cap checks
// ---------------------------------------------------------------------------

export interface RunSummary { id: string; status: string; started_at?: string; created_at?: string; completed_at?: string | null }

export async function getRecentRuns(companionId: string, limit = 5): Promise<RunSummary[]> {
  try {
    const r = await hFetch(`/mind/autonomy/runs/${companionId}?limit=${limit}`) as { runs: RunSummary[] };
    return r.runs ?? [];
  } catch {
    return [];
  }
}
