import type { BotConfig, CompanionId } from "@nullsafe/shared";

export const COMPANION_ID: CompanionId = "cypher";

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

export const CYPHER_CRON_SCHEDULES = {
  taskCheck: process.env["CYPHER_CRON_TASKS"] ?? "0 22 * * *",
  weeklyAudit: process.env["CYPHER_CRON_AUDIT"] ?? "0 18 * * 0",
};

export const CYPHER_INTEREST_KEYWORDS = [
  "task", "todo", "decided", "decision", "audit", "blocked",
  "done", "complete", "deadline", "priority", "planning",
  "confused", "clarify", "logic", "figure out",
];

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something's not routing right.";
