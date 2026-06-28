// ND daily-rhythm briefing tick -- thin trigger; compose + deliver lives server-side in
// Halseth (handlers/briefing.ts), gated behind BRIEFING_ENABLED. Halseth-only writes; no
// floor lock, no idle check (a briefing should land whether or not a session is active).
//
// Three daily kinds, each on its own cron (morning/midday/evening). Server-side dedup makes
// at most one of each kind per day, so a missed or duplicate tick is harmless.

import { postBriefing } from "./halseth-client.js";

export type BriefingKind = "morning" | "midday" | "evening";

export async function runBriefingTick(kind: BriefingKind): Promise<void> {
  const res = await postBriefing(kind);
  console.log(
    `[briefing] ${kind} tick: written=${res.written} (${res.reason})` +
    (res.journal_id ? ` ${res.journal_id}` : ""),
  );
}
