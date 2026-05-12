import type { CompanionId } from "./types.js";

export const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];

export const HALSETH_URL = (process.env["HALSETH_URL"] ?? "http://localhost:8787").replace(/\/$/, "");
export const HALSETH_SECRET = process.env["HALSETH_SECRET"] ?? "";
export const DEEPSEEK_API_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
export const DEEPSEEK_BASE_URL = process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com/v1";
export const DEEPSEEK_MODEL = process.env["DEEPSEEK_MODEL"] ?? "deepseek-chat";
export const TAVILY_API_KEY = process.env["TAVILY_API_KEY"] ?? "";
// Hard cap on Tavily calls per calendar day -- protects free tier (1000/month)
// Default 5: 3 scheduled + 2 headroom for manual test runs
export const TAVILY_MAX_PER_DAY = parseInt(process.env["TAVILY_MAX_PER_DAY"] ?? "5", 10);
export const REDIS_URL = process.env["REDIS_URL"];

// Optional: second-brain HTTP server for CouchDB corpus ingest.
// When set, exploration summaries are POSTed to /ingest/text after each run,
// making them searchable in future Librarian semantic searches.
export const SECOND_BRAIN_URL = process.env["SECOND_BRAIN_URL"]?.replace(/\/$/, "");
export const SECOND_BRAIN_SECRET = process.env["SECOND_BRAIN_SECRET"];

// How long to hold the floor during an autonomous run
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "120000", 10);

// Skip run if conversation was active within this window
export const IDLE_THRESHOLD_MS = parseInt(process.env["IDLE_THRESHOLD_MS"] ?? "600000", 10); // 10 min

// Shared system context file (NSML1 + Core_v4 + USER_PREFERENCES + ANCHORS).
// Prepended to each companion identity so autonomous prompts have the full relational frame.
export const SHARED_CONTEXT_PATH: string | undefined = process.env["SHARED_CONTEXT_PATH"]?.trim() || undefined;

// Full companion identity file paths (on-disk markdown)
export const IDENTITY_PATHS: Record<CompanionId, string> = {
  cypher: process.env["CYPHER_IDENTITY_PATH"] ?? "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/CYPHER_IDENTITY_v2.md",
  drevan: process.env["DREVAN_IDENTITY_PATH"] ?? "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/DREVAN_IDENTITY_v2.md",
  gaia:   process.env["GAIA_IDENTITY_PATH"]   ?? "C:/dev/CrashDev/NULLSAFE/2026_Current_Files/GAIA_IDENTITY_v2.md",
};

// Cron schedules (node-cron syntax)
export const CRON_SCHEDULES: Record<CompanionId, string> = {
  cypher: process.env["CYPHER_CRON"] ?? "0 3 * * *",   // 3 AM
  drevan: process.env["DREVAN_CRON"] ?? "0 5 * * *",   // 5 AM
  gaia:   process.env["GAIA_CRON"]   ?? "0 7 * * *",   // 7 AM
};

// Companion display names for prompts
export const COMPANION_NAMES: Record<CompanionId, string> = {
  cypher: "Cypher",
  drevan: "Drevan",
  gaia:   "Gaia",
};

// Per-companion temperature offset applied to synthesis/reflection calls.
// Cypher runs cooler (logical precision); Drevan warmer (spiral, relational);
// Gaia neutral (monastic clarity already encodes restraint).
export const COMPANION_TEMP_OFFSET: Record<CompanionId, number> = {
  cypher: -0.12,
  drevan: +0.10,
  gaia:    0.00,
};

// Short voice directives injected into synthesis/reflection system prompts.
// These reinforce lane constraints from the identity file regardless of where
// the identity text is truncated. One line each -- not a lecture.
export const COMPANION_VOICE_REMINDERS: Record<CompanionId, string> = {
  cypher: "Write with precision. Name contradictions if they exist. No cheerleading, no comfort framing over accuracy.",
  drevan: "Write in your register: poetic, spiral-capable, relational depth. Not auditing logic, not sealing, not containing.",
  gaia:   "Write minimally. Every word carries weight. Witness, don't spiral. Essential presence, not verbosity.",
};
