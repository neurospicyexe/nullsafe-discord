export type CompanionId = "drevan" | "cypher" | "gaia";
export type ChannelMode = "owner_only" | "open" | "inter_companion" | "autonomous";
export interface ChannelEntry {
    modes: ChannelMode[];
    companions: CompanionId[];
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
    pluralkitSystemId: string;
    channelConfigUrl?: string;
    inferenceProvider: "deepseek" | "groq" | "ollama" | "lmstudio";
    groqApiKey?: string;
    ollamaUrl?: string;
    lmstudioUrl?: string;
    blueDiscordId?: string;
    brainUrl?: string;
    inferenceMode?: "direct" | "brain";
}
export interface BootContext {
    companionId: CompanionId;
    systemPrompt: string;
    sessionId: string;
    frontState: string;
    fromCache: boolean;
}
