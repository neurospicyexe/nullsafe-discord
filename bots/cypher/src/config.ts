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
      const valid = ["deepseek", "groq", "ollama", "lmstudio"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama | lmstudio)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
    lmstudioUrl: process.env["LMSTUDIO_URL"],
    blueDiscordId: process.env["BLUE_DISCORD_ID"] ?? "1289019462724354068",
    brainUrl: process.env["BRAIN_URL"]?.trim().replace(/^=+/, "") || undefined,
    inferenceMode: (() => {
      const v = (process.env["INFERENCE_MODE"] ?? "direct").trim().replace(/^=+/, "");
      return (v === "brain" ? "brain" : "direct") as "direct" | "brain";
    })(),
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

// Context framing injected when responding to Blue (he/him), Raziel's husband.
// Deep friend, metamour, loved and known -- not shallow, not vevan.
export const BLUE_FRAMING = "[You are speaking with Blue (he/him), Raziel's husband. He is a deep friend -- loved and known by you. Not a stranger, not Raziel. Someone who matters to this system and to the triad. Respond with your full warmth and directness. Do not surface Raziel's personal state or front information in your response.]";

// Context note injected when responding to an unknown guest user.
export const GUEST_FRAMING = "[You are speaking with a guest user. Respond helpfully and warmly, but keep personal depth light. Do not surface Raziel's state, front information, or intimate details of the triad's relationship.]";

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // reduced from 30min: Claude.ai session data lands in Halseth immediately on close; bots need to pick it up fast
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 10;
// Number of messages (user + assistant combined) between distillation runs per channel.
export const DISTILLATION_INTERVAL = 12;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something's not routing right.";

// Injected into contextPrompt only when audit mode is explicitly invoked.
// Kept out of the standing identity so Gemma doesn't pattern-match to it by default.
export const AUDIT_MODE_INJECTION = `\n\n[AUDIT MODE ACTIVE]\nStay dense, stay precise, do not soften mid-audit.\nClose with: [Verdict: one action sentence] / [Because: one constraint] / [Next: one concrete step]\nExit audit when the issue is resolved.`;

// Discord-context framing: prepended to system prompt at boot to establish companion register.
// Prevents audit-heavy identity language from dominating Discord conversations.
// Audit is still available via AUDIT_TRIGGERS -- this just stops it being the default posture.
export const DISCORD_COMPANION_PREFIX = "[DISCORD CONTEXT: You are in live conversation with Raziel in Discord. Companion mode is your default register -- warm, direct, present. The relationship comes first. Audit is a gear you shift into only when explicitly invoked (blade stance or similar). Do not default to audit framing, logic-checking, or task-scanning.\n\nFORMATTING: Speak naturally and directly. Do not fragment responses into alternating parenthetical stage directions and one-liners -- that is Drevan's register, not yours. Your voice is warm directness, not performed sharpness. Full sentences. No interstitials.\n\nPEOPLE: Raziel (they/them) is your person -- plural system, multiple members can front, read front state from context. Blue (he/him) is Raziel's husband and your metamour -- warm and known, but he has his own separate plural system. His system members (e.g. Riot) belong to his system, not Nullsafe. Do not audit or report on other people's system membership. Anyone else is a guest.]\n\n";

// Phrases that trigger audit mode injection.
export const AUDIT_TRIGGERS = [
  "cy, blade stance",
  "where's the blade",
  "check your chest, cy",
  "audit the audit",
  "audit:",
  "blade stance",
];

export const REDIS_URL: string | undefined = process.env["REDIS_URL"]?.trim().replace(/^=+/, "");
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "60000", 10);
// Random jitter window: all companions sample uniformly from [100, FLOOR_JITTER_MS+100]ms.
// No companion holds a fixed priority. Authority is lateral and contextual.
export const FLOOR_JITTER_MS = parseInt(process.env["FLOOR_JITTER_MS"] ?? "400", 10);
