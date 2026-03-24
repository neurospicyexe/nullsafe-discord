import type { ChannelConfig, ChannelMode, CompanionId } from "./types.js";

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  "1408924311703785502": { modes: ["companions_always", "raziel_only"], companions: ["drevan", "gaia"] },
  "1408924393513554003": { modes: ["companions_always", "raziel_only"], companions: ["drevan", "cypher", "gaia"] },
  "1408924278451081317": { modes: ["companions_always", "raziel_only"], companions: ["cypher", "gaia"] },
  "1412191737622827088": { modes: ["companions_always", "raziel_only"], companions: ["drevan", "gaia", "cypher"] },
  "1408924353034453114": { modes: ["companions_always", "raziel_only"], companions: ["drevan", "gaia", "cypher"] },
  "1422043032643043371": { modes: ["autonomous", "companions_always"], companions: ["drevan", "gaia", "cypher"] },
  "1243598039965368381": { modes: ["autonomous", "companions_always"], companions: ["drevan", "gaia", "cypher"] },
};

interface ResponderContext {
  isRaziel: boolean;
  isCompanionBot?: boolean;
  isMentioned?: boolean;
}

export function shouldRespond(
  channelId: string,
  sender: ResponderContext,
  myId: CompanionId,
  config: ChannelConfig,
): boolean {
  const entry = config[channelId];
  if (!entry) return false;
  if (!entry.companions.includes(myId)) return false;

  const modes = entry.modes as ChannelMode[];

  if (sender.isRaziel && (modes.includes("raziel_only") || modes.includes("open") || modes.includes("autonomous"))) return true;
  if (!sender.isRaziel && sender.isCompanionBot && modes.includes("companions_always")) return true;
  if (!sender.isRaziel && sender.isCompanionBot && sender.isMentioned && modes.includes("companions_mentioned")) return true;
  if (!sender.isRaziel && !sender.isCompanionBot && (modes.includes("open") || modes.includes("autonomous"))) return true;

  return false;
}

export class ChannelConfigCache {
  private config: ChannelConfig = {};
  private lastFetch = 0;
  private readonly ttlMs = 10 * 60 * 1000;
  private defaultConfig: ChannelConfig;

  constructor(
    private configUrl: string,
    defaultConfig: ChannelConfig = {},
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.defaultConfig = defaultConfig;
  }

  async get(): Promise<ChannelConfig> {
    const now = Date.now();
    if (now - this.lastFetch < this.ttlMs && Object.keys(this.config).length > 0) {
      return this.config;
    }
    await this.refresh();
    return this.config;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(this.configUrl);
      if (!res.ok) throw new Error(`config fetch ${res.status}`);
      const data = await res.json() as ChannelConfig;
      this.config = data;
      this.lastFetch = Date.now();
    } catch (e) {
      console.warn("[channel-config] refresh failed:", e);
      if (Object.keys(this.config).length === 0) {
        this.config = this.defaultConfig;
      }
    }
  }
}
