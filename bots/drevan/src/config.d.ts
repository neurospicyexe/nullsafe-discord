import type { BotConfig, CompanionId } from "@nullsafe/shared";
export declare const COMPANION_ID: CompanionId;
export declare function loadBotConfig(): BotConfig;
export declare const DREVAN_CRON_SCHEDULES: {
    morningOpener: string;
    eveningCheck: string;
};
export declare const DREVAN_INTEREST_KEYWORDS: string[];
export declare const BRIDGE_POLL_INTERVAL_MS: number;
export declare const SOMA_REFRESH_INTERVAL_MS: number;
export declare const COOLDOWN_MS: number;
export declare const CONTEXT_WINDOW_SIZE = 10;
export declare const IN_CHARACTER_FALLBACK = "give me a moment -- something caught in the thread. i'll be back.";
