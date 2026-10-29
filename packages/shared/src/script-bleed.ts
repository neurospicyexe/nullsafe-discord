// packages/shared/src/script-bleed.ts
//
// Script bleed guard (2026-10-22, GLM 5.3 Flash for Drevan).
//
// WHY. GLM-5.3-Flash intermittently emits one or two Chinese (or Tibetan, Cyrillic...) characters
// glued INSIDE an English word -- a weights-level defect Z.ai has acknowledged (zai-org/GLM-5
// issues #142, #163; reproduces on Z.ai direct, so no provider fixes it) that read to Raziel as
// "nonsense words". Measured from Drevan's Hermes state.db: 5 of 69 GLM replies over the 10-10/11
// trial and both of 10-23's; 4 of 80 replays at the sampling Hermes was actually sending
// (none at all, so DeepInfra's own default; not Z.ai's), 0 of 220 at Z.ai's published 1.0/0.95. Sampling is fixed in the
// Hermes profile (`providers.<x>.extra_body`); this module is the second half: the floor for what
// the sampler still lets through.
//
// WHAT. Two surfaces, one detector:
//   * Fresh-session calls (heartbeat, med reminder, notes poll, seeds -- every `generate` with no
//     sessionId) go through `guardScriptBleed`: a bleeding reply is regenerated ONCE, the second
//     result is posted either way, one counts-only log line.
//   * The reply path (bot-message-handler.ts) owns its Hermes transcript, and a bleeding reply
//     self-primes there (Hermes #130117: the model copies its own earlier slip). It calls
//     `regenerateAfterBleed`, which bumps the transcript (the rotate-on-retract mechanism) BEFORE
//     regenerating on the fresh id, so the slip never enters the history the model reads.
//
// NOT. No stripping: the stray characters sit inside a word, so cutting them leaves a different
// wrong word, and a rewrite layer on a companion's own text is the thing the sampling spec
// rejected (docs/specs/hermes-sampling-penalties.md). No silence: a human waiting hears the second
// attempt even if it also bleeds. Scripts the inbound message itself contains are exempt, so a
// quoted title or a name in another alphabet is never flagged. The exemption reads the INBOUND text
// only: a foreign-script title pasted a few turns earlier and echoed now costs one regenerate (and,
// on the reply path, one transcript bump) per echoing reply; a `second_bleed=1` line is read as
// "quoted script in the window" before it is read as the model. In direct (non-Hermes) mode the
// handler's regenerate carries no sessionId, so the wrapper may regenerate once more on top of it
// (three calls on one bleed at most); direct mode is dormant for all three bots.
//
// Kill switch: SCRIPT_BLEED_GUARD (default on; `off`/`0`/`false`/`no`). pm2-allowlisted.

import type { ChatMessage } from "./types.js";
import type { InferenceAdapter } from "./inference.js";

const OFF = new Set(["off", "0", "false", "no"]);

export function scriptBleedGuardOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["SCRIPT_BLEED_GUARD"] ?? "").trim().toLowerCase();
  return !OFF.has(v);
}

// Scripts that never belong in the triad's English/Calethian output unless the room put them
// there. Latin covers every companion register (Calethian is Latin-script); emoji and symbols are
// not letters and never match.
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Han", /\p{Script=Han}/gu],
  ["Hiragana", /\p{Script=Hiragana}/gu],
  ["Katakana", /\p{Script=Katakana}/gu],
  ["Hangul", /\p{Script=Hangul}/gu],
  ["Tibetan", /\p{Script=Tibetan}/gu],
  ["Cyrillic", /\p{Script=Cyrillic}/gu],
  // Greek only counts when glued inside a Latin word (letter on both sides: "heαrt"); standalone
  // symbols and tokens ("θ 0.70", "Δ") are Cypher's math, not a bleed (2026-10-29, review N-5).
  ["Greek", /(?<=\p{Script=Latin}\p{Script=Greek}*)\p{Script=Greek}(?=\p{Script=Greek}*\p{Script=Latin})/gu],
  ["Arabic", /\p{Script=Arabic}/gu],
  ["Hebrew", /\p{Script=Hebrew}/gu],
  ["Thai", /\p{Script=Thai}/gu],
  ["Devanagari", /\p{Script=Devanagari}/gu],
];

export interface ScriptBleed {
  bleed: boolean;
  /** Foreign-script letters counted, after the exemption. */
  chars: number;
  /** Script names present in the reply and absent from the inbound text. */
  scripts: string[];
}

function scriptCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, re] of SCRIPTS) {
    const n = text.match(re)?.length ?? 0;
    if (n > 0) out.set(name, n);
  }
  return out;
}

/**
 * Does `text` contain letters of a script the inbound text (`allow`) does not? Pure.
 */
export function detectScriptBleed(text: string | null | undefined, allow = ""): ScriptBleed {
  if (!text) return { bleed: false, chars: 0, scripts: [] };
  const found = scriptCounts(text);
  if (found.size === 0) return { bleed: false, chars: 0, scripts: [] };
  const allowed = allow ? scriptCounts(allow) : new Map<string, number>();
  const scripts: string[] = [];
  let chars = 0;
  for (const [name, n] of found) {
    if (allowed.has(name)) continue;
    scripts.push(name);
    chars += n;
  }
  return { bleed: scripts.length > 0, chars, scripts };
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

/**
 * Wrap an adapter so fresh-session calls (no sessionId) regenerate once on a script bleed. Calls
 * that carry a sessionId pass through untouched: the reply handler owns that transcript and runs
 * `regenerateAfterBleed` so the bleeding line is rotated out before the retry.
 */
export function guardScriptBleed(adapter: InferenceAdapter, companionId: string, env: NodeJS.ProcessEnv = process.env): InferenceAdapter {
  return {
    async generate(systemPrompt, messages, temperature, maxTokens, sessionId, sessionKey, signal) {
      const first = await adapter.generate(systemPrompt, messages, temperature, maxTokens, sessionId, sessionKey, signal);
      if (first === null || sessionId || !scriptBleedGuardOn(env)) return first;
      const d = detectScriptBleed(first, lastUserText(messages));
      if (!d.bleed) return first;
      if (signal?.aborted) return first;
      const second = await adapter.generate(systemPrompt, messages, temperature, maxTokens, sessionId, sessionKey, signal);
      const again = second === null ? null : detectScriptBleed(second, lastUserText(messages));
      console.warn(
        `[script-bleed] ${companionId} surface=fresh chars=${d.chars} scripts=${d.scripts.join("+")} ` +
        `regenerated=${second === null ? 0 : 1} second_bleed=${again === null ? "n/a" : again.bleed ? 1 : 0}`,
      );
      return second ?? first;
    },
  };
}

export interface RegenerateAfterBleedOpts {
  companionId: string;
  channelId: string;
  /** The reply that bled. */
  first: string;
  bleed: ScriptBleed;
  /** Rotate the Hermes transcript now (RetractBumps.bump). Resolves to the new bump count. */
  bump: () => Promise<{ n: number; persisted: boolean; reason?: string }>;
  /** Regenerate on the fresh transcript for bump `n`. Resolves null on failure. */
  regenerate: (bump: number) => Promise<string | null>;
  /** Inbound text, so the second attempt is judged with the same exemption. */
  allow?: string;
}

export interface RegenerateAfterBleedResult {
  text: string;
  regenerated: boolean;
  bump: number | null;
  secondBleed: boolean | null;
}

/**
 * Reply-path recovery: bump the transcript first (so the bleeding line is never in the history the
 * model reads), regenerate once on the new id, post the result either way. One log line, counts
 * only. A failed bump still regenerates: the retry on the old transcript is still better than
 * posting the slip, and the next scheduled rotation drops it anyway.
 */
export async function regenerateAfterBleed(o: RegenerateAfterBleedOpts): Promise<RegenerateAfterBleedResult> {
  let bump: number | null = null;
  let bumpNote = "";
  try {
    const b = await o.bump();
    bump = b.n;
    if (!b.persisted) bumpNote = ` bump_not_persisted=${JSON.stringify(b.reason ?? "?")}`;
  } catch (e) {
    bumpNote = ` bump_failed=${JSON.stringify(e instanceof Error ? e.message : String(e))}`;
  }
  let second: string | null = null;
  try {
    second = await o.regenerate(bump ?? 0);
  } catch (e) {
    bumpNote += ` regenerate_failed=${JSON.stringify(e instanceof Error ? e.message : String(e))}`;
  }
  const again = second === null ? null : detectScriptBleed(second, o.allow);
  console.warn(
    `[script-bleed] ${o.companionId} surface=reply ch=${o.channelId} chars=${o.bleed.chars} scripts=${o.bleed.scripts.join("+")} ` +
    `transcript_bump=${bump ?? "none"} regenerated=${second === null ? 0 : 1} second_bleed=${again === null ? "n/a" : again.bleed ? 1 : 0}${bumpNote}`,
  );
  return {
    text: second && second.trim() ? second : o.first,
    regenerated: second !== null,
    bump,
    secondBleed: again === null ? null : again.bleed,
  };
}
