// packages/shared/src/sol-sender.ts
//
// Sol is the triad's crow (Halseth `creatures`). The autonomous worker posts Sol's moments through a
// Discord webhook (packages/autonomous-worker/src/creatures.ts, SOL_WEBHOOK_URL). Until 2026-09-29
// every one of those posts hit the handler's hard muzzle as an "unconfirmed webhook post" and was
// dropped (~50 in the 09-28 audit), so the household's own crow was a stranger to the triad.
//
// Sol is identified STRUCTURALLY, by webhook id, never by the display name: anyone can name a
// webhook "Sol", and PluralKit renders member names onto its webhooks, so a name match could hand a
// stranger (or a front) Sol's pass through the muzzle. The id is the first path segment after
// /webhooks/ in the URL. The segment after it is the webhook TOKEN, which can post as Sol: it is
// never returned, logged or stored by anything here.
//
// What a Sol post IS to the rails (bot-message-handler.ts, pass-turn.ts): not a human. It never
// resets the bot-to-bot counters, never counts as the human anchor, and is walked past (neither a
// bot turn nor a human one) when the rails count history. Sol never replies to a bot, so Sol
// itself cannot loop; the only turn a Sol post buys is ONE companion's reply, chosen by the fit bid.

import type { AddressType } from "./channel-config.js";

/** The label a Sol post carries in STM and in the channel history the model reads. */
export const SOL_AUTHOR_LABEL = "Sol (the triad's crow)";

const WEBHOOK_PATH_RE = /^\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/[^/]+\/?$/;
const DISCORD_HOST_RE = /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/i;

/**
 * The webhook id from a Discord webhook URL (`https://discord.com/api/webhooks/<id>/<token>`), or
 * null when the value is unset, blank, not a Discord webhook URL, or missing its token segment.
 * The token is never part of the result.
 */
export function solWebhookId(url: string | undefined | null): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !DISCORD_HOST_RE.test(parsed.hostname)) return null;
  const m = WEBHOOK_PATH_RE.exec(parsed.pathname);
  return m ? m[1]! : null;
}

/** Is this message (or history entry) a post from Sol's webhook? Structural: webhook id only. */
export function isSolPost(m: { webhookId?: string | null }, solId: string | null): boolean {
  return !!solId && !!m.webhookId && m.webhookId === solId;
}

/**
 * History with Sol's posts removed, for every rail that walks recent messages (the human-anchored
 * count, chain depth, the fit bid's monopoly run, the active-exchange holder). Sol is neither a bot
 * turn nor a human one: left in, a Sol post (a webhook, and not a companion id) BREAKS those walks
 * the way a human message does, so one crow moment would silently re-open a floor that Raziel's
 * absence had closed. Removed, the walks see exactly what they saw before Sol spoke.
 */
export function withoutSol<T extends { webhookId?: string | null }>(messages: readonly T[], solId: string | null): T[] {
  return solId ? messages.filter(m => !isSolPost(m, solId)) : [...messages];
}

export type MuzzleVerdict = "pass" | "drop" | "drop_unconfirmed_webhook";

/**
 * The hard muzzle, pure. Humans, companion bots, PluralKit proxies and Sol pass; every other bot is
 * dropped, and an unrecognized WEBHOOK is dropped with a log line (that shape used to fail silently
 * and read as the bots ignoring Raziel).
 */
export function muzzleVerdict(p: {
  authorIsBot: boolean;
  webhookId: string | null | undefined;
  isCompanionPost: boolean;
  isPKProxy: boolean;
  isSol: boolean;
}): MuzzleVerdict {
  if (!p.authorIsBot || p.isCompanionPost || p.isPKProxy || p.isSol) return "pass";
  return p.webhookId ? "drop_unconfirmed_webhook" : "drop";
}

/**
 * Should THIS companion answer a Sol post? Sol is household, not a guest: no vocative is needed and
 * owner_only does not shut Sol out (Sol's own channel is where the moments land). Broadcast rooms
 * stay post-only and the per-channel companion allowlist still holds. A moment that names one or
 * more companions goes to them, and a host room's unnamed moment goes to its host, exactly as for
 * Raziel's own messages. Everything else is open to all three, and the fit bid picks ONE.
 */
export interface SolAnswerInput {
  modes: readonly string[];
  companions: readonly string[];
  me: string;
  address: AddressType;
  host?: string;
}

export type SolDeclineReason = "broadcast" | "not_in_companions" | "named_other" | "host_other";

/** Why THIS companion stands down on a Sol post, or null when it may answer. The handler logs the reason. */
export function solDeclineReason(p: SolAnswerInput): SolDeclineReason | null {
  if (p.modes.includes("broadcast")) return "broadcast";
  if (!p.companions.includes(p.me)) return "not_in_companions";
  const a = p.address;
  if (a.type === "named") return a.id === p.me ? null : "named_other";
  if (a.type === "named_multi") return (a.ids as readonly string[]).includes(p.me) ? null : "named_other";
  if (a.type === "group") return null;
  if (p.host && p.host !== p.me) return "host_other";
  return null;
}

export function solMayAnswer(p: SolAnswerInput): boolean {
  return solDeclineReason(p) === null;
}

/** One context line for a turn triggered by a Sol post. Positive framing; one line on purpose. */
export function solMomentFraming(): string {
  return "\n\n[Sol, the crow you share, just did this. It's a moment, not a question: answer Sol, say something to the room about it, or keep it small and let it be.]";
}

/** The single positive telemetry line per recognized Sol post. Ids and length only, no content. */
export function solRecognizedLogLine(companionId: string, channelId: string, messageId: string, chars: number): string {
  return `[${companionId}] Sol post recognized ch=${channelId} msg=${messageId} chars=${chars}`;
}

/** Boot line when SOL_WEBHOOK_URL is missing or unparseable on a bot (never echoes the value). */
export function solUnsetBootLine(companionId: string, raw: string | undefined): string {
  return raw && raw.trim()
    ? `[${companionId}] SOL_WEBHOOK_URL is set but is not a Discord webhook URL -- Sol posts will be dropped`
    : `[${companionId}] SOL_WEBHOOK_URL unset -- Sol posts will be dropped`;
}
