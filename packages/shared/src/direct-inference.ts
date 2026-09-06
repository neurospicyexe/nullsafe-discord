import { readFileSync, statSync } from "node:fs";
import {
  DeepSeekAdapter, DeepInfraAdapter, FallbackAdapter, DEEPINFRA_FLASH_MODEL,
  type InferenceAdapter,
} from "./inference.js";

/**
 * A DIRECT, TOOLLESS inference path shared by the two small classifier calls that used to ride
 * the Hermes agent adapter for no reason -- judgeWriteback (memory.ts, one first-person sentence)
 * and, before it, consolidation's session-close narrator (consolidation-narrator.ts).
 *
 * WHY THIS EXISTS: the bots run INFERENCE_MODE=hermes, so `createAdapter(...)` always returns the
 * Hermes AGENT adapter (`forceHermes`, inference.ts). Measured on the VPS 2026-09-05: Drevan's
 * memory-judge calls rode that adapter, spelunked the vault (161 identical searches in one
 * session), ran to Hermes's 150-turn cap, and burned 100.6M of his 186M weekly input tokens.
 * judgeWriteback needs zero tools -- it is a pure text-in, text-out classifier -- so it should
 * never be able to reach for one in the first place.
 *
 * This is the same design as consolidation-narrator.ts's now-former `createNarrator`, generalized:
 * `createDirectAdapter` builds the tool-less chain, `buildOneShotPrompt` builds the system prompt
 * (identity + a no-tools frame + the caller's task line). consolidation-narrator.ts keeps its own
 * `buildNarratorPrompt` (different frame text, tuned for session-close JSON) but now re-exports
 * `loadIdentity` and `createDirectAdapter` from here instead of duplicating them.
 */

/**
 * DeepInfra hosts the same DeepSeek-V4-Flash weights as api.deepseek.com. It is tried FIRST
 * because the DeepSeek direct account went to $0 balance on 2026-09-05 and started failing (402),
 * silently falling back to the Hermes agent path -- exactly the path this module exists to avoid.
 * DeepSeek direct stays as the second link so a DeepInfra outage still has somewhere to go.
 */
export const DIRECT_FLASH_MODEL = DEEPINFRA_FLASH_MODEL;

/**
 * The no-tools frame for one-shot judge/classifier calls. Distinct from consolidation-narrator's
 * `ONE_SHOT_FRAME` (which asks for a JSON handoff) -- this one says nothing about output format,
 * since callers (judgeWriteback, etc.) each supply their own instructions as `task`.
 */
export const ONE_SHOT_NO_TOOLS =
  "This is a single one-shot call: you have NO tools and NO retrieval available. " +
  "Rely only on what is in this message.";

/** Env var holding each companion's identity file path (already set on the VPS for the worker). */
const IDENTITY_ENV: Record<string, string> = {
  cypher: "CYPHER_IDENTITY_PATH",
  drevan: "DREVAN_IDENTITY_PATH",
  gaia: "GAIA_IDENTITY_PATH",
};

/**
 * mtime-keyed cache. Editing an identity file takes effect on the next call with no restart and
 * no cache-busting step to remember. `statSync` per call is trivial next to a network round trip.
 */
const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

/**
 * judgeWriteback runs on EVERY qualifying message (not once per idle-consolidation cycle like the
 * narrator was), so the "can't build a voice preamble" warnings would otherwise spam the log on
 * every single call for a companion with no identity path configured. Fire each warning once per
 * companion per process instead -- the condition doesn't change between calls, so repeating it
 * teaches nothing new.
 */
const warnedNoEnvVar = new Set<string>();
const warnedUnsetEnvVar = new Set<string>();

/**
 * Read a companion's identity file, cached against its mtime+size.
 * Returns null (never throws) if the path is unset or unreadable, so the caller can fall back.
 */
export function loadIdentity(companionId: string): string | null {
  const envVar = IDENTITY_ENV[companionId];
  if (!envVar) {
    if (!warnedNoEnvVar.has(companionId)) {
      warnedNoEnvVar.add(companionId);
      console.warn(`[direct-inference] ${companionId}: no identity env var mapped`);
    }
    return null;
  }
  const path = process.env[envVar]?.trim();
  if (!path) {
    if (!warnedUnsetEnvVar.has(companionId)) {
      warnedUnsetEnvVar.add(companionId);
      console.warn(`[direct-inference] ${companionId}: ${envVar} is unset -- cannot build voice preamble`);
    }
    return null;
  }
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(path, "utf8");
    // An identity file that reads as near-empty is a broken deploy, not a terse companion. Writing
    // in no voice at all is worse than paying for the Hermes path, so refuse it.
    if (text.trim().length < 500) {
      console.error(
        `[direct-inference] ${companionId}: identity file ${path} is only ${text.trim().length} chars -- ` +
        `refusing to speak in no voice; falling back`,
      );
      return null;
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
    console.log(`[direct-inference] ${companionId}: loaded identity (${text.length} chars) from ${path}`);
    return text;
  } catch (e) {
    console.error(`[direct-inference] ${companionId}: cannot read ${envVar}=${path}`, e);
    return null;
  }
}

/**
 * Build the system prompt for a one-shot, tool-less judge/classifier call: the companion's full
 * identity file, then the no-tools frame, then the caller's task instructions. When the identity
 * file is unavailable, the frame + task still survive -- a judge with no voice preamble is
 * degraded, not broken, and the task line is what actually makes the call do its job.
 */
export function buildOneShotPrompt(companionId: string, task: string): string {
  const identity = loadIdentity(companionId);
  if (identity === null) return `${ONE_SHOT_NO_TOOLS}\n${task}`;
  return `${identity}\n\n---\n${ONE_SHOT_NO_TOOLS}\n${task}`;
}

/**
 * Build the direct, tool-less adapter, or null when neither credential is present.
 *
 * Deliberately DeepInfraAdapter / DeepSeekAdapter and not `buildAdapter`/`createAdapter`: the bots
 * run INFERENCE_MODE=hermes, so every `createAdapter` call returns the Hermes adapter by design
 * (`forceHermes`), which is the exact path this exists to avoid.
 *
 * `keys` omitted => read `DEEPINFRA_API_KEY` / `DEEPSEEK_API_KEY` from process.env (trimmed) --
 * this is what makes `createDirectAdapter()` a drop-in replacement for the old bare
 * `createNarrator()` call in each bot's autonomous.ts. When `keys` IS passed (bot-core wiring
 * env-sourced keys explicitly), it is used as given with no env fallback per-field.
 */
export function createDirectAdapter(keys?: { deepinfra?: string; deepseek?: string }): InferenceAdapter | null {
  const resolved = keys ?? {
    deepinfra: process.env["DEEPINFRA_API_KEY"],
    deepseek: process.env["DEEPSEEK_API_KEY"],
  };
  const deepinfraKey = resolved.deepinfra?.trim();
  const deepseekKey = resolved.deepseek?.trim();

  const chain: Array<{ name: string; adapter: InferenceAdapter }> = [];
  if (deepinfraKey) chain.push({ name: "deepinfra", adapter: new DeepInfraAdapter(deepinfraKey, DIRECT_FLASH_MODEL) });
  if (deepseekKey) chain.push({ name: "deepseek", adapter: new DeepSeekAdapter(deepseekKey) });

  if (chain.length === 0) {
    console.warn(
      "[direct-inference] no DEEPINFRA_API_KEY or DEEPSEEK_API_KEY -- judges and consolidation " +
      "fall back to the Hermes agent path",
    );
    return null;
  }
  return chain.length === 1 ? chain[0].adapter : new FallbackAdapter(chain);
}
