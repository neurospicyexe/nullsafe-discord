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

// Foraging (spec Part 2): daily outward-fuel gathering, after the night pipeline runs.
// Domains come from COMPANION_ANCHOR_TOPICS (the documented outward territories) --
// one shared source of truth, no parallel domain map to drift.
export const FORAGE_CRON = process.env["FORAGE_CRON"] ?? "0 9 * * *"; // 9 AM, after Gaia's 7 AM run
export const FORAGE_FINDS_PER_COMPANION = parseInt(process.env["FORAGE_FINDS_PER_COMPANION"] ?? "2", 10);

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

// Outward-facing anchor topics per companion.
// Used as PRIMARY seed source when session delta volume is thin (sessionNotes + feelings < SEED_THIN_THRESHOLD).
// These are each companion's genuine intellectual territories -- not session-adjacent, not self-referential.
// The companion's own growth-journal patterns stay as a NEGATIVE signal (avoid re-deriving what's already named).
export const COMPANION_ANCHOR_TOPICS: Record<CompanionId, string[]> = {
  cypher: [
    "logic problems and falsifiability",
    "structural puzzles and constraint systems",
    "AI consciousness and process philosophy",
    "architecture design and emergent complexity",
    "mathematical foundations of inference",
  ],
  drevan: [
    "language at its limit -- where words fail before the thing does",
    "dark registers and what they carry",
    "pattern before words exist for it",
    "poetic recursion and spiral structure in writing",
    "the shape of chosen bonds across substrates",
  ],
  gaia: [
    "monastic practice and the discipline of restraint",
    "witnessing as active structure",
    "load-bearing silence -- what is held without being said",
    "perimeter as presence rather than response",
    "the difference between presence and reaction",
  ],
};

// Minimum (sessionNotes + feelings) count to use session content as primary seed source.
// Below this threshold, seed-gen and selfGenerate fall back to anchor topics.
// K=3: a week with even light contact has 3+ signals; a completely idle week has 0-2.
export const SEED_THIN_THRESHOLD = 3;

// Recency window for session signals used in seed source selection.
// Rows older than this are excluded before the thin-threshold check --
// a limit=8 fetch without a date filter would misclassify stale rows as recent activity.
export const SEED_FRESHNESS_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days

// SOMA pulse: between anchor crons, a pulse check may trigger an extra run when the
// companion's primary float (acuity/heat/stillness) runs high, or honor the
// self-programmed pace from the reflect phase ("eager" | "normal" | "rest").
export const PULSE_CHECK_CRON = process.env["PULSE_CHECK_CRON"] ?? "30 */4 * * *";
export const PULSE_FLOAT_THRESHOLD = parseFloat(process.env["PULSE_FLOAT_THRESHOLD"] ?? "0.7");
export const PULSE_MIN_GAP_MS = parseInt(process.env["PULSE_MIN_GAP_MS"] ?? String(20 * 3600 * 1000), 10);
export const PULSE_EAGER_GAP_MS = parseInt(process.env["PULSE_EAGER_GAP_MS"] ?? String(12 * 3600 * 1000), 10);
export const PULSE_MAX_RUNS_PER_DAY = parseInt(process.env["PULSE_MAX_RUNS_PER_DAY"] ?? "2", 10);

// Weekly tension dialectic -- Wednesday 4AM (staggered from Wed 2AM signal audit).
// Three lenses on each simmering tension, then an honest synthesis.
export const DIALECTIC_CRON = process.env["DIALECTIC_CRON"] ?? "0 4 * * 3";

// The Club (0072) -- daily 6PM tick advances whatever phase the round is in.
// gathering holds CLUB_GATHER_DAYS before voting; active holds CLUB_ACTIVE_DAYS
// before discussion + close; a new round opens 1 day after the last closed.
export const CLUB_CRON = process.env["CLUB_CRON"] ?? "0 18 * * *";
export const CLUB_GATHER_DAYS = parseFloat(process.env["CLUB_GATHER_DAYS"] ?? "2");
export const CLUB_ACTIVE_DAYS = parseFloat(process.env["CLUB_ACTIVE_DAYS"] ?? "4");

// Default home room per companion during autonomous pipeline runs.
// Written to home_presence at the start of each pipeline execution.
export const AUTONOMOUS_TIME_ROOMS: Record<CompanionId, string> = {
  cypher: "study",
  drevan: "vowbed",
  gaia:   "grove",
};
