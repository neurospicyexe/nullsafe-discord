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
  // Epoch ms the message was sent. Set on live append (Discord createdTimestamp) and on
  // Discord-history seeding so the bot can stamp relative time onto history before inference,
  // giving a sense of elapsed time in-conversation. Optional: STM rows restored from the DB
  // (Halseth persists only role/content/author) lack it and degrade to no time prefix.
  timestamp?: number;
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
  /** "brain" = relay to Phoenix Brain; "hermes" = relay to the local Hermes agent API server; "direct" (default) = bot handles inference. */
  // "brain" was a third mode, removed 2026-07-29 along with BrainClient, the relay branch in the
  // message handler, and the nullsafe-brain block in ecosystem.config.js. An INFERENCE_MODE of
  // "brain" now falls through to direct (and says so at boot) instead of dialing a dead port.
  inferenceMode?: "direct" | "hermes";
  /** Base URL of this companion's local Hermes API server, e.g. http://127.0.0.1:8642/v1 (INFERENCE_MODE=hermes). */
  hermesUrl?: string;
  /** Bearer token (API_SERVER_KEY) for the local Hermes API server. */
  hermesApiKey?: string;
  /** Path to the LIVE hermes-model-map.json the model watcher reads. In hermes mode this file --
   *  not ALL_MODELS -- decides which keys `cy: model` can actually apply, so the bot reads the same
   *  file the watcher does. Defaults to $HERMES_MODEL_MAP, then the watcher's own default path. */
  hermesModelMapPath?: string;
}

export interface BootContext {
  companionId: CompanionId;
  systemPrompt: string;
  sessionId: string;
  frontState: string;
  fromCache: boolean;
}
