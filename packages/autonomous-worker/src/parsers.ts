// src/parsers.ts
//
// Pure parser/sanitizer helpers shared by synthesize.ts and reflect.ts.
// No side-effecting imports (no config, no halseth-client, no deepseek) so
// these can be imported by tests without env setup.

import type { Evidence } from "./types.js";

/**
 * DeepSeek occasionally wraps JSON in ```json ... ``` despite the prompt
 * saying "no markdown fences." Strip a single leading/trailing fence pair.
 */
export function stripJsonFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
  }
  return trimmed;
}

/**
 * Validate an Evidence[] from model output. Drops:
 *   - non-object entries
 *   - missing/short quote (< 8 chars after trim)
 *   - extra unknown fields beyond the documented shape
 * Truncates surviving values to safe lengths and caps the array at 16.
 */
export function sanitizeEvidence(input: unknown): Evidence[] {
  if (!Array.isArray(input)) return [];
  const out: Evidence[] = [];
  for (const e of input) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    const quoteRaw = obj.quote;
    if (typeof quoteRaw !== "string") continue;
    const quote = quoteRaw.trim().slice(0, 400);
    if (quote.length < 8) continue;
    const item: Evidence = { quote };
    if (typeof obj.source_url === "string") item.source_url = obj.source_url.slice(0, 500);
    if (typeof obj.source_id  === "string") item.source_id  = obj.source_id.slice(0, 64);
    if (typeof obj.source_companion === "string" &&
        (obj.source_companion === "cypher" || obj.source_companion === "drevan" || obj.source_companion === "gaia")) {
      item.source_companion = obj.source_companion;
    }
    out.push(item);
    if (out.length >= 16) break;
  }
  return out;
}

/**
 * Validate a list of UUID-shaped ids. Strips:
 *   - non-strings
 *   - strings that don't match the relaxed UUID regex (8-64 hex/dash chars)
 *   - duplicates
 * Caps at 32 to bound the JSON column size.
 */
export function sanitizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const id of input) {
    if (typeof id !== "string") continue;
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) continue;
    seen.add(id);
    if (seen.size >= 32) break;
  }
  return Array.from(seen);
}

/**
 * Clamp model-emitted strength values to [1, 10]. Defaults non-numbers to 3
 * (matches the rubric's lower-middle "recognizable shape but only seen here"
 * tier -- a sane default that doesn't anchor at the prompt's example values).
 */
export function clampStrength(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(10, Math.round(n)));
}

export interface SelfModelVerdict {
  id: string;
  action: "confirm" | "revise" | "retire";
}

/**
 * Parse the model's `self_model_review` against the set of self-model ids that
 * were actually surfaced to it this run. This is what lets a developing
 * observation climb the confidence ladder (confirm +0.1) toward 'ready' -- or
 * fall back (revise -0.1) / be retired -- across autonomous sessions. Without a
 * confirm path nothing ever reaches the 0.8 graduation threshold.
 *
 * Drops:
 *   - non-array input
 *   - entries with a non-string id, or an id the model wasn't shown (hallucinated)
 *   - unknown verdicts (anything other than confirm|revise|retire)
 *   - duplicate ids (first verdict wins)
 *
 * Pure -- exported for tests. `graduate` is intentionally NOT accepted here:
 * graduation is human-gated and only legal from 'ready'.
 */
export function parseSelfModelReview(input: unknown, surfacedIds: Set<string>): SelfModelVerdict[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: SelfModelVerdict[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!id || !surfacedIds.has(id) || seen.has(id)) continue;
    const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
    if (verdictRaw !== "confirm" && verdictRaw !== "revise" && verdictRaw !== "retire") continue;
    seen.add(id);
    out.push({ id, action: verdictRaw });
    if (out.length >= 12) break;
  }
  return out;
}
