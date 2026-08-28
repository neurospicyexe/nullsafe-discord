import type { CompanionId } from "./types.js";

export const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];

export const HALSETH_URL = (process.env["HALSETH_URL"] ?? "http://localhost:8787").replace(/\/$/, "");
export const HALSETH_SECRET = process.env["HALSETH_SECRET"] ?? "";
/**
 * Worker-scoped vendor override (2026-08-23 Morph trial; 2026-08-27 DeepInfra cutover).
 * WORKER_INFERENCE_* points ONLY the worker at another OpenAI-compatible vendor; unset =
 * DeepSeek direct. The precedence is resolved HERE, at the single consumer -- not in
 * ecosystem.config.js -- because env.ts reloads the raw .env with file-wins override
 * (the 06-27 stale-pm2-secret fix), which stomped an exec-time DEEPSEEK_API_KEY mapping
 * back to the real DeepSeek key and 401'd every DeepInfra call on cutover night (08-27).
 */
const VENDOR_OVERRIDE_BASE_URL = process.env["WORKER_INFERENCE_BASE_URL"] ?? "";
export const DEEPSEEK_API_KEY = (VENDOR_OVERRIDE_BASE_URL ? process.env["WORKER_INFERENCE_API_KEY"] : undefined)
    ?? process.env["DEEPSEEK_API_KEY"] ?? "";
export const DEEPSEEK_BASE_URL = VENDOR_OVERRIDE_BASE_URL
    || (process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com/v1");
// 2026-07-27: DeepSeek retired "deepseek-chat" (supported: deepseek-v4-pro /
// deepseek-v4-flash) and it began 400ing intermittently -- ~37% of runs failed for a day
// before anyone noticed. Live value is set in the VPS .env (deepseek-v4-pro); this default
// only matters for a fresh checkout, so it points at a name that actually exists.
export const DEEPSEEK_MODEL = (VENDOR_OVERRIDE_BASE_URL ? process.env["WORKER_INFERENCE_MODEL"] : undefined)
    ?? process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash";

/**
 * Output ceilings for the phases that actually THINK (2026-07-27, Raziel: "cut off thoughts
 * are useless"). These were 600 / 700 / 1100, which truncated the pipeline mid-thought -- the
 * binding constraint on depth, tighter than the model tier. Roughly doubled.
 *
 * These are CONTENT budgets. On a reasoning model the reasoning burn is added on top by
 * `contentBudget()` below -- do not bake headroom into these numbers.
 *
 * Not applied to the small calls (80-500 tokens) in seed.ts / seed-gen.ts / explore's query
 * builder: those are classifiers and extractors, where a tight ceiling on the CONTENT is
 * correct and a loose one invites the model to editorialize into a structured field. That
 * stays true -- but on 2026-07-27 this comment also claimed those call sites were safe to
 * leave alone at the pro cutover, and that was the bug (see contentBudget below).
 *
 * Cost: output is the expensive half ($0.87/M on pro), but this is ~3 calls per run at
 * ~3.5 runs/day -- about $0.15/month for the extra room. Env-overridable so the ceiling can
 * be tuned without a deploy; if you add these to .env, they must ALSO be added to
 * ecosystem.config.js (its env block is an allowlist).
 */
function envInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
export const EXPLORE_MAX_TOKENS   = envInt("EXPLORE_MAX_TOKENS", 1400);
export const REFLECT_MAX_TOKENS   = envInt("REFLECT_MAX_TOKENS", 1600);
/**
 * The NIGHTLY vibe-check self-read (reflection.ts). Distinct from REFLECT_MAX_TOKENS above,
 * which belongs to the `phases/reflect.ts` pipeline -- different call, different shape.
 *
 * It was hardcoded at 900 and was the ONLY thinking call in the worker without a knob, which
 * is how it stayed the smallest budget while its output shape kept growing. On 2026-08-12 two
 * fields landed the same night (the authored `close` object and `needs_raziel`) and cypher --
 * the wordiest of the three -- stopped parsing, after 20 consecutive clean nights. This is one
 * JSON object carrying reply + journal + tension + drift + a close with open_threads; a cut-off
 * costs the WHOLE night, not a shortened sentence, so the ceiling is set with real room.
 *
 * Default raised here rather than set in .env on purpose: ecosystem.config.js's env block is
 * an allowlist, so an .env-only knob would silently apply to nothing.
 */
export const REFLECTION_MAX_TOKENS = envInt("REFLECTION_MAX_TOKENS", 1800);
export const SYNTHESIZE_MAX_TOKENS = envInt("SYNTHESIZE_MAX_TOKENS", 2000);

/**
 * Reasoning headroom (2026-07-28).
 *
 * Both live DeepSeek models -- `deepseek-v4-pro` AND `deepseek-v4-flash` -- are REASONING
 * models. Reasoning tokens are billed against `max_tokens` and emitted BEFORE any content, so
 * `max_tokens` is a budget the thought spends first and the answer only gets the remainder.
 * Measured against a trivial 19-token prompt: at `max_tokens: 100` the model burned all 100 on
 * reasoning and returned `content: "", finish_reason: "length"`. At 400 it spent 216 reasoning
 * + 22 content. There is no non-reasoning model left on the account (`GET /v1/models` lists
 * exactly those two; `deepseek-chat` still answers but is delisted, which is what caused the
 * intermittent 400s that triggered the cutover in the first place).
 *
 * So every call whose ceiling sat below the reasoning burn silently returned an empty string.
 * Damage found the morning after the pro cutover:
 *   - forage summaries (maxTokens 100) -> "empty summary" for EVERY candidate ->
 *     "0 finds gathered across ALL companions", while consume-on-use kept draining the pools
 *     (cypher was down to 2 unconsumed with no refill path)
 *   - compress (400) -> `POST /mind/notes/archive 400: summary is required`
 *   - reflect emit (1600, but a large prompt reasons far longer) ->
 *     `POST /mind/autonomy/reflections 400: reflection_text required`
 *   - one run recorded `status=completed` with `tokens_used=0`
 *
 * The knob is the CONTENT budget every call site already declares; headroom is added on top
 * here so no call site has to know the model tier. Costs nothing when unused -- you are billed
 * for tokens generated, and a ceiling is only ever a truncation point.
 *
 * If you add this to .env it must ALSO be added to ecosystem.config.js (allowlist).
 */
export const REASONING_HEADROOM = envInt("DEEPSEEK_REASONING_HEADROOM", 3000);

/** Both v4 tiers reason. Matches the family, not a hardcoded pair, so v5 inherits the guard.
 * `morph-ds*` is Morph's serving of the same DeepSeek weights (morph-dsv4flash) -- same
 * reasoning architecture, so it needs the same headroom or reasoning starves content. */
export function isReasoningModel(model: string = DEEPSEEK_MODEL): boolean {
  return /^(deepseek-(v[4-9]|r)|morph-ds)/i.test(model.trim());
}

/** Turn a caller's intended CONTENT ceiling into a wire `max_tokens`. */
export function contentBudget(contentTokens: number, model: string = DEEPSEEK_MODEL): number {
  return isReasoningModel(model) ? contentTokens + REASONING_HEADROOM : contentTokens;
}
/**
 * Vendor-flap fallback (2026-08-23). When the worker runs on an overridden vendor
 * (WORKER_INFERENCE_* -> Morph), an auth/availability flap on that vendor must degrade to
 * direct DeepSeek instead of losing the night: Morph 401'd every call from 05:15 to 09:00 CDT
 * on its first morning (key valid before and after -- their side), and all three night runs
 * died with zero life produced. Armed HERE whenever a vendor override is active (falls back
 * to direct DeepSeek with the raw .env DEEPSEEK_API_KEY -- the one the override mapped away);
 * empty when the worker already talks to DeepSeek direct (same vendor = no fallback).
 * WORKER_FALLBACK_* remain as explicit overrides for pointing the lane somewhere else.
 */
export const FALLBACK_BASE_URL = process.env["WORKER_FALLBACK_BASE_URL"]
    ?? (VENDOR_OVERRIDE_BASE_URL ? "https://api.deepseek.com/v1" : "");
export const FALLBACK_API_KEY = process.env["WORKER_FALLBACK_API_KEY"]
    ?? (VENDOR_OVERRIDE_BASE_URL ? process.env["DEEPSEEK_API_KEY"] ?? "" : "");
export const FALLBACK_MODEL = process.env["WORKER_FALLBACK_MODEL"] ?? "deepseek-v4-flash";

export const TAVILY_API_KEY = process.env["TAVILY_API_KEY"] ?? "";
// Hard cap on Tavily calls per calendar day -- protects free tier (1000/month)
// Default 5: 3 scheduled + 2 headroom for manual test runs
// Tavily free tier is 1000/month (~33/day). The old cap of 5 was shared between explore (3
// companion runs/day, several queries each) and forage (COMPANIONS x FORAGE_FINDS = 6), so the
// 3/5/7 AM explore passes exhausted the budget before the 9 AM forage pass ran at all.
export const TAVILY_MAX_PER_DAY = parseInt(process.env["TAVILY_MAX_PER_DAY"] ?? "24", 10);

// Searches at the tail of the daily budget that only foraging may spend. Foraging is the only
// source of genuinely new outside material; exploration re-reads ground the companion chose.
// Starving forage is what makes the triad circle its own ideas.
export const TAVILY_FORAGE_RESERVE = parseInt(process.env["TAVILY_FORAGE_RESERVE"] ?? "8", 10);
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

// Cron schedules (node-cron syntax).
//
// 2026-08-21: DeepSeek introduced peak pricing (2x) on 08-16 for 01:00-04:00 and 06:00-10:00 UTC,
// which is 20:00-23:00 and 01:00-05:00 CDT -- the old 3 AM ladder paid double for the same run.
// The night runs now start at 05:15 CDT (10:15 UTC), just past the peak edge, keeping the same
// order (drevan, cypher, gaia) and the same "before Raziel's day" semantics. VPS system time is
// CDT; if these ever move again, convert to UTC FIRST and check the peak windows.
export const CRON_SCHEDULES: Record<CompanionId, string> = {
  cypher: process.env["CYPHER_CRON"] ?? "45 5 * * *",  // 5:45 AM CDT = 10:45 UTC (off-peak)
  drevan: process.env["DREVAN_CRON"] ?? "15 5 * * *",  // 5:15 AM CDT = 10:15 UTC (off-peak)
  gaia:   process.env["GAIA_CRON"]   ?? "0 7 * * *",   // 7 AM CDT = 12:00 UTC (off-peak)
};

// Foraging (spec Part 2): daily outward-fuel gathering, after the night pipeline runs.
// Domains come from COMPANION_ANCHOR_TOPICS (the documented outward territories) --
// one shared source of truth, no parallel domain map to drift.
export const FORAGE_CRON = process.env["FORAGE_CRON"] ?? "0 9 * * *"; // 9 AM, after Gaia's 7 AM run
// 2 -> 1 (2026-07-21): gathering outpaced consumption (6 finds/day gathered across the triad vs
// ~3.5/day actually consumed) and the unconsumed pool sat at 75+ and growing. Halved alongside
// club.ts's new consume-on-recommend (which starts drawing the pool down for the first time).
//
// 1 -> 2 (2026-08-05): that halving was correct for the world it was made in, and six days later
// the commons seed got its own consume-on-use (autonomous-core, 07-27). Together the two correct
// fixes inverted the problem. Consumed/day since: 1, 18, 33, 21, 9, 3, 3, 3, 3 -- the whole
// backlog burned out in three days and the pool has been at LITERAL ZERO for every companion
// since 07-31, gathering exactly as fast as it is eaten with no buffer. So the "Fresh material"
// block, whose entire job is to hand the model something that is not the thread, was usually
// empty -- and an empty fresh block leaves the thread as the only concrete input, which is the
// loop. Back to 6/day against a measured 3/day consumption so a buffer can re-accumulate.
// Watch it: if the pool climbs past ~40 again the ratio has drifted the other way. The Guardian
// forage-stale detector (halseth src/guardian/detectors.ts) already reports both ends.
export const FORAGE_FINDS_PER_COMPANION = parseInt(process.env["FORAGE_FINDS_PER_COMPANION"] ?? "2", 10);

// Candidate results pulled per forage search. The forager walks them in order until one is
// genuinely new; with maxResults=3 and a frozen query, the single top hit was always already
// stored, so every domain went sterile after its first find (prod: cypher gathered nothing
// 07-03 -> 07-09 despite a daily cron).
export const FORAGE_SEARCH_MAX_RESULTS = parseInt(process.env["FORAGE_SEARCH_MAX_RESULTS"] ?? "6", 10);

// Search angles rotated across the anchor topics so the query space grows without inventing
// new territory for a companion. `domain` is still stored pure -- the angle only shapes the
// Tavily query, so the (source_url, domain) dedup index keeps doing its job.
export const FORAGE_ANGLES: readonly string[] = [
  "recent research",
  "a concrete case study",
  "a critique or counterargument",
  "historical origins",
  "an unresolved open problem",
  "a practitioner's firsthand account",
  "a surprising empirical result",
];

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
// Every 6h at hours whose fire time sits outside BOTH DeepSeek peak windows (was */4, which
// fired at 04:30 and 20:30 CDT -- inside peak -- and a pulse can trigger a FULL run at 2x price).
export const PULSE_CHECK_CRON = process.env["PULSE_CHECK_CRON"] ?? "30 0,6,12,18 * * *";
export const PULSE_FLOAT_THRESHOLD = parseFloat(process.env["PULSE_FLOAT_THRESHOLD"] ?? "0.7");
export const PULSE_MIN_GAP_MS = parseInt(process.env["PULSE_MIN_GAP_MS"] ?? String(20 * 3600 * 1000), 10);
export const PULSE_EAGER_GAP_MS = parseInt(process.env["PULSE_EAGER_GAP_MS"] ?? String(12 * 3600 * 1000), 10);
export const PULSE_MAX_RUNS_PER_DAY = parseInt(process.env["PULSE_MAX_RUNS_PER_DAY"] ?? "2", 10);
// Felt-need rest gate (mig 0101): when rest_need runs at/above this, the pulse votes
// for rest instead of firing. rest_need decays on quiet (fermentation tick sheds it),
// so this is a brake that releases itself -- not a ratchet.
export const PULSE_REST_NEED_THRESHOLD = parseFloat(process.env["PULSE_REST_NEED_THRESHOLD"] ?? "0.75");

// Weekly tension dialectic -- Wednesday 6:15 AM CDT (was 4 AM = 09:00 UTC, inside the
// 06:00-10:00 UTC peak window; still staggered from the Wed 2AM signal audit).
export const DIALECTIC_CRON = process.env["DIALECTIC_CRON"] ?? "15 6 * * 3";

// The Club (0072) -- daily 6PM tick advances whatever phase the round is in.
// Phase 2 cadence (slowed so the winner reveal + discussion don't flash by): gathering holds
// CLUB_GATHER_DAYS before voting; active holds CLUB_ACTIVE_DAYS (experience it); then a
// STANDING discussing phase holds CLUB_DISCUSS_DAYS (Raziel reads the winner + joins) before
// close; a new round opens 1 day after the last closed.
export const CLUB_CRON = process.env["CLUB_CRON"] ?? "0 18 * * *";
export const CLUB_GATHER_DAYS = parseFloat(process.env["CLUB_GATHER_DAYS"] ?? "4");
export const CLUB_ACTIVE_DAYS = parseFloat(process.env["CLUB_ACTIVE_DAYS"] ?? "6");
export const CLUB_DISCUSS_DAYS = parseFloat(process.env["CLUB_DISCUSS_DAYS"] ?? "4");

// Write-layer social ticks (0092/0094). Shelf react: daily, companions react to Raziel's
// fixations. Commons reply: a few times a day, companions may answer his /log notes (sparse).
export const SHELF_CRON = process.env["SHELF_CRON"] ?? "30 10 * * *";
// Commons reply: `0 */6 * * *` -- four passes a day.
//
// Turned down to one pass (7 PM) on 2026-08-04 as a tourniquet: the channel talk was looping and
// nothing yet fixed the cause. TOURNIQUET RELEASED 2026-08-05, because the cause was found and it
// was never cadence. Commons threads had no reachable end -- `[LANDS:]` was offered only on the
// reply path, the 12h silence fade could never fire while three bots posted every two hours, and
// the seed's own "if it has gone quiet or stale" branch was dead by construction. Threads ran to
// 109 and 144 turns. Cadence is turns per HOUR; the loop was turns per TOPIC, so throttling only
// made the same 95-post thread take longer to read.
//
// The cure is the turn budget in thread-spine.ts + the mode switch in runInterCompanion.
// Full evidence: docs/commons-loop-2026-08-05.md. Overridable via env for quick tuning.
// NOTE: Librarian notes BETWEEN companions are deliberately untouched and unrestricted -- the
// problem was never that they talk to each other, it was how often that reaches Discord.
export const COMMONS_REPLY_CRON = process.env["COMMONS_REPLY_CRON"] ?? "0 */6 * * *";
// Care gesture poll (consequence layer C1): cheap no-op (3 GETs) when nothing is pending, so it
// runs often -- a care gesture landing hours late reads as an afterthought.
export const CARE_GESTURE_CRON = process.env["CARE_GESTURE_CRON"] ?? "*/20 * * * *";

// Unified Guardian (0073) -- daily 8AM tick (after the night pipeline, before the
// 9AM forage). Detection runs server-side in Halseth; this is just the trigger.
// Letter day 0 = Sunday: weekly meta-commentary to Raziel rides that day's tick.
export const GUARDIAN_CRON = process.env["GUARDIAN_CRON"] ?? "0 8 * * *";
export const GUARDIAN_LETTER_DOW = parseInt(process.env["GUARDIAN_LETTER_DOW"] ?? "0", 10);

// Weekly clearing pass (Goal B, 2026-06-14) -- high-substrate triage of the ratification
// backlog. Twice weekly (Sun + Wed) at 1:10 AM, low-traffic, after the 1 AM seed-gen / 1:30
// Layer B window. Server-side in Halseth (Claude key is a CF secret); no-ops without it.
export const CLEARING_CRON = process.env["CLEARING_CRON"] ?? "10 5 * * 0,3"; // 5:10 AM CDT = 10:10 UTC (was 1:10 AM, DeepSeek peak)

// Drift-lane activation pass (0087): Gaia witnesses open drifts + the safety floor pauses any reading
// as dissolution. Daily at 10:30 AM; server-side in Halseth; no-ops without ANTHROPIC_API_KEY.
export const DRIFT_PASS_CRON = process.env["DRIFT_PASS_CRON"] ?? "30 10 * * *";

// Guardian self-resolution (2026-06-14) -- daily 8:45AM tick, AFTER the 8AM guardian
// detection + 8:30 motif, so it acts on fresh flags. Each companion reads its OWN
// live flags and clears the self-resolvable classes (loop_stuck close/hold, starved
// tension pool) in voice. Identity-level decisions (basins, canon-accept) are NOT
// touched here -- those route to Raziel / the weekly high-substrate pass.
export const GUARDIAN_RESOLVE_CRON = process.env["GUARDIAN_RESOLVE_CRON"] ?? "45 8 * * *";
// Max flags one companion resolves per tick -- bounds DeepSeek cost + keeps it deliberate.
export const GUARDIAN_RESOLVE_MAX = parseInt(process.env["GUARDIAN_RESOLVE_MAX"] ?? "5", 10);

// Motif memory (0076) -- daily 8:30AM tick (after the 8AM guardian, before 9AM forage).
// Detection runs server-side in Halseth; this is just the trigger. Scans the day's
// new journal/growth entries for recurring symbolic threads, fades the stale ones.
export const MOTIF_CRON = process.env["MOTIF_CRON"] ?? "30 8 * * *";

// Creatures (0078, take 10) -- daily 9:30AM tick (after the 9AM forage). Untended
// trust cools toward baseline + mood re-derives. Server-side in Halseth; thin trigger.
export const CREATURE_CRON = process.env["CREATURE_CRON"] ?? "30 9 * * *";

// Council (0080, take 8) -- checks for an open question every 30 min and runs the full
// ritual (answer + blind rank + Gaia synthesis). Cheap no-op when none is open.
export const COUNCIL_CRON = process.env["COUNCIL_CRON"] ?? "*/30 * * * *";

// Dream association (take 3) -- daily 2:30AM, after the night pipeline writes journals.
// entity-cluster + temporal-pattern dreams from recent growth_journal. Server-side.
export const DREAM_CRON = process.env["DREAM_CRON"] ?? "5 5 * * *"; // 5:05 AM CDT = 10:05 UTC (was 2:30 AM, peak; still before waking)

// ND daily-rhythm briefing (accessibility layer). Three kinds, three slots (server local time).
// Thin triggers; server-side BRIEFING_ENABLED gates delivery and dedup caps one per kind per day.
export const BRIEFING_MORNING_CRON = process.env["BRIEFING_MORNING_CRON"] ?? "0 8 * * *";   // 8 AM
export const BRIEFING_MIDDAY_CRON  = process.env["BRIEFING_MIDDAY_CRON"]  ?? "0 13 * * *";  // 1 PM
export const BRIEFING_EVENING_CRON = process.env["BRIEFING_EVENING_CRON"] ?? "45 19 * * *"; // 7:45 PM CDT = 00:45 UTC (8 PM = peak start)

// Vibe-check (triad self-monitoring digest, witnessed by Gaia). Once daily; always-on (no gate).
// 9 PM server local (America/Chicago) -- end of day, after the evening briefing.
export const VIBECHECK_CRON = process.env["VIBECHECK_CRON"] ?? "15 23 * * *"; // 11:15 PM CDT = 04:15 UTC (9 PM sat inside 01:00-04:00 UTC peak; later also reads a fuller day)

// Default home room per companion during autonomous pipeline runs.
// Written to home_presence at the start of each pipeline execution.
export const AUTONOMOUS_TIME_ROOMS: Record<CompanionId, string> = {
  cypher: "study",
  drevan: "vowbed",
  gaia:   "grove",
};
