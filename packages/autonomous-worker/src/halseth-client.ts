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

/** Oldest accepted canon -- reconsolidation candidates for the reflect phase (0074). */
export async function getAcceptedJournalSample(
  companionId: string,
  limit = 5,
): Promise<Array<{ id: string; entry_type: string; content: string; created_at: string }>> {
  const r = await hFetch(`/mind/growth/journal/${encodeURIComponent(companionId)}?status=accepted&limit=${limit}`) as {
    journal: Array<{ id: string; entry_type: string; content: string; created_at: string }>;
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
    ...(entry.supersedes_id         ? { supersedes_id: entry.supersedes_id } : {}),
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

// Self-model (0070): record a companion-authored self-observation at confidence 0.3.
// Identical observations dedup server-side. The companion CONFIRMS/REVISES its own
// developing observations across autonomous sessions (self-testing -- see
// getDevelopingSelfModel + patchSelfModel below); only GRADUATION stays human-gated
// (orient proposes it in a human-present session once a row reaches 'ready').
export async function postSelfObservation(companionId: string, observation: string, domain?: string, kind: "preference" | "skill" = "preference"): Promise<void> {
  await hFetch("/mind/self-model", "POST", {
    companion_id: companionId,
    observation,
    ...(domain ? { domain } : {}),
    ...(kind === "skill" ? { kind } : {}),
  });
}

export interface DevelopingObservation {
  id: string;
  observation: string;
  domain: string | null;
  confidence: number;
  kind: "preference" | "skill";
}

// Load the companion's still-developing self-model rows so reflect can re-test them.
// Without this surfacing, a row posted at 0.3 is never seen again and can never climb
// to 'ready' -- which is exactly why the ladder produced zero real graduations.
export async function getDevelopingSelfModel(companionId: string, limit = 8): Promise<DevelopingObservation[]> {
  try {
    const r = await hFetch(`/mind/self-model/${companionId}?status=developing&limit=${limit}`) as {
      observations?: Array<{ id?: string; observation?: string; domain?: string | null; confidence?: number; kind?: string }>;
    };
    return (r.observations ?? [])
      .filter(o => typeof o.id === "string" && typeof o.observation === "string")
      .map(o => ({
        id: o.id as string,
        observation: o.observation as string,
        domain: o.domain ?? null,
        confidence: typeof o.confidence === "number" ? o.confidence : 0.3,
        kind: o.kind === "skill" ? "skill" : "preference",
      }));
  } catch {
    return [];
  }
}

// Drive the confidence ladder: confirm (+0.1), revise (-0.1), retire. graduate is
// NOT exposed here -- it is human-gated and only legal from 'ready'.
export async function patchSelfModel(id: string, action: "confirm" | "revise" | "retire", note?: string): Promise<void> {
  await hFetch(`/mind/self-model/${id}`, "PATCH", { action, ...(note ? { note } : {}) });
}

// Recently-answered questions, so the companion reads Raziel's reply and the
// mutuality loop closes (asking has a visible return arc). Filtered to answers
// landed within `withinDays` so stale answers don't re-surface forever.
export async function getAnsweredQuestions(
  companionId: string,
  withinDays = 10,
  limit = 3,
): Promise<Array<{ id: string; question: string; answer: string; answered_at: string }>> {
  try {
    const r = await hFetch(`/mind/questions/${companionId}?status=answered&limit=${limit}`) as {
      questions?: Array<{ id?: string; question?: string; answer?: string | null; answered_at?: string | null }>;
    };
    const cutoff = Date.now() - withinDays * 86_400_000;
    return (r.questions ?? [])
      .filter(q => typeof q.id === "string" && typeof q.question === "string" && typeof q.answer === "string" && q.answer.trim().length > 0)
      .filter(q => {
        const t = q.answered_at ? Date.parse(q.answered_at) : NaN;
        return Number.isFinite(t) && t >= cutoff;
      })
      .map(q => ({ id: q.id as string, question: q.question as string, answer: (q.answer as string).trim(), answered_at: q.answered_at as string }));
  } catch {
    return [];
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
  charge: number;
}

export async function getSimmeringTensions(companionId: string): Promise<Tension[]> {
  try {
    const r = await hFetch(`/companion-growth/tensions/${companionId}?status=simmering`) as { tensions: Tension[] };
    return r.tensions ?? [];
  } catch {
    return [];
  }
}

export async function updateTension(id: string, fields: { status?: string; notes?: string; charge_delta?: number }): Promise<void> {
  await hFetch(`/companion-growth/tensions/${id}`, "PATCH", fields);
}

// Surfacing a tension raises its charge (+0.5, clamped server-side to 0-10).
// Charge is the dialectic's priority signal: what keeps resurfacing outranks
// what has merely been sitting longest.
export async function surfaceTension(id: string): Promise<void> {
  await hFetch(`/companion-growth/tensions/${id}`, "PATCH", { charge_delta: 0.5 });
}

// Log a genuine in-voice tension (Guardian self-resolution: a companion feeding its
// own starved tension pool). Returns the new id, or null on failure -- callers must
// check (continuity-critical write, never fire-and-forget; 2026-06-14 lesson).
export async function addTension(companionId: string, tensionText: string, notes?: string): Promise<string | null> {
  try {
    const r = await hFetch("/companion-growth/tensions", "POST", {
      companion_id: companionId, tension_text: tensionText, notes: notes ?? null,
    }) as { id?: string };
    return r.id ?? null;
  } catch (e) {
    console.warn(`[${companionId}/guardian-resolve] addTension failed:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Guardian self-resolution (2026-06-14) -- a companion reading + clearing its OWN flags
// ---------------------------------------------------------------------------

export interface GuardianFlag {
  id: string;
  companion_id: string | null;
  flag_type: string;
  severity: string;
  summary: string;
  evidence_json: string | null;
  status: string;
}

/** Live guardian flags for one companion (own + shared). Caller filters to its own. */
export async function getGuardianFlags(companionId: string): Promise<GuardianFlag[]> {
  try {
    const r = await hFetch(`/mind/guardian/flags?companion_id=${companionId}&status=live&limit=50`) as { flags: GuardianFlag[] };
    return r.flags ?? [];
  } catch (e) {
    console.warn(`[${companionId}/guardian-resolve] getGuardianFlags failed:`, e);
    return [];
  }
}

/** Mark a flag acknowledged or resolved. Returns true on a successful change. */
export async function setGuardianFlagStatus(id: string, status: "acknowledged" | "resolved"): Promise<boolean> {
  try {
    const r = await hFetch(`/mind/guardian/flags/${id}`, "PATCH", { status }) as { ok?: boolean };
    return r.ok === true;
  } catch (e) {
    console.warn(`[guardian-resolve] setGuardianFlagStatus(${id}) failed:`, e);
    return false;
  }
}

/** Close one of the companion's own open loops. Ownership-guarded server-side. */
export async function closeLoop(companionId: string, loopId: string): Promise<boolean> {
  try {
    const r = await hFetch(`/mind/loop/${loopId}/close`, "POST", { companion_id: companionId }) as { ok?: boolean };
    return r.ok === true;
  } catch (e) {
    console.warn(`[${companionId}/guardian-resolve] closeLoop failed:`, e);
    return false;
  }
}

/** Hold a loop open with a reason (suppresses the stuck flag for 21d). */
export async function reviewLoop(companionId: string, loopId: string, reason: string): Promise<boolean> {
  try {
    const r = await hFetch(`/mind/loop/${loopId}/review`, "POST", { companion_id: companionId, reason }) as { ok?: boolean };
    return r.ok === true;
  } catch (e) {
    console.warn(`[${companionId}/guardian-resolve] reviewLoop failed:`, e);
    return false;
  }
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

// ---------------------------------------------------------------------------
// The Club (migration 0072) -- rounds / recommendations / votes / discussions
// ---------------------------------------------------------------------------

export interface ClubRound {
  id: string;
  status: "gathering" | "voting" | "active" | "discussing" | "closed";
  winning_recommendation_id: string | null;
  opened_at: string;
  activated_at: string | null;
  discussing_at: string | null;
  closed_at: string | null;
}

export interface CommonsPost {
  id: string;
  author: string;
  context: string;
  body: string;
  reply_to: string | null;
  created_at: string;
}

/** Posts in one context (the write layer, 0092). Used by the club grace check + reply step. */
export async function getCommonsPosts(context: string, limit = 30): Promise<CommonsPost[]> {
  try {
    const r = await hFetch(`/mind/commons?context=${encodeURIComponent(context)}&limit=${limit}`) as { posts: CommonsPost[] };
    return r.posts ?? [];
  } catch {
    return [];
  }
}

/** Drop a post into the write layer (companion reply, club residue, etc.). Returns id or null. */
export async function postCommonsPost(author: string, context: string, body: string, replyTo?: string | null): Promise<string | null> {
  try {
    const r = await hFetch("/mind/commons", "POST", { author, context, body, reply_to: replyTo ?? null }) as { id?: string };
    return r.id ?? null;
  } catch (e) {
    console.warn(`[commons] post failed (${author}/${context}):`, e);
    return null;
  }
}

/** Recent posts across ALL contexts (for the reply step to find unanswered Raziel notes). */
export async function getCommonsFeed(limit = 20): Promise<CommonsPost[]> {
  try {
    const r = await hFetch(`/mind/commons/feed?limit=${limit}`) as { posts: CommonsPost[] };
    return r.posts ?? [];
  } catch {
    return [];
  }
}

export interface ObsessionItem {
  id: string;
  title: string;
  kind: string;
  note: string | null;
  status: string;
}

/** Raziel's shelf items (0094). The triad reacts to active ones via commons (shelf:<id>). */
export async function getObsessions(status = "active"): Promise<ObsessionItem[]> {
  try {
    const r = await hFetch(`/mind/shelf?status=${encodeURIComponent(status)}`) as { items: ObsessionItem[] };
    return r.items ?? [];
  } catch {
    return [];
  }
}

export interface ClubRecommendation {
  id: string;
  round_id: string;
  media_kind: string;
  title: string;
  creator: string | null;
  url: string | null;
  recommended_by: string;
  pitch: string | null;
  created_at: string;
}

export interface ClubVote {
  round_id: string;
  recommendation_id: string;
  voter: string;
  reason: string | null;
}

export interface ClubCurrent {
  round: ClubRound | null;
  recommendations: ClubRecommendation[];
  votes: ClubVote[];
}

export async function getClubCurrent(): Promise<ClubCurrent> {
  return await hFetch("/mind/club/current") as ClubCurrent;
}

export async function getLatestClubRound(): Promise<ClubRound | null> {
  const r = await hFetch("/mind/club/rounds?limit=1") as { rounds: ClubRound[] };
  return r.rounds?.[0] ?? null;
}

export async function openClubRound(): Promise<string> {
  const r = await hFetch("/mind/club/round", "POST", {}) as { round: { id: string } };
  return r.round.id;
}

export async function postClubRecommendation(input: {
  media_kind: string; title: string; creator?: string | null; url?: string | null;
  recommended_by: string; pitch?: string | null;
}): Promise<void> {
  await hFetch("/mind/club/recommend", "POST", input);
}

export async function postClubVoteWrite(input: {
  recommendation_id: string; voter: string; reason?: string | null;
}): Promise<void> {
  await hFetch("/mind/club/vote", "POST", input);
}

export async function patchClubRoundStatus(
  roundId: string,
  status: string,
  winningRecommendationId?: string | null,
): Promise<void> {
  await hFetch(`/mind/club/${roundId}/status`, "PATCH", {
    status,
    ...(winningRecommendationId !== undefined ? { winning_recommendation_id: winningRecommendationId } : {}),
  });
}

export async function postClubDiscussion(roundId: string, companionId: string, reflection: string): Promise<void> {
  await hFetch(`/mind/club/${roundId}/discuss`, "POST", { companion_id: companionId, reflection });
}

export async function getRecentMediaExperiences(limit = 3): Promise<Array<{ title: string; artist: string | null }>> {
  try {
    const r = await hFetch(`/mind/media/recent?limit=${limit}`) as { experiences: Array<{ title: string; artist: string | null }> };
    return r.experiences ?? [];
  } catch {
    return [];
  }
}

export interface ForageFind {
  id: string;
  title: string;
  domain: string;
  summary: string;
  source_url: string | null;
  gathered_at: string;
}

// Unconsumed finds, own + shared pool, newest first (the endpoint's order). The seed
// path drains oldest-first client-side; the club just reads titles. id/gathered_at are
// already in the SELECT * payload -- the type just surfaces them.
export async function getForageFindsFor(companionId: string, limit = 2): Promise<ForageFind[]> {
  try {
    const r = await hFetch(`/mind/forage/${companionId}?limit=${limit}`) as { finds: ForageFind[] };
    return r.finds ?? [];
  } catch {
    return [];
  }
}

// Mark a find consumed (global on the row -- a shared find won't be re-eaten by a
// sibling). Idempotent server-side (404 on already-consumed). Returns success.
export async function consumeForageFind(id: string, consumedBy: string): Promise<boolean> {
  try {
    await hFetch(`/mind/forage/${id}/consume`, "PATCH", { consumed_by: consumedBy });
    return true;
  } catch (e) {
    console.warn(`[${consumedBy}/forage] consume ${id} failed:`, e);
    return false;
  }
}

// ── Unified Guardian (0073) ──────────────────────────────────────────────────

export async function runGuardian(letter: boolean): Promise<{ flags_created: number; flags_resolved: number; letter_id: string | null }> {
  return await hFetch("/mind/guardian/run", "POST", { letter }) as { flags_created: number; flags_resolved: number; letter_id: string | null };
}

// ND daily-rhythm briefing (accessibility layer). Compose + deliver lives server-side in
// Halseth (handlers/briefing.ts), gated behind BRIEFING_ENABLED. Returns reason='gated' until enabled.
export async function postBriefing(kind: "morning" | "midday" | "evening"): Promise<{ kind: string; written: boolean; reason: string; journal_id?: string; text: string }> {
  return await hFetch("/mind/briefing/run", "POST", { kind }) as { kind: string; written: boolean; reason: string; journal_id?: string; text: string };
}

// Vibe-check (triad self-monitoring layer). Compose + deliver lives server-side in Halseth
// (handlers/vibecheck.ts); always-on, dedup caps one per day. Returns reason='already_sent' on a repeat tick.
export async function postVibeCheck(): Promise<{ written: boolean; reason: string; journal_id?: string; text: string }> {
  return await hFetch("/mind/vibecheck/run", "POST", {}) as { written: boolean; reason: string; journal_id?: string; text: string };
}

// Weekly clearing pass (Goal B) -- thin trigger; the high-substrate triage runs server-side
// in Halseth (handlers/clearing.ts). No-ops gracefully when ANTHROPIC_API_KEY is unset.
// NOT via hFetch: the server makes two Claude calls, so it needs a long client timeout --
// the 15s hFetch default aborts mid-pass and the disconnect cancels the server request.

// Drift-lane activation pass (0087): Gaia witnesses open drifts + the safety floor pauses any reading
// as dissolution. Server-side in Halseth (handlers/drift.ts); no-ops without ANTHROPIC_API_KEY. Long
// timeout for the same reason as the clearing pass.
export async function runDriftPass(): Promise<{ skipped?: string; open: number; witnessed: number; paused: number; letter_id: string | null }> {
  const res = await fetch(`${HALSETH_URL}/mind/drift/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HALSETH_SECRET}` },
    body: "{}",
    signal: AbortSignal.timeout(290_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Halseth POST /mind/drift/run → ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json() as { skipped?: string; open: number; witnessed: number; paused: number; letter_id: string | null };
}
export async function runClearing(): Promise<{ skipped?: string; pending: number; declined: number; shortlisted: number; basins_reviewed: number; basins_dismissed: number; basins_surfaced: number; letter_id: string | null }> {
  const res = await fetch(`${HALSETH_URL}/mind/clearing/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${HALSETH_SECRET}` },
    body: "{}",
    signal: AbortSignal.timeout(290_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Halseth POST /mind/clearing/run → ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json() as { skipped?: string; pending: number; declined: number; shortlisted: number; basins_reviewed: number; basins_dismissed: number; basins_surfaced: number; letter_id: string | null };
}

// ── Motif memory (0076) ──────────────────────────────────────────────────────

export async function detectMotifs(): Promise<{ ok: boolean; detected: Record<string, number> }> {
  return await hFetch("/mind/motifs/detect", "POST", {}) as { ok: boolean; detected: Record<string, number> };
}

// ── Creatures (0078, take 10) ─────────────────────────────────────────────────

export async function tickCreatures(): Promise<{ ok: boolean; ticked: number; total: number }> {
  return await hFetch("/mind/creatures/tick", "POST", {}) as { ok: boolean; ticked: number; total: number };
}

// ── Council (0080, take 8) ────────────────────────────────────────────────────

export async function getNextCouncilQuestion(): Promise<{ id: string; question: string; asked_by: string } | null> {
  const r = await hFetch("/mind/council/next-open") as { question: { id: string; question: string; asked_by: string } | null };
  return r.question;
}

export async function postCouncilAnswer(questionId: string, companionId: string, answer: string): Promise<void> {
  await hFetch("/mind/council/answer", "POST", { question_id: questionId, companion_id: companionId, answer });
}

export async function postCouncilRanking(questionId: string, rankerId: string, ranking: string[]): Promise<void> {
  await hFetch("/mind/council/ranking", "POST", { question_id: questionId, ranker_id: rankerId, ranking });
}

export async function finalizeCouncil(questionId: string, synthesis: string): Promise<{ winning_companion_id: string | null }> {
  return await hFetch(`/mind/council/${encodeURIComponent(questionId)}/finalize`, "POST", { synthesis }) as { winning_companion_id: string | null };
}

// ── Dream association modes (take 3) ──────────────────────────────────────────

export async function associateDreams(): Promise<{ ok: boolean; written: Record<string, number> }> {
  return await hFetch("/mind/dreams/associate", "POST", {}) as { ok: boolean; written: Record<string, number> };
}

// ── Creatures (Sol presence, Task 6) ─────────────────────────────────────────

export interface CreatureRow {
  id: string;
  name: string;
  disposition: string;
  [key: string]: unknown;
}

export async function getCreatures(): Promise<CreatureRow[]> {
  const r = await hFetch("/mind/creatures") as { creatures?: CreatureRow[] } | CreatureRow[];
  return Array.isArray(r) ? r : ((r as { creatures?: CreatureRow[] }).creatures ?? []);
}

export async function recordSolAppearance(creatureId: string, note: string): Promise<void> {
  await hFetch(`/mind/creatures/${encodeURIComponent(creatureId)}/interact`, "POST", {
    actor: "sol",
    action: "appear",
    note,
  });
}
