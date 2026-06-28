import type { InferenceProvider } from "./models.js";
export type { InferenceProvider };

export type CompanionId = "drevan" | "cypher" | "gaia";

export type UserTier = "owner" | "intimate" | "guest";

export type ChannelMode =
  | "owner_only"       // only owner messages trigger responses
  | "open"             // anyone triggers responses; default when no config entry
  | "inter_companion"  // companions respond to each other (loop-guarded by chain limit)
  | "autonomous"       // companion may proactively post
  | "broadcast";       // bots post here (digests/letters) but never respond

export interface ChannelEntry {
  companions?: CompanionId[];  // which companions are active; absent = all three
  modes?: ChannelMode[];       // absent = ["open"]
  voice?: boolean;             // enable voice note processing in this channel
}

export type ChannelConfig = Record<string, ChannelEntry>;

export interface Attribution {
  isOwner: boolean;
  discordUserId: string;
  frontMember: string | null;
  frontState: "known" | "unknown";
  source: "direct" | "pluralkit" | "fallback";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  authorName?: string;
}

export interface BotConfig {
  companionId: CompanionId;
  discordBotToken: string;
  halsethUrl: string;
  halsethSecret: string;
  deepseekApiKey: string;
  ownerDiscordId: string;
  /** Display name for the owner in author labels and PluralKit fallbacks.
   * Defaults to "Raziel" when OWNER_DISPLAY_NAME env var is unset (preserves
   * pre-C.5 behavior). Set OWNER_DISPLAY_NAME=Crash on the VPS to use Crash. */
  ownerDisplayName: string;
  pluralkitSystemId: string;
  channelConfigUrl?: string;
  inferenceProvider: InferenceProvider;
  groqApiKey?: string;
  ollamaUrl?: string;
  lmstudioUrl?: string;
  kimiApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  mistralApiKey?: string;
  inferenceModel?: string;   // default model key on cold boot (e.g. "deepseek-chat")
  disabledModels?: string;   // comma-separated model keys to disable
  blueDiscordId?: string;
  /** When set, bot relays inference to Phoenix Brain instead of calling DeepSeek directly. */
  brainUrl?: string;
  /** "brain" = relay to Phoenix Brain; "hermes" = relay to the local Hermes agent API server; "direct" (default) = bot handles inference. */
  inferenceMode?: "direct" | "brain" | "hermes";
  /** Base URL of this companion's local Hermes API server, e.g. http://127.0.0.1:8642/v1 (INFERENCE_MODE=hermes). */
  hermesUrl?: string;
  /** Bearer token (API_SERVER_KEY) for the local Hermes API server. */
  hermesApiKey?: string;
}

export interface BootContext {
  companionId: CompanionId;
  systemPrompt: string;
  sessionId: string;
  frontState: string;
  fromCache: boolean;
}
