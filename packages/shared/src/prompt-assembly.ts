// Shared system-prompt assembly for the companion bots.
//
// Each bot (cypher/drevan/gaia) previously assembled its Discord system prompt with the
// same inline string-joining logic, copy-pasted in two places per bot: at boot and again on
// the periodic SOMA refresh. That duplication drifted and hid subtle behavior (e.g. how the
// refresh path re-derives the identity base). This module is the single source of truth.
//
// Identity itself stays per-bot — the prefix, shared block, and base identity are passed IN.
// This only owns the *structure* (how the sections are joined), never the content.

/** The canonical block separator the bots use between prompt sections. */
export const SECTION_SEP = "\n\n---\n\n";

/** The trailing instruction appended whenever a prompt-context block is present. */
export function respondOnlyAs(companionId: string): string {
  return `Respond only as ${companionId}. Never use [Name]: prefixes.`;
}

export interface ComposePromptOptions {
  /**
   * The fully-composed identity head.
   * - Boot site: `${prefix}${sharedBlock}${baseIdentity}`.
   * - Refresh site: the `identityBase` derived via {@link deriveIdentityBase}.
   */
  identityCore: string;
  /** Per-session prompt context (Halseth `prompt_context`/`ready_prompt`). Falsy = omitted. */
  promptContext?: string;
  /** Companion id, used for the `Respond only as ...` tail. */
  companionId: string;
  /** Recent context block (synthesis/orient). Falsy = omitted. */
  recentContext?: string;
}

/**
 * Assemble a bot system prompt. Covers both the boot-time and SOMA-refresh assembly the bots
 * did inline. Byte-identical to the original ternary logic:
 *
 *   core = promptContext
 *     ? `${identityCore}${SEP}${promptContext}${SEP}${respondOnlyAs(id)}`
 *     : identityCore
 *   return recentContext ? `${core}${SEP}${recentContext}` : core
 */
export function composePrompt(opts: ComposePromptOptions): string {
  const { identityCore, promptContext, companionId, recentContext } = opts;
  const core = promptContext
    ? `${identityCore}${SECTION_SEP}${promptContext}${SECTION_SEP}${respondOnlyAs(companionId)}`
    : identityCore;
  return recentContext ? `${core}${SECTION_SEP}${recentContext}` : core;
}

/**
 * Derive the identity base from a previously-assembled system prompt — the first section
 * before the first separator. Mirrors the original `bootCtx.systemPrompt.split(SEP)[0]`.
 */
export function deriveIdentityBase(assembledSystemPrompt: string): string {
  return assembledSystemPrompt.split(SECTION_SEP)[0] ?? assembledSystemPrompt;
}
