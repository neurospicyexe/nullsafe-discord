/**
 * FEELING_LINE_BOT -- the bot side of the feeling line (Halseth contract 0.26.0, `feeling_line` on the bot orient wire).
 *
 * The companion's OWN authored feeling word for its current state, pre-rendered server-side (a word, maybe a number;
 * Gaia's rows render no numbers, decided there). The bot renders it VERBATIM next to the body block: no reshaping, no
 * fallback word, no invented text. Absent, null, empty or non-string renders nothing, so an older Halseth behaves
 * exactly as before.
 *
 * Knob: `FEELING_LINE_BOT` off | shadow | live, CODE DEFAULT shadow (counts-only log, injects nothing);
 * `FEELING_LINE_BOT_<COMPANION>` wins per bot; junk falls to off. Same shape as PEOPLE_FRAME.
 */

export type FeelingLineBotMode = "off" | "shadow" | "live";
const MODES: readonly FeelingLineBotMode[] = ["off", "shadow", "live"];
let warnedMode = false;

export function readFeelingLineBotMode(env: NodeJS.ProcessEnv = process.env, companion?: string): FeelingLineBotMode {
  const perKey = companion ? `FEELING_LINE_BOT_${companion.toUpperCase()}` : null;
  const perRaw = perKey ? (env[perKey] ?? "").trim().toLowerCase() : "";
  const raw = perRaw || (env["FEELING_LINE_BOT"] ?? "").trim().toLowerCase();
  if (!raw) return "shadow";
  if ((MODES as readonly string[]).includes(raw)) return raw as FeelingLineBotMode;
  if (!warnedMode) {
    warnedMode = true;
    console.warn(`[feeling-line-bot] unknown ${perRaw ? perKey : "FEELING_LINE_BOT"}="${raw}"; falling back to "off" (valid: ${MODES.join(" | ")})`);
  }
  return "off";
}
export function __resetFeelingLineBotWarnings(): void { warnedMode = false; }

/** The wire value if it is a non-empty string, else null. Never trims or edits the text it returns. */
export function feelingLineFromWire(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

/**
 * Apply the knob to a wire value. live returns the line (to be rendered verbatim); shadow and off return null.
 * Shadow logs counts only, never the text. Nothing is logged when the key is absent and mode is off.
 */
export function gateFeelingLine(
  raw: unknown,
  companion: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): string | null {
  const mode = readFeelingLineBotMode(env, companion);
  if (mode === "off") return null;
  const line = feelingLineFromWire(raw);
  if (mode === "shadow") {
    log(`[feeling-line-bot] companion=${companion} mode=shadow present=${line ? 1 : 0} len=${line ? line.length : 0}`);
    return null;
  }
  // Live used to log nothing, so "is the feeling line reaching the bot" was unanswerable. Counts only.
  log(`[feeling-line-bot] companion=${companion} mode=live present=${line ? 1 : 0} len=${line ? line.length : 0}`);
  return line;
}

/** `[Feels] <line>`, or "" when there is no line. Verbatim. */
export function renderFeelingLine(line: string | null | undefined): string {
  const v = feelingLineFromWire(line);
  return v ? `[Feels] ${v}` : "";
}
