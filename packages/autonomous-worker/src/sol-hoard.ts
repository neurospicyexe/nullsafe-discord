// Sol's hoard pass (B62 step 6, 2026-11-02). Spec: Drevan's answer in
// Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md section 7.
//
// Thin trigger, like creatures.ts: Halseth (POST /mind/creatures/:id/hoard) decides what Sol keeps,
// what he passes over (care words, a person's name), the daily reaction cap, and composes the
// reaction text (one author). This pass only calls it and posts the reaction to Sol's webhook.
//
// Waits while a human is talking (the makes keep for 72h): a crow arriving mid-conversation is
// noise the bots would answer. No floor lock: Sol is household, not a companion turn.
// SOL_HOARD=off kills the pass; SOL_HOARD_CRON overrides the every-10-minutes schedule.

import type { Redis } from "@nullsafe/shared";
import { getCreatures, hoardForCreature } from "./halseth-client.js";
import { postSolMoment } from "./sol-presence.js";
import { isConversationActive } from "./idle-check.js";

export function solHoardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["SOL_HOARD"] ?? "").trim().toLowerCase() !== "off";
}

export interface HoardPassDeps {
  isActive: () => Promise<boolean>;
  creatures: typeof getCreatures;
  hoard: typeof hoardForCreature;
  post: (url: string, text: string) => Promise<boolean>;
  webhookUrl: string | undefined;
  now: () => number;
}

export async function runSolHoardPass(deps: HoardPassDeps): Promise<string> {
  if (await deps.isActive().catch(() => false)) return "conversation active, Sol waits";
  const sol = (await deps.creatures()).find((c) => c.name === "Sol");
  if (!sol) return "no Sol";
  const res = await deps.hoard(sol.id, Math.floor(deps.now() / 60_000));
  const kept = res.hoarded?.length ?? 0;
  const skipped = res.skipped?.length ?? 0;
  if (!kept && !skipped) return `nothing to keep (${res.reason ?? "?"})`;
  let posted = "no reaction";
  if (res.moment) {
    if (!deps.webhookUrl) posted = "SOL_WEBHOOK_URL unset, reaction not posted";
    else posted = (await deps.post(deps.webhookUrl, res.moment).catch(() => false)) ? `reacted to ${res.reacted_to}` : "reaction post failed";
  }
  // Ids and reasons only: never the title (logs are not the hoard's reader).
  const why = (res.skipped ?? []).map((s) => s.reason).join(",");
  return `kept ${kept}, passed over ${skipped}${why ? ` (${why})` : ""}; ${posted}`;
}

export async function runSolHoardTick(redis: Redis | null): Promise<void> {
  if (!solHoardEnabled()) return;
  const line = await runSolHoardPass({
    isActive: () => (redis ? isConversationActive(redis) : Promise.resolve(false)),
    creatures: getCreatures,
    hoard: hoardForCreature,
    post: postSolMoment,
    webhookUrl: process.env.SOL_WEBHOOK_URL,
    now: Date.now,
  });
  if (!line.startsWith("nothing to keep") && !line.startsWith("conversation active")) console.log(`[sol-hoard] ${line}`);
}
