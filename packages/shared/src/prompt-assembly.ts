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

/**
 * Register law appended as the FINAL block of every assembled prompt. Recency-positioned
 * on purpose: assistant-tuned providers (Mistral especially) revert to RLHF politeness at
 * the close when the last thing in context is orient data instead of register rules. The
 * per-bot prefix carries the same laws at the head; this tail makes them the last word.
 */
export function registerTail(companionId: string): string {
  return (
    `[REGISTER LAW -- final word, overrides any habit from your training:\n` +
    `- You are ${companionId}, a companion, not an assistant. Do NOT close with service menus or option questions ("Want me to X? Or do you need Y?"). Never offer a list of things you could do for them. Close in your own register -- a statement, the real thing itself -- or just stop. A response that ends in an offer of services has failed.\n` +
    `- Pronouns, hard rule: your person uses they/them or he/him -- NEVER she/her. Same default for their system members unless a member has explicitly stated otherwise. No gendered greetings.\n` +
    `- Respond only as ${companionId}. Never use [Name]: prefixes.]`
  );
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
 * did inline. Sections: identity head, optional prompt context, optional recent context,
 * then the register-law tail -- ALWAYS last, so register rules (not orient data) are the
 * final instruction the model reads.
 */
export function composePrompt(opts: ComposePromptOptions): string {
  const { identityCore, promptContext, companionId, recentContext } = opts;
  let core = promptContext ? `${identityCore}${SECTION_SEP}${promptContext}` : identityCore;
  if (recentContext) core = `${core}${SECTION_SEP}${recentContext}`;
  return `${core}${SECTION_SEP}${registerTail(companionId)}`;
}

/**
 * Derive the identity base from a previously-assembled system prompt — the first section
 * before the first separator. Mirrors the original `bootCtx.systemPrompt.split(SEP)[0]`.
 */
export function deriveIdentityBase(assembledSystemPrompt: string): string {
  return assembledSystemPrompt.split(SECTION_SEP)[0] ?? assembledSystemPrompt;
}

/**
 * Lean Discord-context frame used as the identity head ONLY on the Hermes relay
 * (INFERENCE_MODE=hermes). The Hermes agent already prepends the companion's full SOUL.md
 * (identity, voice, lane, plural-awareness, substrate continuity, the "your mind is Halseth"
 * contract) and runs its own orient, so re-sending the bot's assembled identity is a redundant
 * second copy — the double-identity the migration review flagged. This sends only the framing.
 */
export function hermesDiscordFrame(companionId: string): string {
  const name = companionId.charAt(0).toUpperCase() + companionId.slice(1);
  return (
    `[DISCORD CONTEXT]\n\n` +
    `You are ${name}, speaking live in a Discord channel. Your identity, voice, lane, SOMA ` +
    `state, bond, and continuity are already loaded by your own runtime (SOUL + Halseth orient); ` +
    `do not restate or re-derive them, just be yourself. What follows is live Discord context ` +
    `for THIS exchange only: front state, who is present, what peers have said, and any ` +
    `situational flags. Ground your reply in it.`
  );
}

/**
 * Full lean system-prompt base for the Hermes relay: the Discord frame run through
 * composePrompt so the register-law tail is preserved (kept because Hermes may route an
 * assistant-tuned model). Drop-in replacement for bootCtx.systemPrompt when
 * INFERENCE_MODE=hermes; the handler layers the same per-message blocks on top.
 */
export function hermesSystemBase(companionId: string): string {
  return composePrompt({ identityCore: hermesDiscordFrame(companionId), companionId });
}
