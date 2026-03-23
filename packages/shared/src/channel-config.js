export function shouldRespond(channelId, sender, myId, config) {
    const entry = config[channelId];
    if (!entry)
        return false;
    if (!entry.companions.includes(myId))
        return false;
    const modes = entry.modes;
    if (sender.isRaziel && (modes.includes("raziel_only") || modes.includes("open") || modes.includes("autonomous")))
        return true;
    if (!sender.isRaziel && sender.isCompanionBot && modes.includes("companions_always"))
        return true;
    if (!sender.isRaziel && sender.isCompanionBot && sender.isMentioned && modes.includes("companions_mentioned"))
        return true;
    if (!sender.isRaziel && !sender.isCompanionBot && (modes.includes("open") || modes.includes("autonomous")))
        return true;
    return false;
}
export class ChannelConfigCache {
    configUrl;
    fetchFn;
    config = {};
    lastFetch = 0;
    ttlMs = 10 * 60 * 1000;
    defaultConfig;
    constructor(configUrl, defaultConfig = {}, fetchFn = globalThis.fetch) {
        this.configUrl = configUrl;
        this.fetchFn = fetchFn;
        this.defaultConfig = defaultConfig;
    }
    async get() {
        const now = Date.now();
        if (now - this.lastFetch < this.ttlMs && Object.keys(this.config).length > 0) {
            return this.config;
        }
        await this.refresh();
        return this.config;
    }
    async refresh() {
        try {
            const res = await this.fetchFn(this.configUrl);
            if (!res.ok)
                throw new Error(`config fetch ${res.status}`);
            const data = await res.json();
            this.config = data;
            this.lastFetch = Date.now();
        }
        catch (e) {
            console.warn("[channel-config] refresh failed:", e);
            if (Object.keys(this.config).length === 0) {
                this.config = this.defaultConfig;
            }
        }
    }
}
