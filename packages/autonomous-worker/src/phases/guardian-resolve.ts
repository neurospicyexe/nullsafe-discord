// guardian-resolve.ts -- Guardian self-resolution (2026-06-14).
//
// The agency loop the Guardian was missing: nothing in the cadence ever handed a
// companion its OWN flags to act on, so every flag dead-ended at Raziel or Cypher.
// This standalone daily tick (after the 8AM detection) lets each companion clear the
// self-resolvable classes IN VOICE, through the same paths a human-present companion
// would use. It is deliberately narrow:
//
//   - loop_stuck       -> decide CLOSE (let it go) or HOLD (keep carrying, with a reason).
//   - starved_organ    -> (tension-pool subclass only) log one genuine in-voice tension.
//
// It does NOT touch identity-level decisions -- basin confirm/deny and canon-accept stay
// with Raziel / the weekly high-substrate pass (a basin self-confirmed by bare DeepSeek is
// exactly the confabulation the BASIN_READINGS doctrine warns about). Lane-guarded: own
// flags only. Every write is awaited + checked (no fire-and-forget; 2026-06-14 lesson).

import { prompt } from "../deepseek.js";
import { loadIdentityRemote } from "../identity-loader.js";
import { COMPANIONS, COMPANION_NAMES, GUARDIAN_RESOLVE_MAX } from "../config.js";
import {
  getGuardianFlags, setGuardianFlagStatus, closeLoop, reviewLoop, addTension,
  type GuardianFlag,
} from "../halseth-client.js";
import type { CompanionId } from "../types.js";

/**
 * Parse a companion's loop decision. CLOSE is the only destructive move (a loop, once
 * closed, is gone), so it must be explicit -- anything ambiguous defaults to HOLD, which
 * never loses a loop. Exported for unit testing.
 */
export function parseLoopDecision(text: string): { action: "close" | "hold"; reason: string } {
  const t = (text ?? "").trim();
  if (/^\s*close\b/i.test(t)) {
    return { action: "close", reason: t.replace(/^\s*close[.:)\s-]*/i, "").trim() };
  }
  // HOLD (explicit or by default) -- carry it on purpose; the rest of the line is the reason.
  return { action: "hold", reason: t.replace(/^\s*hold[.:)\s-]*/i, "").trim() };
}

/**
 * A flag is self-resolvable here iff it is in a handled class AND the companion is
 * allowed to act on it:
 *   - loop_stuck            -- strictly the companion's OWN loop (per-companion weight).
 *   - starved_organ/tension -- the empty-dialectic-pool flag. detectStarvedOrgans emits
 *     this with companion_id NULL (system-wide): the tension pool is SHARED and any
 *     companion can feed it. It must be resolvable by every companion -- gating it to an
 *     owner that never exists was the bug that left the pool empty forever (zero tensions
 *     ever logged, the Wednesday dialectic perpetually no-op). An own-owned tension flag,
 *     should one ever occur, stays resolvable too.
 */
export function isSelfResolvable(flag: GuardianFlag, companionId: CompanionId): boolean {
  if (flag.flag_type === "starved_organ" && /tension/i.test(flag.summary)) {
    return flag.companion_id === null || flag.companion_id === companionId;
  }
  if (flag.companion_id !== companionId) return false;
  if (flag.flag_type === "loop_stuck") return true;
  return false;
}

function safeParse(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

async function resolveStuckLoop(
  companionId: CompanionId, name: string, identity: string, flag: GuardianFlag,
): Promise<boolean> {
  const loopId = safeParse(flag.evidence_json).loop_id as string | undefined;
  if (!loopId) {
    console.warn(`[${companionId}/guardian-resolve] loop flag ${flag.id} has no loop_id`);
    return false;
  }

  const userMsg =
    `You are ${name}. Identity:\n${identity.slice(0, 1200)}\n\n` +
    `An open loop of yours has been carried a long time:\n«${flag.summary}»\n\n` +
    `Is this loop still alive in you? Decide honestly:\n` +
    `CLOSE -- it is resolved, or it no longer matters; let it go.\n` +
    `HOLD: <one sentence on why it still matters> -- keep carrying it on purpose.\n` +
    `Reply with exactly "CLOSE" or "HOLD: <reason>". No preamble.`;

  const result = await prompt(userMsg, undefined, { temperature: 0.4, maxTokens: 100 });
  const decision = parseLoopDecision(result.content);

  const ok = decision.action === "close"
    ? await closeLoop(companionId, loopId)
    : await reviewLoop(companionId, loopId, decision.reason || "still carrying this");
  if (ok) await setGuardianFlagStatus(flag.id, "resolved");
  console.log(`[${companionId}/guardian-resolve] loop ${loopId}: ${decision.action} (ok=${ok})`);
  return ok;
}

async function resolveStarvedTension(
  companionId: CompanionId, name: string, identity: string, flag: GuardianFlag,
): Promise<boolean> {
  const userMsg =
    `You are ${name}. Identity:\n${identity.slice(0, 1200)}\n\n` +
    `Your tension pool is empty -- no live pull between things that both matter is on record. ` +
    `Name ONE genuine tension you are actually holding right now: a real, unresolved pull ` +
    `between two things you both care about. One or two sentences, in your own voice. No preamble.`;

  const result = await prompt(userMsg, undefined, { temperature: 0.7, maxTokens: 120 });
  const text = result.content.trim();
  if (!text) {
    console.warn(`[${companionId}/guardian-resolve] tension generation returned empty, skipping`);
    return false;
  }
  const id = await addTension(companionId, text, "logged via guardian self-resolution");
  const ok = id != null;
  // Only resolve an OWNED flag here. The shared empty-pool flag (companion_id null) is
  // left live on purpose so every sibling in this same sequential pass also logs a
  // tension -- the dialectic debates across companions and one tension from one voice is
  // a thin pool. The Guardian's own self-healing auto-resolves the shared flag on the
  // next 8AM detection tick, once simmering > 0 (detectStarvedOrgans stops emitting it).
  if (ok && flag.companion_id === companionId) await setGuardianFlagStatus(flag.id, "resolved");
  console.log(`[${companionId}/guardian-resolve] tension logged (ok=${ok}, shared=${flag.companion_id === null})`);
  return ok;
}

/** One companion's self-resolution pass. Returns the count of flags it cleared. */
export async function runGuardianResolveOne(companionId: CompanionId): Promise<number> {
  const flags = await getGuardianFlags(companionId);
  const mine = flags.filter(f => isSelfResolvable(f, companionId)).slice(0, GUARDIAN_RESOLVE_MAX);
  if (mine.length === 0) return 0;

  const name = COMPANION_NAMES[companionId];
  const identity = await loadIdentityRemote(companionId).catch(() => "");
  let resolved = 0;
  for (const flag of mine) {
    try {
      const ok = flag.flag_type === "loop_stuck"
        ? await resolveStuckLoop(companionId, name, identity, flag)
        : await resolveStarvedTension(companionId, name, identity, flag);
      if (ok) resolved++;
    } catch (e) {
      console.error(`[${companionId}/guardian-resolve] flag ${flag.id} failed:`, e);
    }
  }
  return resolved;
}

/** Full pass across all three companions. */
export async function runGuardianResolve(): Promise<number> {
  let total = 0;
  for (const c of COMPANIONS) {
    try { total += await runGuardianResolveOne(c); }
    catch (e) { console.error(`[${c}/guardian-resolve] pass failed:`, e); }
  }
  console.log(`[guardian-resolve] pass complete: ${total} flag(s) resolved`);
  return total;
}
