// ND daily-rhythm briefing tick -- thin trigger; compose + deliver lives server-side in
// Halseth (handlers/briefing.ts), gated behind BRIEFING_ENABLED. Halseth-only writes; no
// floor lock, no idle check (a briefing should land whether or not a session is active).
//
// Three daily kinds, each on its own cron (morning/midday/evening). Server-side dedup makes
// at most one of each kind per day, so a missed or duplicate tick is harmless.

import { postBriefing } from "./halseth-client.js";

export type BriefingKind = "morning" | "midday" | "evening";

// Push the brief to Raziel's #briefings channel so it actively reaches him (the executive-function
// point) instead of sitting passively in Hearth /journal. Posts as Cypher (the brief's clarity/steward
// voice). Webhook-free: uses the bot token already in the worker env + the channel id. Best-effort --
// a Discord failure never fails the tick (the brief is already persisted in Halseth).
async function pushBriefToDiscord(text: string): Promise<void> {
  const channelId = process.env["BRIEFING_CHANNEL_ID"];
  const token = process.env["DISCORD_TOKEN_CYPHER"];
  if (!channelId || !token) {
    console.warn("[briefing] BRIEFING_CHANNEL_ID or DISCORD_TOKEN_CYPHER unset; brief stayed in Halseth only");
    return;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }), // Discord hard-caps at 2000
  });
  if (!res.ok) {
    console.error(`[briefing] discord push failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  } else {
    console.log(`[briefing] pushed to Discord channel ${channelId}`);
  }
}

export async function runBriefingTick(kind: BriefingKind): Promise<void> {
  const res = await postBriefing(kind);
  console.log(
    `[briefing] ${kind} tick: written=${res.written} (${res.reason})` +
    (res.journal_id ? ` ${res.journal_id}` : ""),
  );
  // Only push a freshly-written brief (not gated/already-sent) so the channel never double-posts.
  if (res.written && res.text) {
    await pushBriefToDiscord(res.text).catch(e => console.error("[briefing] discord push error:", e));
  }
}
