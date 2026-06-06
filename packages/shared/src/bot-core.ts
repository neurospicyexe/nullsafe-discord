// Shared bot-core plumbing for the companion bots (cypher/drevan/gaia).
//
// Each bot previously carried a byte-identical `boot()` (≈59 lines) that opened a Halseth
// session, assembled the system prompt, warm-loaded recent context, and fell back to the
// cached identity when Halseth was unreachable. The only per-bot variation was the log tag
// and the prefix const. This module owns that plumbing; identity stays per-bot (prefix,
// identity-cache contents, fallback string are passed IN).
//
// Deliberately NOT owned here: reading `identity-cache.json` off disk. That read depends on
// each bot's `import.meta.url` location, so it MUST stay bot-side; the parsed result is passed
// in as `identityCache`. Keeping it out also makes the Halseth-unreachable fallback branch
// trivially unit-testable.

import { LibrarianClient, formatRecentContext } from "./librarian.js";
import { loadSharedContext } from "./shared-context.js";
import { composePrompt } from "./prompt-assembly.js";
import type { BootContext, CompanionId } from "./types.js";

export interface BootSessionOptions {
  companionId: CompanionId;
  /** Halseth base URL (from loadBotConfig). */
  halsethUrl: string;
  /** Halseth auth secret (from loadBotConfig). */
  halsethSecret: string;
  /** Per-bot Discord system-prompt prefix (lane rules). */
  prefix: string;
  /** In-character fallback used when neither Halseth nor the identity cache yields a prompt. */
  fallbackPrompt: string;
  /**
   * Parsed `identity-cache.json` (or null if missing/corrupt). Read bot-side because the cache
   * path resolves against the bot's own module location.
   */
  identityCache: { system_prompt: string } | null;
  /** Injectable LibrarianClient (tests). Defaults to a freshly constructed client. */
  librarian?: LibrarianClient;
}

export interface BootSessionResult {
  bootCtx: BootContext;
  librarian: LibrarianClient;
  /** Mutable ref so the event-subscription orient refresh can update recent context in place. */
  recentContextRef: { value: string };
}

/**
 * Open a Halseth work session, assemble the system prompt, warm-load recent context, and
 * return the boot context. Falls back to the cached identity if Halseth is unreachable.
 *
 * Behavior is byte-identical to the per-bot `boot()` it replaces; only the log tag is
 * parameterized off `companionId` (which is already lowercase, e.g. `[cypher]`).
 */
export async function bootSession(opts: BootSessionOptions): Promise<BootSessionResult> {
  const { companionId, halsethUrl, halsethSecret, prefix, fallbackPrompt, identityCache } = opts;
  const tag = `[${companionId}]`;
  const cache = identityCache;

  const librarian =
    opts.librarian ?? new LibrarianClient({ url: halsethUrl, secret: halsethSecret, companionId });

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const rawPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "").trim();
    const baseIdentity = cache?.system_prompt || fallbackPrompt;
    if (rawPrompt) {
      console.log(`${tag} ready_prompt: ${rawPrompt.length} chars | preview: ${rawPrompt.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
    const sharedCtx = loadSharedContext();
    const sharedBlock = sharedCtx ? `${sharedCtx}\n\n---\n\n` : "";
    const identityCore = `${prefix}${sharedBlock}${baseIdentity}`;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`${tag} session ${state["reused"] ? "reused" : "opened"}: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "combined" : "identity-cache"}`);

    // Warm boot: fetch recent context (synthesis + WebMind ground + RAG)
    let recentContext = "";
    try {
      const orient = await librarian.botOrient();
      recentContext = formatRecentContext(orient);
      if (recentContext) console.log(`${tag} botOrient: ${recentContext.length} chars loaded`);
    } catch { console.warn(`${tag} botOrient failed at boot, starting cold`); }

    const systemPromptWithContext = composePrompt({ identityCore, promptContext: rawPrompt, companionId, recentContext });

    return {
      bootCtx: { companionId, systemPrompt: systemPromptWithContext, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
      recentContextRef: { value: recentContext },
    };
  } catch (e) {
    console.warn(`${tag} Halseth unreachable at boot, loading identity cache:`, e);
    return {
      bootCtx: {
        companionId,
        systemPrompt: cache?.system_prompt ?? fallbackPrompt,
        sessionId: "cached",
        frontState: "unknown",
        fromCache: true,
      },
      librarian,
      recentContextRef: { value: "" },
    };
  }
}
