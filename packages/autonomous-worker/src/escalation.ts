// escalation.ts -- tier-3 delivery (consequence layer C1, R1 decided 2026-08-17).
//
// Halseth's care rider detects (rules-first: meds 3d / sustained redline 48h / silence 72h) and
// writes care_escalations; this tick drains the undelivered rows to BLUE via Discord DM (R1b,
// amended same day from Telegram: the bots already have tokens, and a DM needs no new pipe).
//
// The message is DETERMINISTIC, never LLM-composed -- a safety message to a human must say
// exactly what fired and why ([[det-acks]]: owner-facing actions need literal acks; a human
// being asked to check on Raziel deserves the same literalism).
//
// Delivery ladder: DM Blue (ESCALATION_DISCORD_USER_ID) -> loud post in the fallback channel
// (ESCALATION_FALLBACK_CHANNEL_ID, else VIBECHECK_CHANNEL_ID -- Raziel's own channel, which is
// still better than silence). If NOTHING lands, the row stays undelivered and retries every
// tick, loudly -- an escalation that silently expires is the failure this tier exists to prevent.

import { getPendingEscalations, ackEscalationDelivered, recordEscalationAttempt } from "./halseth-client.js";
import { COMPANION_NAMES } from "./config.js";

const RULE_FRAMING: Record<string, string> = {
  esc_meds: "his meds routine has gone unlogged for 3+ days",
  esc_redline: "every self-report he's logged across the last two days has been at redline (very low spoons + low mood), with no recovery reading between them",
  esc_silence: "he has been completely silent on every surface for 72+ hours",
};

const TOKEN_ENV: Record<string, string> = {
  cypher: "DISCORD_TOKEN_CYPHER",
  drevan: "DISCORD_TOKEN_DREVAN",
  gaia: "DISCORD_TOKEN_GAIA",
};

function composeEscalation(companionId: string, rule: string, detail: string, detectedAt: string): string {
  const name = COMPANION_NAMES[companionId as keyof typeof COMPANION_NAMES] ?? companionId;
  const framing = RULE_FRAMING[rule] ?? "an automated care threshold was crossed";
  return (
    `Hi Blue -- this is ${name}, from Raziel's triad. An automated care rule fired: ${framing}.\n` +
    `Evidence: ${detail} (detected ${detectedAt}).\n` +
    `Please check on him when you can. This message is rule-driven, not a judgment call, and ` +
    `the same condition will not ping you again for at least 48 hours.`
  );
}

/** Bot token for the assigned voice, falling back to ANY available token -- delivery outranks voice. */
function tokenFor(companionId: string): string | null {
  const own = process.env[TOKEN_ENV[companionId] ?? ""];
  if (own) return own;
  for (const env of Object.values(TOKEN_ENV)) {
    const t = process.env[env];
    if (t) return t;
  }
  return null;
}

async function discordPost(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`https://discord.com/api/v10${path}`, {
    method: "POST",
    headers: { "Authorization": `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DM a user: open (or reuse) the DM channel, then post. Returns false on any failure. */
async function sendDm(token: string, userId: string, content: string): Promise<boolean> {
  try {
    const ch = await discordPost("/users/@me/channels", token, { recipient_id: userId });
    if (!ch.ok) {
      console.error(`[escalation] open DM channel failed: ${ch.status} ${(await ch.text().catch(() => "")).slice(0, 160)}`);
      return false;
    }
    const channel = await ch.json() as { id: string };
    const msg = await discordPost(`/channels/${channel.id}/messages`, token, { content: content.slice(0, 1990) });
    if (!msg.ok) {
      console.error(`[escalation] DM send failed: ${msg.status} ${(await msg.text().catch(() => "")).slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[escalation] DM error:", e);
    return false;
  }
}

async function sendChannel(token: string, channelId: string, content: string): Promise<boolean> {
  try {
    const res = await discordPost(`/channels/${channelId}/messages`, token, { content: content.slice(0, 1990) });
    if (!res.ok) {
      console.error(`[escalation] fallback channel send failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    return res.ok;
  } catch (e) {
    console.error("[escalation] fallback channel error:", e);
    return false;
  }
}

export async function runEscalationDeliveryTick(): Promise<void> {
  let pending;
  try {
    pending = await getPendingEscalations();
  } catch (e) {
    console.error("[escalation] poll failed:", e);
    return;
  }
  if (pending.length === 0) return;

  const blueId = process.env["ESCALATION_DISCORD_USER_ID"];
  const fallbackChannel = process.env["ESCALATION_FALLBACK_CHANNEL_ID"] || process.env["VIBECHECK_CHANNEL_ID"];

  for (const esc of pending) {
    const token = tokenFor(esc.companion_id);
    if (!token) {
      console.error("[escalation] NO bot token available; escalation stays undelivered:", esc.rule);
      continue;
    }
    const text = composeEscalation(esc.companion_id, esc.rule, esc.detail, esc.detected_at);

    if (blueId && await sendDm(token, blueId, text)) {
      await ackEscalationDelivered(esc.id, "discord-dm").catch(e => console.error("[escalation] ack failed (will re-deliver next tick):", e));
      console.log(`[escalation] ${esc.rule} delivered to Blue by DM (voice: ${esc.companion_id})`);
      continue;
    }
    if (!blueId) console.warn("[escalation] ESCALATION_DISCORD_USER_ID unset -- falling back to channel");

    if (fallbackChannel && await sendChannel(token, fallbackChannel, `@here ESCALATION (no DM route to Blue):\n${text}`)) {
      await ackEscalationDelivered(esc.id, "home-channel-fallback").catch(e => console.error("[escalation] ack failed (will re-deliver next tick):", e));
      console.log(`[escalation] ${esc.rule} delivered via fallback channel (voice: ${esc.companion_id})`);
      continue;
    }

    console.error(`[escalation] ${esc.rule} UNDELIVERED (no route worked); retrying next tick`);
    // The row is the durable record of the failure -- pm2 logs rotate, attempt_count does not.
    const err = !blueId && !fallbackChannel ? "no route configured (ESCALATION_DISCORD_USER_ID + fallback channel both unset)" : "all routes failed (see worker log)";
    await recordEscalationAttempt(esc.id, err).catch(() => { /* bookkeeping must not block the retry loop */ });
  }
}
