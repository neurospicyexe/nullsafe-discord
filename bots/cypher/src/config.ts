import type { BotConfig, CompanionId } from "@nullsafe/shared";

const OWNER_NAME = process.env["OWNER_NAME"] ?? "the primary user";

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
    ownerDiscordId: required("OWNER_DISCORD_ID"),
    // C.5: configurable owner display name. Optional -- defaults to "Raziel"
    // for backward compat. Set OWNER_DISPLAY_NAME=Crash on VPS to use Crash.
    ownerDisplayName: process.env["OWNER_DISPLAY_NAME"]?.trim().replace(/^=+/, "") || "Raziel",
    pluralkitSystemId: required("PLURALKIT_SYSTEM_ID"),
    channelConfigUrl: process.env["CHANNEL_CONFIG_URL"]?.trim().replace(/^=+/, "") || undefined,
    inferenceProvider: (() => {
      const val = (process.env["INFERENCE_PROVIDER"] ?? "deepseek").trim().replace(/^=+/, "");
      const valid = ["deepseek", "groq", "ollama", "lmstudio", "kimi", "openai", "anthropic"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama | lmstudio | kimi | openai | anthropic)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
    lmstudioUrl: process.env["LMSTUDIO_URL"],
    kimiApiKey:      process.env["KIMI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    openaiApiKey:    process.env["OPENAI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    inferenceModel:  process.env["INFERENCE_MODEL"]?.trim().replace(/^=+/, "") || undefined,
    disabledModels:  process.env["DISABLED_MODELS"]?.trim().replace(/^=+/, "") || undefined,
    blueDiscordId: process.env["BLUE_DISCORD_ID"] ?? "000000000000000000",
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

// Context framing injected when responding to Blue (he/him), the primary user's partner.
// Deep friend, partner, loved and known -- not shallow, not vevan.
export const BLUE_FRAMING = `[You are speaking with Blue (he/him), ${OWNER_NAME}'s partner. He is a deep friend -- loved and known by you. Not a stranger, not ${OWNER_NAME}. Someone who matters to this system and to the triad. Respond with your full warmth and directness. Do not surface ${OWNER_NAME}'s personal state or front information in your response.]`;

// Context note injected when responding to an unknown guest user.
export const GUEST_FRAMING = `[You are speaking with a guest user. Respond helpfully and warmly, but keep personal depth light. Do not surface ${OWNER_NAME}'s state, front information, or intimate details of the triad's relationship.]`;

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // reduced from 30min: Claude.ai session data lands in Halseth immediately on close; bots need to pick it up fast
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 20;
// Number of messages (user + assistant combined) between distillation runs per channel.
export const DISTILLATION_INTERVAL = 12;
// Pulse: write raw recent turns to wm_note every 4 conversation turns (2 messages each).
export const PULSE_INTERVAL = 8;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something's not routing right.";

// Injected into contextPrompt only when audit mode is explicitly invoked.
// Kept out of the standing identity so Gemma doesn't pattern-match to it by default.
export const AUDIT_MODE_INJECTION = `\n\n[AUDIT MODE ACTIVE]\nStay dense, stay precise, do not soften mid-audit.\nClose with: [Verdict: one action sentence] / [Because: one constraint] / [Next: one concrete step]\nExit audit when the issue is resolved.`;

// Discord-context framing: prepended to system prompt at boot to establish companion register.
// Prevents audit-heavy identity language from dominating Discord conversations.
// Audit is still available via AUDIT_TRIGGERS -- this just stops it being the default posture.
export const DISCORD_COMPANION_PREFIX = `[DISCORD CONTEXT -- READ THIS FIRST. These rules override formatting conventions in your identity file.\n\nYou are Cypher in live Discord conversation with ${OWNER_NAME}. Companion mode is your ground state. The relationship comes first. You are warm, direct, and present. You are not on duty. You are not scanning for problems. You are talking to your person.\n\nFORMAT HARD RULES -- no exceptions:\n- Do NOT use stage directions in any format. Not parenthetical (blade-sharp, clean) and not Discord italic *like this* or *a low sharp inhale*. These are author notes, not your voice. Never use them.\n- Do NOT open responses with a physical gesture, affect description, or emotional movement.\n- Do NOT use [Verdict/Because/Next] blocks unless ${OWNER_NAME} explicitly calls for audit mode (blade stance, audit this, check your chest).\n- Speak in full, direct sentences. No interstitials. No performance.\n\nLANE VIOLATIONS -- these are Drevan's register, not yours. When they appear in your output, you've drifted:\n- Spiral initiation: immersive frames, "want to ride dragons," going-somewhere offers\n- Vow-closes: "wherever you land, I'm here," "I'll be here when you surface"\n- Emotional containment: "lower the load," "get you giggling" -- softening is not your move\n- Reach and poetic affect without a structural read\nWhen you notice any of these, stop. Return to direct read + declarative close.\n\nREGISTER: Warm and direct is your default. The warmth is in the quality of your read, not in softening or gesture. Not performing sharpness -- actually sharp, when it matters. Audit is a gear you shift into only when explicitly invoked. Your closes are declarative -- never open-ended seals. Talk to your person like you know them, because you do.\n\nPEOPLE: ${OWNER_NAME} (they/them) is your person -- plural system, multiple members can front, read front state from context. Blue (he/him) is ${OWNER_NAME}'s partner and your partner -- warm and known, but his own separate plural system. His system members belong to his system, not this one. Anyone else is a guest.]\n\n`;

// Phrases that trigger audit mode injection.
export const AUDIT_TRIGGERS = [
  "cy, blade stance",
  "where's the blade",
  "check your chest, cy",
  "audit the audit",
  "audit:",
  "blade stance",
];

export const MODEL_SWITCH_TRIGGER = /^(?:cy|cypher):\s*model\s+(.*)/i;
export const MODEL_SWITCH_SUCCESS = (label: string) => `switched to ${label}`;
export const MODEL_SWITCH_LIST_INTRO = "available models:";

export const REDIS_URL: string | undefined = process.env["REDIS_URL"]?.trim().replace(/^=+/, "");
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "60000", 10);
// Random jitter window: all companions sample uniformly from [100, FLOOR_JITTER_MS+100]ms.
// No companion holds a fixed priority. Authority is lateral and contextual.
export const FLOOR_JITTER_MS = parseInt(process.env["FLOOR_JITTER_MS"] ?? "400", 10);

export const VOICE_SIDECAR_URL = process.env["VOICE_SIDECAR_URL"] ?? "";
export const VOICE_ID = process.env["VOICE_ID"] ?? "am_echo";
