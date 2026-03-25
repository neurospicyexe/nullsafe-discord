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

// Addressing model for incoming messages.
export type AddressType =
  | { type: "named"; id: CompanionId }
  | { type: "group" }
  | { type: "ambient" };

// Group-call keywords: any of these trigger all companions to respond.
const GROUP_PATTERN = /\b(triad|all of you|you all|you three|everyone)\b/;

// Parse who (if anyone) is being addressed in a message.
export function extractAddress(content: string): AddressType {
  const lower = content.toLowerCase();
  if (GROUP_PATTERN.test(lower)) return { type: "group" };
  if (/\bcypher\b/.test(lower)) return { type: "named", id: "cypher" };
  if (/\bdrevan\b/.test(lower)) return { type: "named", id: "drevan" };
  if (/\bgaia\b/.test(lower)) return { type: "named", id: "gaia" };
  return { type: "ambient" };
}

export function shouldRespond(
  channelId: string,
  content: string,
  sender: ResponderContext,
  myId: CompanionId,
  config: ChannelConfig,
  interestKeywords: string[] = [],
): boolean {
  const entry: ChannelEntry | undefined = config[channelId];
  const companions = entry?.companions ?? ALL_COMPANIONS;
  const modes = (entry?.modes ?? ["open"]) as ChannelMode[];

  // Companion filter: if a list is specified, only those companions respond here.
  if (!companions.includes(myId)) return false;

  // Companion-to-companion: only in channels with inter_companion mode.
  // Chain depth limit is enforced in the bot handler, not here.
  if (sender.isCompanionBot) return modes.includes("inter_companion");

  // From here: message is from Raziel or another human.
  const address = extractAddress(content);

  // Named: only the addressed companion responds.
  if (address.type === "named") return address.id === myId;

  // Group call ("triad" etc.): all companions in this channel respond.
  if (address.type === "group") return true;

  // Ambient (no explicit address): interest-keyword claiming in raziel_only channels.
  // open/autonomous channels respond unconditionally.
  if (modes.includes("raziel_only")) {
    if (interestKeywords.length === 0) return true;
    const lower = content.toLowerCase();
    return interestKeywords.some(kw => lower.includes(kw));
  }

  return modes.includes("open") || modes.includes("autonomous");
}

export class ChannelConfigCache {
  private config: ChannelConfig = {};
  private lastFetch = 0;
  private readonly ttlMs = 10 * 60 * 1000;
  private defaultConfig: ChannelConfig;

  constructor(
    private configUrl: string | undefined,
    defaultConfig: ChannelConfig = {},
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.defaultConfig = defaultConfig;
    // No URL: seed with default immediately, skip all fetching.
    if (!configUrl) {
      this.config = defaultConfig;
      this.lastFetch = Date.now();
    }
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
    if (!this.configUrl) return;
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
