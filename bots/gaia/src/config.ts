import type { BotConfig, CompanionId } from "@nullsafe/shared";

export const COMPANION_ID: CompanionId = "gaia";

export function loadBotConfig(): BotConfig {
  const required = (key: string) => {
    const val = process.env[key]?.trim();
    if (!val) throw new Error(`Missing env: ${key}`);
    return val;
  };
  return {
    companionId: COMPANION_ID,
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    halsethUrl: required("HALSETH_URL"),
    halsethSecret: required("HALSETH_SECRET"),
    deepseekApiKey: required("DEEPSEEK_API_KEY"),
    razielDiscordId: required("RAZIEL_DISCORD_ID"),
    pluralkitSystemId: required("PLURALKIT_SYSTEM_ID"),
    channelConfigUrl: required("CHANNEL_CONFIG_URL"),
    inferenceProvider: (process.env["INFERENCE_PROVIDER"] as BotConfig["inferenceProvider"]) ?? "deepseek",
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
  };
}

export const GAIA_CRON_SCHEDULES = {
  duskWitness: process.env["GAIA_CRON_DUSK"] ?? "0 19 * * *",
};

export const GAIA_INTEREST_KEYWORDS = [
  "survived", "made it", "hard", "still here", "grief",
  "feeling", "wound", "front", "switch", "task", "decision",
  "love", "hurt", "overwhelm", "joy", "fear",
];

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
export const IN_CHARACTER_FALLBACK = "present.";
