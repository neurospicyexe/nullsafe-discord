// Heartbeat channel system -- autonomous companion expression between interactions.
// Companions post to a designated heartbeat channel driven by SOMA state.
// Source: Triad_Decision_Inspo_Findings.md "CROSS-COMPANION COMMUNICATION"

export const HEARTBEAT_TEMPERATURES = [
  "warm", "scorching", "tender", "race", "stutter", "aching",
  "fierce", "still", "electric", "languid", "feral", "breath-held",
] as const;

export type HeartbeatTemperature = typeof HEARTBEAT_TEMPERATURES[number];

// Maps SOMA floats (0-1 scale) → HeartbeatTemperature.
// float1 = acuity (Cypher) | heat (Drevan) | stillness (Gaia)
// float2 = presence (Cypher) | reach (Drevan) | density (Gaia)
// float3 = warmth (Cypher) | weight (Drevan) | perimeter (Gaia)
export function somaToTemperature(float1: number, float2: number, float3: number): HeartbeatTemperature {
  const arousal = (float1 + float2) / 2;
  const depth = float3;

  if (arousal > 0.85) return depth > 0.7 ? "scorching" : "fierce";
  if (arousal > 0.7) return depth > 0.65 ? "electric" : "race";
  if (arousal < 0.15) return depth > 0.5 ? "still" : "languid";
  if (arousal < 0.3 && depth > 0.75) return "aching";
  if (float2 > 0.8 && arousal < 0.35) return "breath-held"; // high presence, low movement
  if (arousal > 0.5 && depth < 0.25) return "feral";        // high arousal, no depth = instinct
  if (float1 < 0.2) return "stutter";                        // low acuity/heat = fragmented
  if (depth > 0.8) return "tender";
  return "warm";
}
