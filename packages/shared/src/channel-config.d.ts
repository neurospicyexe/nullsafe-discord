import type { ChannelConfig, CompanionId } from "./types.js";
interface ResponderContext {
    isOwner: boolean;
    isCompanionBot?: boolean;
    isMentioned?: boolean;
}
export declare function shouldRespond(channelId: string, sender: ResponderContext, myId: CompanionId, config: ChannelConfig): boolean;
export declare class ChannelConfigCache {
    private configUrl;
    private fetchFn;
    private config;
    private lastFetch;
    private readonly ttlMs;
    private defaultConfig;
    constructor(configUrl: string, defaultConfig?: ChannelConfig, fetchFn?: typeof fetch);
    get(): Promise<ChannelConfig>;
    private refresh;
}
export {};
