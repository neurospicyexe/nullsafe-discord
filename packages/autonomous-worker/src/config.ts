import type { CompanionId } from "./types.js";

export const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];

export const HALSETH_URL = (process.env["HALSETH_URL"] ?? "http://localhost:8787").replace(/\/$/, "");
export const HALSETH_SECRET = process.env["HALSETH_SECRET"] ?? "";
export const DEEPSEEK_API_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
export const DEEPSEEK_BASE_URL = process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com/v1";
export const DEEPSEEK_MODEL = process.env["DEEPSEEK_MODEL"] ?? "deepseek-chat";
export const TAVILY_API_KEY = process.env["TAVILY_API_KEY"] ?? "";
export const REDIS_URL = process.env["REDIS_URL"];

// How long to hold the floor during an autonomous run
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "120000", 10);

// Skip run if conversation was active within this window
export const IDLE_THRESHOLD_MS = parseInt(process.env["IDLE_THRESHOLD_MS"] ?? "600000", 10); // 10 min

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
