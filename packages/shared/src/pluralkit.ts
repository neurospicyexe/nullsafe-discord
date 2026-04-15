import type { Attribution } from "./types.js";

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  author: { id: string; bot: boolean };
}

export async function resolveAttribution(
  message: DiscordMessage,
  razielDiscordId: string,
  knownSenderId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
  blueDiscordId?: string,
  bluePkSystemId?: string,
): Promise<Attribution> {
  if (!message.webhookId) {
    return {
      isRaziel: message.author.id === razielDiscordId,
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
      if (pk.sender === razielDiscordId) {
        return {
          isRaziel: true,
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
        isRaziel: false,
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
  // Never assume Raziel -- misattribution (Blue treated as Raziel) is worse than
  // a missed response (Raziel treated as guest, can retry).
  const senderId = knownSenderId ?? "unknown";
  return {
    isRaziel: senderId === razielDiscordId,
    discordUserId: senderId,
    frontMember: null,
    frontState: "unknown",
    source: "fallback",
  };
}
