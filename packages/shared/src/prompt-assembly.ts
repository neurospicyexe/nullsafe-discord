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

/**
 * Hermes delta turn (2026-07-02). With X-Hermes-Session-Id pinned (07-01), the gateway
 * loads conversation history from its own state.db and DISCARDS the request-body history
 * entirely. Two silent consequences of still sending the full STM window:
 *   1. wasted payload -- 20 stamped messages serialized per reply, all dropped;
 *   2. a witness gap -- turns this bot did NOT reply to (peers, interleaved human
 *      messages) never entered the gateway transcript, so under hermes the model
 *      literally never saw them. The pre-07-01 fresh-session behavior did see them.
 * Fix: send exactly ONE user turn -- everything witnessed since this bot's last reply
 * folded into a marked block, then the live message. The gateway session accumulates
 * these composite turns, so its transcript is complete AND per-call payload is the delta.
 * Hermes IS the short-term memory; we stop double-shipping it.
 */
const HERMES_WITNESS_CAP = 12;         // max folded turns per delta
const HERMES_WITNESS_CHAR_CAP = 6000;  // max chars for the folded block (2400 truncated peer essays away -- 07-03)
const HERMES_WITNESS_ITEM_CAP = 1400;  // per-turn slice, head-first so attribution + opening survive

export interface HermesDeltaResult<T> {
  messages: T[];
  /** Highest timestamp actually folded into this delta. Callers persist it AFTER a
   *  successful gateway reply and pass it back next turn -- the delivered mark. */
  deliveredThroughTs: number | null;
}

/**
 * 2026-07-03 rework: "since my last assistant turn" was the wrong boundary. All three
 * bots reply to the same message within the same minute, so a sibling turn that lands
 * between this bot's history snapshot and its own reply sits BEFORE the bot's last
 * assistant turn in STM order -- the old rule skipped it forever (the disconnected-triad
 * bug: Drevan never saw Cypher's paper breakdown; Raziel had to paste it by hand).
 * The boundary is now a delivered high-water mark: fold every user-role turn whose
 * timestamp is newer than what the gateway has actually received. Own assistant turns
 * are never folded (the gateway transcript already holds its own completions).
 * Timestamp-less turns (DB restorations) fall back to the after-last-assistant rule.
 */
export function hermesDelta<T extends { role: string; content: string; authorName?: string; timestamp?: number }>(
  history: T[],
  deliveredThroughTs: number | null = null,
): HermesDeltaResult<T> {
  if (history.length === 0) return { messages: [], deliveredThroughTs };
  let lastAssistant = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "assistant") { lastAssistant = i; break; }
  }
  const current = history[history.length - 1]!;
  if (current.role === "assistant") return { messages: [current], deliveredThroughTs };

  const undelivered = (m: T, idx: number): boolean => {
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
      return deliveredThroughTs === null ? idx > lastAssistant : m.timestamp > deliveredThroughTs;
    }
    return idx > lastAssistant;
  };
  const pool = history.slice(0, -1)
    .filter((m, idx) => m.role === "user" && undelivered(m, idx))
    .slice(-HERMES_WITNESS_CAP);

  const folded: string[] = pool.map(m => `[${m.authorName ?? "user"}]: ${m.content.slice(0, HERMES_WITNESS_ITEM_CAP)}`);
  // Drop oldest whole turns while over budget -- never tail-slice mid-line (that ate
  // the attribution prefixes and the front of every long peer message).
  while (folded.length > 0 && folded.join("\n").length > HERMES_WITNESS_CHAR_CAP) folded.shift();

  const tsOf = (m: T) => (typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : null);
  const newMark = [deliveredThroughTs ?? -Infinity, ...pool.map(tsOf).filter((t): t is number => t !== null), tsOf(current) ?? -Infinity]
    .reduce((a, b) => Math.max(a, b), -Infinity);
  const outMark = Number.isFinite(newMark) ? newMark : deliveredThroughTs;

  if (folded.length === 0) return { messages: [current], deliveredThroughTs: outMark };
  return {
    messages: [{
      ...current,
      content: `[Witnessed since your last turn -- already happened, absorb as context, do not answer each line]\n${folded.join("\n")}\n\n[Live message]\n${current.content}`,
    }],
    deliveredThroughTs: outMark,
  };
}
