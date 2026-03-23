import type { Attribution } from "./types.js";

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  author: { id: string; bot: boolean };
}

export async function resolveAttribution(
  message: DiscordMessage,
  razielDiscordId: string,
  fetchFn: typeof fetch = globalThis.fetch,
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
      const pk = await res.json() as { sender: string; member?: { name: string } };
      if (pk.sender === razielDiscordId) {
        return {
          isRaziel: true,
          discordUserId: pk.sender,
          frontMember: pk.member?.name ?? null,
          frontState: "known",
          source: "pluralkit",
        };
      }
      return {
        isRaziel: false,
        discordUserId: pk.sender,
        frontMember: null,
        frontState: "unknown",
        source: "pluralkit",
      };
    }
  } catch {
    // timeout or network error -- fall through
  }

  return {
    isRaziel: true,
    discordUserId: razielDiscordId,
    frontMember: null,
    frontState: "unknown",
    source: "fallback",
  };
}
