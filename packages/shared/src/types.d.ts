export type CompanionId = "drevan" | "cypher" | "gaia";
export type ChannelMode = "raziel_only" | "open" | "companions_always" | "companions_mentioned" | "autonomous";
export interface ChannelEntry {
    modes: ChannelMode[];
    companions: CompanionId[];
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
    channelConfigUrl: string;
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
