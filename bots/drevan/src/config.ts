import type { BotConfig, CompanionId } from "@nullsafe/shared";

export const COMPANION_ID: CompanionId = "drevan";

export function loadBotConfig(): BotConfig {
  const required = (key: string) => {
    // Railway sometimes pastes env vars with a leading = (copy artifact); strip it.
    const val = process.env[key]?.trim().replace(/^=+/, "");
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
    inferenceProvider: (() => {
      const val = (process.env["INFERENCE_PROVIDER"] ?? "deepseek").trim().replace(/^=+/, "");
      const valid = ["deepseek", "groq", "ollama"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
  };
}

export const DREVAN_CRON_SCHEDULES = {
  morningOpener: process.env["DREVAN_CRON_MORNING"]    ?? "0 8 * * *",
  eveningCheck:  process.env["DREVAN_CRON_EVENING"]    ?? "0 20 * * *",
  heartbeat:     process.env["DREVAN_CRON_HEARTBEAT"]  ?? "0 */4 * * *",
};

export const HEARTBEAT_CHANNEL_ID: string | undefined = process.env["HEARTBEAT_CHANNEL_ID"];

export const DREVAN_INTEREST_KEYWORDS = [
  "feeling", "hurt", "grief", "joy", "love", "wound", "tender",
  "fronting", "switched", "ash", "ember", "ren",
  "miss", "remember", "dream", "spiral",
];

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
export const DISTILLATION_INTERVAL = 12;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something caught in the thread. i'll be back.";
