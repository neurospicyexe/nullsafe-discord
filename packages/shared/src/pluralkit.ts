import type { Message } from "discord.js";
import type { Attribution } from "./types.js";

// PluralKit's Discord application ID -- stable, not subject to change.
// When PluralKit proxies a message via webhook, message.applicationId equals this value.
const PLURALKIT_APP_ID = "466378653216014359";

export interface PKContext {
  isPluralKit: boolean;
  memberName: string | null; // display name of the fronting system member
}

export function detectPluralKit(message: Message): PKContext {
  if (!message.webhookId) {
    return { isPluralKit: false, memberName: null };
  }
  // discord.js v14 Message.applicationId is set to the application that created the webhook.
  // PluralKit sets this to its own application ID on every proxied message.
  const isPluralKit = message.applicationId === PLURALKIT_APP_ID;
  return {
    isPluralKit,
    memberName: isPluralKit ? (message.author?.username ?? null) : null,
  };
}

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  author: { id: string; bot: boolean };
}

export async function resolveAttribution(
  message: DiscordMessage,
  ownerDiscordId: string,
  knownSenderId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
  blueDiscordId?: string,
  bluePkSystemId?: string,
): Promise<Attribution> {
  if (!message.webhookId) {
    return {
      isOwner: message.author.id === ownerDiscordId,
      discordUserId: message.author.id,
      frontMember: null,
      frontState: "unknown",
      source: "direct",
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetchFn(
      `https://api.pluralkit.me/v2/messages/${message.id}`,
      { signal: controller.signal },
    ).finally(() => clearTimeout(timeout));

    if (res.ok) {
      const pk = await res.json() as { sender: string; member?: { name: string }; system?: { id: string } };
      if (pk.sender === ownerDiscordId) {
        return {
          isOwner: true,
          discordUserId: pk.sender,
          frontMember: pk.member?.name ?? null,
          frontState: "known",
          source: "pluralkit",
        };
      }
      // Blue's system: match by Discord ID or PK system ID (belt-and-suspenders).
      const isBlue = (blueDiscordId && pk.sender === blueDiscordId)
        || (bluePkSystemId && pk.system?.id === bluePkSystemId);
      return {
        isOwner: false,
        discordUserId: isBlue ? (blueDiscordId ?? pk.sender) : pk.sender,
        frontMember: pk.member?.name ?? null,
        frontState: "known",
        source: "pluralkit",
      };
    }
  } catch {
    // timeout or network error -- fall through
  }

  // Fallback: use dedup-captured sender if available; otherwise truly unknown.
  // Never assume owner -- misattribution (Blue treated as owner) is worse than
  // a missed response (owner treated as guest, can retry).
  const senderId = knownSenderId ?? "unknown";
  return {
    isOwner: senderId === ownerDiscordId,
    discordUserId: senderId,
    frontMember: null,
    frontState: "unknown",
    source: "fallback",
  };
}
