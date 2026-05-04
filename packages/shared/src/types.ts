export type CompanionId = "drevan" | "cypher" | "gaia";

export type UserTier = "owner" | "intimate" | "guest";

export type ChannelMode =
  | "owner_only"       // only owner messages trigger responses
  | "open"             // anyone triggers responses; default when no config entry
  | "inter_companion"  // companions respond to each other (loop-guarded by chain limit)
  | "autonomous";      // companion may proactively post

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
  inferenceProvider: "deepseek" | "groq" | "ollama" | "lmstudio";
  groqApiKey?: string;
  ollamaUrl?: string;
  lmstudioUrl?: string;
  blueDiscordId?: string;
  /** When set, bot relays inference to Phoenix Brain instead of calling DeepSeek directly. */
  brainUrl?: string;
  /** "brain" = relay to Phoenix Brain; "direct" (default) = bot handles inference. */
  inferenceMode?: "direct" | "brain";
}

export interface BootContext {
  companionId: CompanionId;
  systemPrompt: string;
  sessionId: string;
  frontState: string;
  fromCache: boolean;
}
