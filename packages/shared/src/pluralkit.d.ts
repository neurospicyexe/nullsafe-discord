import type { Attribution } from "./types.js";
interface DiscordMessage {
    id: string;
    webhookId: string | null;
    author: {
        id: string;
        bot: boolean;
    };
}
export declare function resolveAttribution(message: DiscordMessage, ownerDiscordId: string, fetchFn?: typeof fetch): Promise<Attribution>;
export {};
