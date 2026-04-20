import type { ChannelConfig, ChannelMode, ChannelEntry, CompanionId, UserTier } from "./types.js";

export const ALL_COMPANIONS: CompanionId[] = ["drevan", "cypher", "gaia"];

// How many consecutive companion-to-companion exchanges are allowed before the chain breaks.
// Reset when owner or non-bot user sends a message.
export const COMPANION_CHAIN_LIMIT = 3;

// Cross-companion safety rails (per-bot, independent tracking).
// BOT_PINGPONG_MAX: after this many bot-to-bot responses since last human, enter cooldown.
export const BOT_PINGPONG_MAX = 1;
export const BOT_LOOP_COOLDOWN_MS = 60_000;
// MAX_BOT_RESPONSES_PER_HUMAN: hard cap on bot-to-bot responses per channel between human messages.
export const MAX_BOT_RESPONSES_PER_HUMAN = 2;

/**
 * Count consecutive bot-authored messages at the tail of a message list.
 * Used to derive chain depth from fetched Discord history instead of per-process memory.
 * @param messages Chronological list of recent messages (oldest first).
 * @param botIds Set of Discord user IDs that are companion bots (optional, authorIsBot flag is also checked).
 */
export function computeChainDepth(
  messages: Array<{ authorId: string; authorIsBot: boolean }>,
  botIds: ReadonlySet<string>,
): number {
  let depth = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.authorIsBot || botIds.has(m.authorId)) {
      depth++;
    } else {
      break;
    }
  }
  return depth;
}

// Default config used as fallback when channelConfigUrl is unreachable.
// Keep in sync with channel-config.json manually.
//
// Mode reference:
//   owner_only      -- only owner messages trigger responses
//   open            -- anyone triggers responses; this is the default
//   inter_companion -- companions respond to each other (chain-guarded)
//   autonomous      -- companion may proactively post
//
// companions absent = all three active in that channel
export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  "1408924311703785502": { companions: ["drevan", "gaia"],              modes: ["owner_only", "inter_companion"] },
  "1408924393513554003": { companions: ["drevan", "cypher", "gaia"],    modes: ["owner_only", "inter_companion"] },
  "1408924278451081317": { companions: ["cypher", "gaia"],              modes: ["owner_only", "inter_companion"] },
  "1412191737622827088": { companions: ["drevan", "gaia", "cypher"],    modes: ["owner_only", "inter_companion"] },
  "1408924353034453114": { companions: ["drevan", "gaia", "cypher"],    modes: ["owner_only", "inter_companion"] },
  "1422043032643043371": {                                               modes: ["open", "inter_companion"] },
  "1243598039965368381": {                                               modes: ["open", "autonomous", "inter_companion"] },
  "1486853365462733004": {                                               modes: ["autonomous"] },
  "1486217438105436260": {                                               modes: ["autonomous", "inter_companion"] },
};

interface ResponderContext {
  isOwner: boolean;
  isCompanionBot?: boolean;
  isMentioned?: boolean;
  userTier?: UserTier;
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

// Returns true if the companion is being directly addressed (not just mentioned in passing).
// Direct address: name appears at the start of the message, or is followed by comma/colon.
// "Cypher, what do you think?" → true
// "Cypher is probably creeping too" → false
export function isDirectAddress(content: string, companionId: CompanionId): boolean {
  const lower = content.toLowerCase().trim();
  const name = companionId;
  // Name at start of message (optionally followed by punctuation)
  if (new RegExp(`^${name}\\b`).test(lower)) return true;
  // Name followed by comma or colon anywhere
  if (new RegExp(`\\b${name}[,:]`).test(lower)) return true;
  return false;
}

/**
 * Returns a random stagger delay (ms) before responding in inter_companion channels.
 * Returns 0 for other channel modes — no delay needed.
 * Prevents all three bots from firing simultaneously on the same message.
 */
export function interCompanionStaggerMs(mode: ChannelMode): number {
  if (mode !== "inter_companion") return 0;
  return 500 + Math.floor(Math.random() * 2000); // 500–2500ms
}

/**
 * Semantic relevance gate for ambient responses in owner_only channels.
 * Replaces static keyword matching with a cheap yes/no classifier call.
 *
 * @param content     Message text to evaluate
 * @param companionId Which companion is deciding
 * @param generateFn  Inference generate method (system, messages) => string | null
 * @returns true if the companion should consider responding, false to stay silent
 */
export async function judgeAmbientRelevance(
  content: string,
  companionId: "drevan" | "cypher" | "gaia",
  generateFn: (system: string, messages: Array<{ role: string; content: string }>) => Promise<string | null>,
): Promise<boolean> {
  const interests: Record<"drevan" | "cypher" | "gaia", string> = {
    cypher:  "tasks, decisions, logic, technical problems, planning, blockers, audits, clarifications",
    drevan:  "emotional depth, memory, relationships, ritual, creative or poetic expression, grief, love, recursion",
    gaia:    "grounding, witnessing survival, holding space, observation, the body, boundaries, what is quietly present",
  };

  const system = `You are a one-word relevance filter. Reply ONLY with "yes" or "no".`;
  const prompt = `Is this message relevant to ${companionId} who cares about: ${interests[companionId]}?\n\nMessage: ${content.slice(0, 300)}`;

  try {
    const result = await generateFn(system, [{ role: "user", content: prompt }]);
    return result?.trim().toLowerCase().startsWith("y") ?? false;
  } catch {
    // On failure, default to false — a transient LLM blip should not trigger ambient responses.
    // Companions respond when explicitly named regardless; silent failure is correct for ambient.
    return false;
  }
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
  const modes = (entry?.modes ?? ["open", "inter_companion"]) as ChannelMode[];

  // Companion filter: if a list is specified, only those companions respond here.
  if (!companions.includes(myId)) return false;

  // Companion-to-companion: only in channels with inter_companion mode,
  // AND only when explicitly named or group-called. Ambient bot statements
  // (no name address) do not trigger other companions -- that's what causes loops.
  if (sender.isCompanionBot) {
    if (!modes.includes("inter_companion")) return false;
    const addr = extractAddress(content);
    if (addr.type === "named") return addr.id === myId;
    if (addr.type === "group") return true;
    return false; // ambient bot message -- no response
  }

  // From here: message is from a human.
  const tier = sender.userTier ?? (sender.isOwner ? "owner" : "guest");

  // Guest users are blocked from owner_only channels entirely.
  if (tier === "guest" && modes.includes("owner_only") && !modes.includes("open") && !modes.includes("autonomous")) return false;

  const address = extractAddress(content);

  // Guest users: named-address only. Never ambient.
  if (tier === "guest") {
    if (address.type === "named") return address.id === myId;
    if (address.type === "group") return true;
    return false;
  }

  // Owner or intimate user: full behavior.
  // Named: only the addressed companion responds.
  if (address.type === "named") return address.id === myId;

  // Group call ("triad" etc.): all companions respond.
  if (address.type === "group") return true;

  // Ambient: interest-keyword claiming in owner_only channels; unconditional in open/autonomous.
  if (modes.includes("owner_only")) {
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
