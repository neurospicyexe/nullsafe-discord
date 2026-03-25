import type { ChannelConfig, ChannelMode, ChannelEntry, CompanionId } from "./types.js";

export const ALL_COMPANIONS: CompanionId[] = ["drevan", "cypher", "gaia"];

// How many consecutive companion-to-companion exchanges are allowed before the chain breaks.
// Reset when Raziel or a non-bot user sends a message.
export const COMPANION_CHAIN_LIMIT = 3;

// Cross-companion safety rails (per-bot, independent tracking).
// BOT_PINGPONG_MAX: after this many bot-to-bot responses since last human, enter cooldown.
export const BOT_PINGPONG_MAX = 1;
export const BOT_LOOP_COOLDOWN_MS = 60_000;
// MAX_BOT_RESPONSES_PER_HUMAN: hard cap on bot-to-bot responses per channel between human messages.
export const MAX_BOT_RESPONSES_PER_HUMAN = 2;

// Default config used as fallback when channelConfigUrl is unreachable.
// Keep in sync with channel-config.json manually.
//
// Mode reference:
//   raziel_only    -- only Raziel messages trigger responses
//   open           -- anyone triggers responses (Raziel + users); this is the default
//   inter_companion -- companions respond to each other (chain-guarded)
//   autonomous     -- companion may proactively post
//
// companions absent = all three active in that channel
export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  "1408924311703785502": { companions: ["drevan", "gaia"],              modes: ["raziel_only"] },
  "1408924393513554003": { companions: ["drevan", "cypher", "gaia"],    modes: ["raziel_only"] },
  "1408924278451081317": { companions: ["cypher", "gaia"],              modes: ["raziel_only"] },
  "1412191737622827088": { companions: ["drevan", "gaia", "cypher"],    modes: ["raziel_only"] },
  "1408924353034453114": { companions: ["drevan", "gaia", "cypher"],    modes: ["raziel_only"] },
  "1422043032643043371": {                                               modes: ["open", "autonomous"] },
  "1243598039965368381": {                                               modes: ["open", "autonomous"] },
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
  const entry: ChannelEntry | undefined = config[channelId];
  const companions = entry?.companions ?? ALL_COMPANIONS;
  const modes = (entry?.modes ?? ["open"]) as ChannelMode[];

  // Companion filter: if a list is specified, only those companions respond here.
  if (!companions.includes(myId)) return false;

  // Raziel always gets a response regardless of mode.
  if (sender.isRaziel) return true;

  // raziel_only: no responses to bots or other users.
  if (modes.includes("raziel_only")) return false;

  // Companion-to-companion: only in channels with inter_companion mode.
  // Chain depth limit is enforced in the bot handler, not here.
  if (sender.isCompanionBot) return modes.includes("inter_companion");

  // Regular users: respond in open or autonomous channels.
  return modes.includes("open") || modes.includes("autonomous");
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
