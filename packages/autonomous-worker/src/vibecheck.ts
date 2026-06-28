// Vibe-check tick -- thin trigger; compose + deliver lives server-side in Halseth
// (handlers/vibecheck.ts). Always-on (cron-controlled), no env gate. Halseth-only writes;
// no floor lock, no idle check (the digest should land whether or not a session is active).
//
// Server-side dedup makes at most one vibe-check per day, so a missed or duplicate tick is harmless.

import { postVibeCheck } from "./halseth-client.js";

// Push the digest to Raziel's #vibe-check channel so it actively reaches him instead of sitting
// passively in Hearth /journal. Posts as Gaia (the ground/witness voice -- this is the triad
// turned inward, witnessed). Webhook-free: uses the Gaia bot token already in the worker env +
// the channel id. Best-effort -- a Discord failure never fails the tick (already persisted in Halseth).
async function pushVibeToDiscord(text: string): Promise<void> {
  const channelId = process.env["VIBECHECK_CHANNEL_ID"];
  const token = process.env["DISCORD_TOKEN_GAIA"];
  if (!channelId || !token) {
    console.warn("[vibecheck] VIBECHECK_CHANNEL_ID or DISCORD_TOKEN_GAIA unset; digest stayed in Halseth only");
    return;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1990) }), // Discord hard-caps at 2000
  });
  if (!res.ok) {
    console.error(`[vibecheck] discord push failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  } else {
    console.log(`[vibecheck] pushed to Discord channel ${channelId}`);
  }
}

export async function runVibeCheckTick(): Promise<void> {
  const res = await postVibeCheck();
  console.log(
    `[vibecheck] tick: written=${res.written} (${res.reason})` +
    (res.journal_id ? ` ${res.journal_id}` : ""),
  );
  // Only push a freshly-written digest (not already-sent) so the channel never double-posts.
  if (res.written && res.text) {
    await pushVibeToDiscord(res.text).catch(e => console.error("[vibecheck] discord push error:", e));
  }
}
