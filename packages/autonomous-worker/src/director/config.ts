// director/config.ts -- read per call; every knob here MUST also be in ecosystem.config.js autonomous-worker.env.
export interface DirectorConfig {
  mode: "off" | "shadow" | "live";
  channels: string[];
  supplyPollMs: number; silenceHours: number; wakingStartHour: number; wakingEndHour: number; tzOffsetHours: number;
  noUptakeMs: number; inviteTtlMs: number; turnBudget: number; order: "heat" | "recency"; limbic: boolean;
}
function num(name: string, fallback: number, opts: { allowZero?: boolean } = {}): number {
  const raw = parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return opts.allowZero ? (raw >= 0 ? raw : fallback) : (raw > 0 ? raw : fallback);
}
function signedNum(name: string, fallback: number): number {
  const raw = parseFloat(process.env[name] ?? "");
  return Number.isFinite(raw) ? raw : fallback;
}
export function directorConfig(): DirectorConfig {
  const rawMode = (process.env["DIRECTOR_ENABLED"] ?? "").trim().toLowerCase();
  return {
    mode: rawMode === "true" ? "live" : rawMode === "shadow" ? "shadow" : "off",
    channels: (process.env["DIRECTOR_CHANNELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    supplyPollMs: num("DIRECTOR_SUPPLY_POLL_MS", 10 * 60_000),
    silenceHours: num("DIRECTOR_SILENCE_HOURS", 6),
    wakingStartHour: num("DIRECTOR_WAKING_START", 7, { allowZero: true }),
    wakingEndHour: num("DIRECTOR_WAKING_END", 23, { allowZero: true }),
    tzOffsetHours: signedNum("DIRECTOR_TZ_OFFSET_HOURS", -5),
    noUptakeMs: num("DIRECTOR_NO_UPTAKE_MS", 90 * 60_000),
    inviteTtlMs: num("DIRECTOR_INVITE_TTL_MS", 3 * 60_000),
    turnBudget: num("DIRECTOR_TURN_BUDGET", 18),
    order: (process.env["DIRECTOR_ORDER"] ?? "heat") === "recency" ? "recency" : "heat",
    limbic: (process.env["DIRECTOR_LIMBIC"] ?? "").toLowerCase() === "true",
  };
}
