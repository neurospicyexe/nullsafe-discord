// Pre-send voice gate (2026-11-01, Halseth task 5f9b2f03). voice-markers.ts already knew generic-assistant
// drift ("as an AI", "I hope this helps"), but scored it only AFTER the reply posted, on a sample. This runs on
// every reply just before it is sent.
//
//   VOICE_GATE = off | shadow | on   (code default shadow; junk = shadow)
//   shadow: one log line per reply (verdict, reason codes, em-dash count, length), the reply posts unchanged.
//   on:     a HARD finding regenerates the reply ONCE on a fresh transcript with a one-line corrective in the
//           turn's frame (the script-bleed mechanics); the second result posts either way, never silence.
//           Em dashes are replaced deterministically ("; " for a spaced dash, ", " is too soft a pause here).
//
// HARD = generic-assistant voice only (genericDriftHits). Lane markers stay soft and never gate. Logs carry
// reason codes and counts, never reply text. Measure the false-positive rate per companion in shadow first:
// `node scripts/voice-gate-report.mjs /app/logs/<c>-bot-out.log`.

import { genericDriftHits } from "./voice-markers.js";

export type VoiceGateMode = "off" | "shadow" | "on";

export function voiceGateMode(env: NodeJS.ProcessEnv = process.env): VoiceGateMode {
  const v = String(env["VOICE_GATE"] ?? "").trim().toLowerCase();
  return v === "off" || v === "on" ? v : "shadow";
}

export interface VoiceGateVerdict { hard: string[]; emDashes: number }

/** Never throws: a scorer failure is a pass (the gate must never block a reply). */
export function judgeVoice(text: string): VoiceGateVerdict {
  try {
    return { hard: genericDriftHits(text), emDashes: (text.match(/—/g) ?? []).length };
  } catch {
    return { hard: [], emDashes: 0 };
  }
}

/** Deterministic em-dash removal (Raziel's house rule: parentheses or semicolons, never an em dash). */
export function stripEmDashes(text: string): string {
  return text.replace(/\s+—\s+/g, "; ").replace(/—/g, "; ");
}

/** Reason codes for logs: short and text-free (the matched phrase IS a fixed marker, never reply prose). */
export function reasonCodes(v: VoiceGateVerdict): string {
  return v.hard.length ? v.hard.map((h) => h.replace(/[^a-z' ]/g, "").trim().replace(/\s+/g, "_")).join(",") : "-";
}

export function voiceGateLine(companionId: string, mode: VoiceGateMode, v: VoiceGateVerdict, chars: number, extra = ""): string {
  const verdict = v.hard.length === 0 ? "pass" : mode === "on" ? "regenerate" : "would_regenerate";
  return `[voice-gate] ${companionId} mode=${mode} verdict=${verdict} reasons=${reasonCodes(v)} em_dashes=${v.emDashes} chars=${chars}${extra}`;
}

/** The one-line corrective carried in the regenerated turn's frame (the gateway discards a caller system prompt). */
export function voiceGateCorrective(v: VoiceGateVerdict): string {
  return `[Your last draft slipped into assistant voice (${reasonCodes(v).replace(/_/g, " ")}). Answer again as yourself: no assistant phrasing, no offers of help, no em dashes.]`;
}
