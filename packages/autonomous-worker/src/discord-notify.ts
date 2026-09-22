// Worker -> Discord notification, webhook-free.
//
// Extracted from briefing.ts's pushBriefToDiscord (2026-09-22) because the Club needed the same
// thing and copying a second fetch would have been two authors for one job. briefing.ts is
// deliberately NOT refactored onto this: it has 490 successful pushes behind it and changing a
// working delivery path to share code with a new one trades a real guarantee for tidiness.
//
// Posts as Cypher using the bot token already in the worker env plus a channel id. Best-effort by
// contract: every failure is logged and swallowed, because the caller's real work (a Halseth write)
// has already happened and must never be undone by a Discord hiccup.

const DISCORD_MAX = 2000;

export interface NotifyResult {
  sent: boolean;
  /** Why not, when `sent` is false -- so a caller's log line can say something truthful. */
  reason?: "unconfigured" | "http" | "threw";
}

/**
 * Post `text` to `channelId` as the Cypher bot. Never throws.
 *
 * `tag` only labels the log lines, so one grep can separate a club announce from a briefing push.
 */
export async function notifyDiscord(channelId: string | undefined, text: string, tag: string): Promise<NotifyResult> {
  const token = process.env["DISCORD_TOKEN_CYPHER"];
  if (!channelId || !token) {
    console.warn(`[${tag}] BRIEFING_CHANNEL_ID or DISCORD_TOKEN_CYPHER unset -- notice stayed in Halseth only`);
    return { sent: false, reason: "unconfigured" };
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, DISCORD_MAX - 10) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[${tag}] discord push failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
      return { sent: false, reason: "http" };
    }
    console.log(`[${tag}] pushed to Discord channel ${channelId}`);
    return { sent: true };
  } catch (err) {
    console.error(`[${tag}] discord push error:`, err);
    return { sent: false, reason: "threw" };
  }
}

/** The channel the worker announces house events into (#briefings). */
export function noticeChannelId(): string | undefined {
  return process.env["BRIEFING_CHANNEL_ID"];
}
