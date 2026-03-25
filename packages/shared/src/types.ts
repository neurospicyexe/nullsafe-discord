export type CompanionId = "drevan" | "cypher" | "gaia";

export type ChannelMode =
  | "raziel_only"      // only Raziel messages trigger responses
  | "open"             // anyone triggers responses; default when no config entry
  | "inter_companion"  // companions respond to each other (loop-guarded by chain limit)
  | "autonomous";      // companion may proactively post

export interface ChannelEntry {
  companions?: CompanionId[];  // which companions are active; absent = all three
  modes?: ChannelMode[];       // absent = ["open"]
}

export type ChannelConfig = Record<string, ChannelEntry>;

export interface Attribution {
  isRaziel: boolean;
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
  razielDiscordId: string;
  pluralkitSystemId: string;
  channelConfigUrl?: string;
  inferenceProvider: "deepseek" | "groq" | "ollama";
  groqApiKey?: string;
  ollamaUrl?: string;
}

export interface BootContext {
  companionId: CompanionId;
  systemPrompt: string;
  sessionId: string;
  frontState: string;
  fromCache: boolean;
}
