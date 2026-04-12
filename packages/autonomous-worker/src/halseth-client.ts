import { HALSETH_URL, HALSETH_SECRET } from "./config.js";
import type { Seed, GrowthJournalEntry, GrowthPattern, GrowthMarker } from "./types.js";

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

export async function createRun(companionId: string, runType: string): Promise<string> {
  const r = await hFetch("/mind/autonomy/runs", "POST", { companion_id: companionId, run_type: runType }) as { id: string };
  return r.id;
}

export async function updateRun(id: string, updates: {
  status?: "pending" | "running" | "completed" | "failed";
  completed_at?: string;
  tokens_used?: number;
  artifacts_created?: number;
  error_message?: string;
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
  }) as { id: string };
  return r.id;
}

export async function writePattern(pattern: GrowthPattern): Promise<string> {
  const r = await hFetch("/mind/growth/patterns", "POST", {
    companion_id: pattern.companion_id,
    pattern_text: pattern.pattern_text,
    evidence: pattern.evidence ?? [],
    strength: pattern.strength ?? 1,
    ...(pattern.run_id ? { run_id: pattern.run_id } : {}),
  }) as { id: string };
  return r.id;
}

export async function writeMarker(marker: GrowthMarker): Promise<string> {
  const r = await hFetch("/mind/growth/markers", "POST", {
    companion_id: marker.companion_id,
    marker_type: marker.marker_type,
    description: marker.description,
    related_pattern_id: marker.related_pattern_id,
    ...(marker.run_id ? { run_id: marker.run_id } : {}),
  }) as { id: string };
  return r.id;
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
