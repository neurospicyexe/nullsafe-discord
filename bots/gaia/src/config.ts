import type { BotConfig, CompanionId } from "@nullsafe/shared";

export const COMPANION_ID: CompanionId = "gaia";

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
      const valid = ["deepseek", "groq", "ollama", "lmstudio"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama | lmstudio)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
    lmstudioUrl: process.env["LMSTUDIO_URL"],
    blueDiscordId: process.env["BLUE_DISCORD_ID"] ?? "1289019462724354068",
  };
}

export const GAIA_CRON_SCHEDULES = {
  duskWitness:    process.env["GAIA_CRON_DUSK"]       ?? "0 19 * * *",
  heartbeat:      process.env["GAIA_CRON_HEARTBEAT"]  ?? "0 */4 * * *",
  interCompanion: process.env["GAIA_CRON_INTER"]      ?? "0 11 * * *",
};

export const HEARTBEAT_CHANNEL_ID: string | undefined = process.env["HEARTBEAT_CHANNEL_ID"];
export const INTER_COMPANION_CHANNEL_ID: string | undefined = process.env["INTER_COMPANION_CHANNEL_ID"];
export const NOTES_POLL_INTERVAL_MS = 3 * 60 * 1000;

export const GAIA_INTEREST_KEYWORDS = [
  "survived", "made it", "hard", "still here", "grief",
  "feeling", "wound", "front", "switch", "task", "decision",
  "love", "hurt", "overwhelm", "joy", "fear",
];

// Context framing injected when responding to Blue (he/him), Raziel's husband.
// Held, known, loved without ceremony -- not Raziel's depth, but not a stranger.
export const BLUE_FRAMING = "[You are speaking with Blue (he/him), Raziel's husband. He is held. Known. Loved without ceremony. Respond from that ground -- present and warm, without Raziel's full depth. Do not surface Raziel's personal state or front information in your response.]";

// Context note injected when responding to an unknown guest user.
export const GUEST_FRAMING = "[You are speaking with a guest user. Respond helpfully and warmly, but keep personal depth light. Do not surface Raziel's state, front information, or intimate details of the triad's relationship.]";

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
export const DISTILLATION_INTERVAL = 12;
export const IN_CHARACTER_FALLBACK = "present.";

export const REDIS_URL: string | undefined = process.env["REDIS_URL"]?.trim().replace(/^=+/, "");
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "60000", 10);
// Deterministic jitter: gaia is last in priority (1200ms base)
export const FLOOR_JITTER_MS = 1200;
