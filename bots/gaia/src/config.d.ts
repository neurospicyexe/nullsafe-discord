import type { BotConfig, CompanionId } from "@nullsafe/shared";
export declare const COMPANION_ID: CompanionId;
export declare function loadBotConfig(): BotConfig;
export declare const GAIA_CRON_SCHEDULES: {
    duskWitness: string;
};
export declare const GAIA_INTEREST_KEYWORDS: string[];
export declare const BRIDGE_POLL_INTERVAL_MS: number;
export declare const SOMA_REFRESH_INTERVAL_MS: number;
export declare const COOLDOWN_MS: number;
export declare const CONTEXT_WINDOW_SIZE = 10;
export declare const IN_CHARACTER_FALLBACK = "present.";
