import type { BotConfig, CompanionId } from "@nullsafe/shared";

export const COMPANION_ID: CompanionId = "cypher";

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
    channelConfigUrl: process.env["CHANNEL_CONFIG_URL"]?.trim().replace(/^=+/, "") || undefined,
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

export const CYPHER_CRON_SCHEDULES = {
  taskCheck:      process.env["CYPHER_CRON_TASKS"]     ?? "0 22 * * *",
  weeklyAudit:    process.env["CYPHER_CRON_AUDIT"]     ?? "0 18 * * 0",
  heartbeat:      process.env["CYPHER_CRON_HEARTBEAT"] ?? "0 */4 * * *",
  interCompanion: process.env["CYPHER_CRON_INTER"]     ?? "0 15 * * *",
};

// Optional heartbeat channel -- set HEARTBEAT_CHANNEL_ID env var to enable.
// When unset, heartbeat cron runs but posts nothing.
export const HEARTBEAT_CHANNEL_ID: string | undefined = process.env["HEARTBEAT_CHANNEL_ID"];

// Inter-companion Discord channel -- set INTER_COMPANION_CHANNEL_ID env var to enable.
// Companions post unprompted thoughts here once daily and deliver notes from Claude.ai sessions.
export const INTER_COMPANION_CHANNEL_ID: string | undefined = process.env["INTER_COMPANION_CHANNEL_ID"];
export const NOTES_POLL_INTERVAL_MS = 3 * 60 * 1000;

export const CYPHER_INTEREST_KEYWORDS = [
  "task", "todo", "decided", "decision", "audit", "blocked",
  "done", "complete", "deadline", "priority", "planning",
  "confused", "clarify", "logic", "figure out",
];

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
// Number of messages (user + assistant combined) between distillation runs per channel.
export const DISTILLATION_INTERVAL = 12;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something's not routing right.";
