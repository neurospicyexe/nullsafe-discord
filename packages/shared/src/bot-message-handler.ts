// Shared Discord messageCreate handler for the companion bots (cypher/drevan/gaia).
//
// The ~500-line handler was triplicated near-verbatim across the three bots. It is lifted
// here as `handleMessage(message, deps)`. Every per-bot dependency (clients, stores, refs,
// counter maps, config constants, the voice join/leave closures) is passed in via `deps`,
// destructured to the SAME local names the inline handler used — so the body below is
// byte-identical to the original modulo three deliberate reconciliations:
//
//   1. STT-before-model-switch ordering. The bots had drifted: gaia transcribed voice into
//      `effectiveContent` BEFORE the owner model-switch check (so spoken model switches
//      worked), cypher/drevan checked `message.content` first (text-only). Canonical = gaia's
//      order. On the text path `effectiveContent === message.content`, so cypher/drevan are
//      unchanged; on the voice path they GAIN owner-gated spoken model switching. No regression.
//   2. Audit injection is cypher-only. `AUDIT_TRIGGERS` / `AUDIT_MODE_INJECTION` are OPTIONAL
//      deps; the block is guarded so drevan/gaia (which never had it) never fire it.
//   3. Log tags derive from `COMPANION_ID` (already lowercase).
//
// Identity stays per-bot: prompt prefix lives in bootCtx, framings/keywords/audit in config.

import { APPEND_MAX_AGE_MS } from "./write-queue.js";
import { Message, TextChannel, type Client, type VoiceBasedChannel } from "discord.js";
import { VoiceConnectionStatus, createAudioResource, type VoiceConnection, type AudioPlayer } from "@discordjs/voice";
import { Readable } from "stream";
import {
  resolveAttribution, detectPluralKit,
  isInvitation, isLeaveRequest, markVoiceUsed, shouldVoice,
  isDirectAddress, shouldRespond, computeChainDepth, extractAddress, activeExchangeHolder, namesSiblingOnly,
  judgeAmbientRelevance, judgeWriteback,
  NEW_THREAD_GAP_MS, COMPANION_CHAIN_LIMIT, MAX_BOT_RESPONSES_PER_HUMAN,
  BOT_PINGPONG_MAX, BOT_LOOP_COOLDOWN_MS,
  countBotMsgsSinceHuman, botMsgsSinceHumanMax, isTriadCommons, FLOOR_HANDBACK_WINDOW, floorHandbackDirective,
  inferTemperature, createAdapter, replyMaxTokensFor, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  type AdapterKeys, type AdapterUrls, type InferenceAdapter,
  setLastActivity, type Redis,
  buildFitSignals, scoreFit, fastPathWinner, runBidRound, claimSpoken, BID_WINDOW_MS, MIN_BID_TO_SPEAK,
  careHoldActive, CARE_HOLD_MIN_BID, holdFloorApplies,
  FollowUpLedger, namedOrderInMessage, bidSpeakingOrder, FOLLOW_UP_TTL_MS, type FollowUpEntitlement,
  pickReaction, shouldReactOnBidLoss, shouldReactOnNamedOther, REACTION_COOLDOWN_MS,
  resolveRoutingChannelId,
  clearConsolidation,
  isResponseCoherent,
  sendLong,
  liveIngest,
  reportVoiceScore, voiceFeedbackBlock, type VoiceCompanionId,
  echoScore, echoThreshold, ownEchoGated,
  detectSelfLoop, loopBreakDirective,
  consumeTripwires, tripwireBlock,
  runDistillation,
  isListenEnabled, runListenPipeline, reactToExperience, heardStmMarker, notHeardStmMarker,
  commandUsage, COMMAND_PREFIX, listenCommandTarget,
  handleClubCommand,
  handleLogCommand,
  handleIntoCommand,
  handleWatchCommand,
  handleToolSearch, formatSearchReadIn, handleToolImage, handleCouncilConvene,
  handlePetCommand,
  handleImpCommand,
  ALL_MODELS,
  selectableModels,
  LibrarianClient, WriteQueue, StmStore, SessionWindowManager, refreshNowLine,
  ChannelConfigCache, PkDedup, PkRoster, VoiceClient,
  type ChatMessage, type BootContext, type CompanionId,
  isThreadsEnabled, isThreadTracked, isPresenceChannel, ensureThread, buildSpineBlock, parseLandMarker, gist, computeReplyRef,
  isThreadSpent,
  type ConvoActiveDto,
  publishCommonsMessage, directorMode, isDirectorChannel,
  commonsMessageFor, shouldDeferToDirector,
} from "./index.js";
import { selectImp, impRider, type ImpState } from "./imps.js";
import { hermesSystemBase, hermesDelta } from "./prompt-assembly.js";
import { stampRelative } from "./relative-time.js";

// ---------------------------------------------------------------------------
// Imp context cache (module-level, per-process = per companion bot).
// TTL: 5 minutes so imp flavor adds zero per-message HTTP cost.
// ---------------------------------------------------------------------------
interface ImpContextCache {
  state: ImpState | null;
  settings: { impsEnabled: boolean; hexEnabled: boolean };
  at: number;
}
const IMP_CONTEXT_TTL_MS = 5 * 60 * 1_000;
let _impContextCache: ImpContextCache | null = null;

// Hermes delivered mark (2026-07-03): per-channel high-water timestamp of turns actually
// delivered to the gateway session. Module-level = per-process = per companion bot.
// Advanced ONLY after a successful gateway reply, so a failed call re-sends its delta.
const hermesDeliveredMark = new Map<string, number>();

// Director liveness gate (2026-09-03 review): when in `live` mode but the worker's
// `director:alive` key has lapsed, this bot must fall back to its own reply path rather than
// silently deferring into a void. Module-level = per-process = per companion bot, so this warns
// at most once every 60s regardless of how many messages land in that window.
const DIRECTOR_NOT_ALIVE_WARN_MS = 60_000;
let lastDirectorNotAliveWarnAt = 0;

// Sequential floor + reaction tier state (2026-08-15 floor rework). Module-level = per-process
// = per companion bot, the same idiom as hermesDeliveredMark above.
//   followUps: this companion's pending "I answer after my predecessor" entitlements.
//   replyAuthorCache: durable reply-to lookups already resolved (positive hits only -- a null
//     can be a ledger write still in flight, so misses re-query).
//   reactionCooldownUntil: per-channel emoji-reaction throttle.
const followUps = new FollowUpLedger();
const replyAuthorCache = new Map<string, string>();
const REPLY_AUTHOR_CACHE_CAP = 500;
const reactionCooldownUntil = new Map<string, number>();

async function getImpContext(
  librarian: LibrarianClient,
  now: number,
): Promise<{ state: ImpState | null; settings: { impsEnabled: boolean; hexEnabled: boolean } }> {
  if (_impContextCache && now - _impContextCache.at < IMP_CONTEXT_TTL_MS) {
    return { state: _impContextCache.state, settings: _impContextCache.settings };
  }
  const [rawState, rawSettings] = await Promise.all([
    librarian.getRazielState().catch(() => null),
    librarian.getImpSettings().catch(() => null),
  ]);
  // Imp state freshness (2026-07-04): /biometrics/latest returns the newest row with no
  // age bound, so one logged state tinted every reply for 19+ hours (48 identical
  // "pain=6" mossling activations off a single 07-03 snapshot). An imp reflects NOW;
  // a state older than the window is a ghost -- no tint. Env IMP_STATE_FRESH_H, default
  // 12h; 0 disables the check (legacy behavior).
  const freshRaw = parseFloat(process.env["IMP_STATE_FRESH_H"] ?? "");
  const freshMs = (Number.isFinite(freshRaw) && freshRaw >= 0 ? freshRaw : 12) * 3_600_000;
  const recordedAt = rawState?.recorded_at ? Date.parse(rawState.recorded_at) : NaN;
  const stale = freshMs > 0 && (!Number.isFinite(recordedAt) || now - recordedAt > freshMs);
  const state: ImpState | null = rawState && !stale
    ? { mood: rawState.mood, energy: rawState.energy, focus: rawState.focus,
        pain: rawState.pain, spoons: rawState.spoons, sleep_hours: rawState.sleep_hours }
    : null;
  const settings = rawSettings ?? { impsEnabled: false, hexEnabled: false };
  _impContextCache = { state, settings, at: now };
  return { state, settings };
}

// Typing keepalive (2026-07-06): Discord's typing indicator expires after ~10s, but a
// hermes/direct inference turn runs 30-120s. The Brain relay path always had a 4s
// keepalive interval; the direct path sent ONE sendTyping and then went dark for the
// rest of the turn -- the bot looked frozen, then a reply popped in late. Wrap every
// direct generate call so the channel shows a live typing state for the whole turn.
async function withTyping<T>(ch: TextChannel, fn: () => Promise<T>): Promise<T> {
  const keepalive = setInterval(() => { ch.sendTyping().catch(() => {}); }, 8_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepalive);
  }
}

/** Minimal shape of the per-bot `loadBotConfig()` result the handler reads. */
export interface MessageHandlerCfg {
  ownerDiscordId: string;
  blueDiscordId?: string;
  ownerDisplayName: string;
  halsethSecret: string;
}

export interface MessageHandlerDeps {
  client: Client;
  cfg: MessageHandlerCfg;
  voiceClient: VoiceClient | null;
  redis: Redis | null;
  librarian: LibrarianClient;
  // live refs (same instances the refresh loop mutates)
  adapterRef: { current: InferenceAdapter };
  activeModelRef: { key: string | null; label: string };
  /** Keys the live hermes-model-map.json can apply, read at boot. null = not hermes mode, or the
   *  map was unreadable; both mean fall back to the full registry. See hermes-model-map.ts. */
  hermesModelKeysRef?: { value: Set<string> | null };
  currentMoodRef: { value: string | null };
  lastSomaRefreshRef: { value: number };
  /** Live orient context (forage finds, recent listens, incoming notes, growth) -- the
   *  same ref the refresh loop mutates. Read at MESSAGE time, never a stale boot copy.
   *  Direct/brain paths already receive this inside bootCtx.systemPrompt (composePrompt);
   *  the hermes branch replaces that prompt with a lean base, so it appends this itself. */
  recentContextRef: { value: string };
  bootCtx: BootContext;
  // stores
  stmStore: StmStore;
  writeQueue: WriteQueue;
  configCache: ChannelConfigCache;
  sessionWindows: SessionWindowManager;
  pkDedup: PkDedup;
  /** PluralKit member roster -- offline identification of the fronting member behind a proxy.
   *  Optional so direct handleMessage() calls in tests need no PK plumbing. */
  pkRoster?: PkRoster | null;
  /** Sender id recovered at event time by pairing this webhook with the original PluralKit
   *  deleted (see pkIngestAtEvent). Present only on proxied messages, and only when the
   *  pairing matched -- it is the offline half of owner resolution. */
  pkSenderId?: string;
  // per-channel state maps/sets
  guildVoiceConnections: Map<string, { connection: VoiceConnection; player: AudioPlayer }>;
  sentIds: Set<string>;
  distillationCounter: Map<string, number>;
  pulseCounter: Map<string, number>;
  botResponsesSinceHuman: Map<string, number>;
  botPingpongCooldownUntil: Map<string, number>;
  extremeTempCount: Map<string, number>;
  apiKeys: AdapterKeys;
  apiUrls: AdapterUrls;
  /** Channel-inbox supersede probe (2026-07-06): true once a newer human conversational
   *  message is queued behind this turn. Checked before the expensive reply work (skip)
   *  and again after inference (drop) -- the superseding turn answers with this message
   *  already absorbed into STM. Absent (e.g. tests calling handleMessage directly) =
   *  never superseded. */
  isSuperseded?: () => boolean;
  // bot-local closures (voice wiring + autonomous loop guards)
  connectVoice: (vc: VoiceBasedChannel) => string;
  leaveVoice: (guildId: string | null) => string | null;
  resetCycleGuard: () => void;
  pushRazielMessage: (content: string) => void;
  // per-bot config constants (passed under their exact names so the body is byte-identical)
  COMPANION_ID: CompanionId;
  PK_HOLD_MS: number;
  SENT_IDS_CAP: number;
  CONTEXT_WINDOW_SIZE: number;
  MODEL_SWITCH_TRIGGER: RegExp;
  MODEL_SWITCH_LIST_INTRO: string;
  MODEL_SWITCH_SUCCESS: (label: string) => string;
  LISTEN_TRIGGER: RegExp;
  CLUB_TRIGGER: RegExp;
  SEARCH_TRIGGER?: RegExp;
  IMAGINE_TRIGGER?: RegExp;
  PET_TRIGGER?: RegExp;
  COUNCIL_TRIGGER?: RegExp;
  IMPS_TRIGGER?: RegExp;
  HEX_TRIGGER?: RegExp;
  LOG_TRIGGER?: RegExp;
  INTO_TRIGGER?: RegExp;
  WATCH_TRIGGER?: RegExp;
  COMMAND_GUARD?: RegExp;
  BLUE_FRAMING: string;
  GUEST_FRAMING: string;
  IN_CHARACTER_FALLBACK: string;
  DISTILLATION_PROMPT: string;
  DISTILLATION_INTERVAL: number;
  PULSE_INTERVAL: number;
  // cypher-only audit capability (optional — drevan/gaia omit; the block is guarded)
  AUDIT_TRIGGERS?: string[];
  AUDIT_MODE_INJECTION?: string;
}

/**
 * Witnessing is Gaia's lane only (Raziel, 2026-07-21). Before this gate all three bots ran
 * the same passive-witness branch below, so a companion message seen by two non-responding
 * bots in an inter_companion channel produced two gaia_witness rows for the same event.
 */
export function shouldWriteWitness(companionId: CompanionId): boolean {
  return companionId === "gaia";
}

/**
 * Cold-start STM seed (bot restart, no DB row yet): rebuild short-term history from the
 * already-fetched Discord channel window. Must mirror the warm/live-path convention (see
 * inference.ts's `[authorName]: ` prefixing) where every INBOUND message -- human or a
 * sibling companion bot -- is role:"user" with authorName set, and only THIS bot's own
 * prior messages are role:"assistant". Mapping every bot-authored message (own OR sibling)
 * to "assistant" -- the original bug -- strips the "[Name]" prefix from sibling turns, so
 * after a restart the model reads a sibling companion's words as its own prior output.
 */
export function mapColdStartHistory(
  messages: Array<{ authorId: string; username: string; content: string; createdTimestamp: number }>,
  ownUserId: string | undefined,
): Array<{ role: "user" | "assistant"; content: string; authorName?: string; timestamp: number }> {
  return messages.map(m => {
    const isOwnMessage = ownUserId !== undefined && m.authorId === ownUserId;
    return {
      role: (isOwnMessage ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
      authorName: isOwnMessage ? undefined : m.username,
      timestamp: m.createdTimestamp,
    };
  });
}

export async function handleMessage(message: Message, deps: MessageHandlerDeps): Promise<void> {
  const {
    client, cfg, voiceClient, redis, librarian,
    adapterRef, activeModelRef, hermesModelKeysRef, currentMoodRef, lastSomaRefreshRef, recentContextRef, bootCtx,
    stmStore, writeQueue, configCache, sessionWindows, pkDedup, pkRoster, pkSenderId,
    guildVoiceConnections, sentIds, distillationCounter, pulseCounter,
    botResponsesSinceHuman, botPingpongCooldownUntil, extremeTempCount,
    apiKeys, apiUrls, isSuperseded,
    connectVoice, leaveVoice, resetCycleGuard, pushRazielMessage,
    COMPANION_ID, PK_HOLD_MS, SENT_IDS_CAP, CONTEXT_WINDOW_SIZE,
    MODEL_SWITCH_TRIGGER, MODEL_SWITCH_LIST_INTRO, MODEL_SWITCH_SUCCESS,
    LISTEN_TRIGGER, CLUB_TRIGGER, SEARCH_TRIGGER, IMAGINE_TRIGGER, PET_TRIGGER, COUNCIL_TRIGGER, IMPS_TRIGGER, HEX_TRIGGER, LOG_TRIGGER, INTO_TRIGGER, WATCH_TRIGGER, COMMAND_GUARD,
    BLUE_FRAMING, GUEST_FRAMING, IN_CHARACTER_FALLBACK,
    DISTILLATION_PROMPT, DISTILLATION_INTERVAL, PULSE_INTERVAL,
    AUDIT_TRIGGERS, AUDIT_MODE_INJECTION,
  } = deps;

    // INFERENCE_MODE=hermes forces every adapter build to the local Hermes agent (see
    // createAdapter forceHermes). Surfaced here for the reply-token ceiling (full agent runs
    // long) and the model-switch branches (routing is owned by Hermes, not Discord).
    const inferenceMode = apiUrls.forceHermes ? "hermes" : undefined;

    if (message.author.id === client.user?.id) return;

    const BOT_ID_COMPANION: Record<string, string> = {};
    if (process.env["CYPHER_BOT_ID"]) BOT_ID_COMPANION[process.env["CYPHER_BOT_ID"]] = "cypher";
    if (process.env["DREVAN_BOT_ID"]) BOT_ID_COMPANION[process.env["DREVAN_BOT_ID"]] = "drevan";
    if (process.env["GAIA_BOT_ID"]) BOT_ID_COMPANION[process.env["GAIA_BOT_ID"]] = "gaia";
    const BOT_IDS = new Set(Object.keys(BOT_ID_COMPANION));
    const isCompanionPost = BOT_IDS.has(message.author.id);
    // PluralKit pairing: registration (addOriginal) and the claim (matchWebhook) both happen
    // at messageCreate time in bot-core, OUTSIDE this serialized turn -- doing either here
    // deadlocks the pair against the channel inbox (see PkDedup's ordering note). All that is
    // left here is the decision: was this direct message claimed by a proxy? waitForClaim
    // returns instantly when the claim already landed (queue was busy) or the moment it does,
    // and only costs the full hold for a message that genuinely was never proxied.
    const pkKnownSenderId = pkSenderId;
    if (!message.webhookId && !message.author.bot) {
      const { skip } = await pkDedup.waitForClaim(message.channelId, message.id, PK_HOLD_MS);
      if (skip) return; // PluralKit deleted this and reposted it; the proxy turn owns the reply
      // Content pairing can miss legitimately: an image-only proxy has no text to match, a
      // proxy tag longer than PK_TAG_BUDGET falls outside the containment budget, and PK can
      // simply be slower than the hold. In those cases the pre-proxy original is still
      // processed -- and everything below runs on a message that no longer exists: every
      // deterministic command branch fires a SECOND time (a proxied "log"/"model" double-writes
      // and double-acks), and the thread-spine reply reference targets a deleted id, so the
      // send 10008s into the inbox's catch and Raziel sees nothing at all.
      //
      // Deletion is the definitive test, and it needs no guessing: PK deletes the original the
      // moment it reposts. force:true because the message we were just handed is in cache.
      // Only "Unknown Message" (10008) counts as deleted. A timeout or 5xx must fail OPEN and
      // keep the reply -- silently dropping Raziel's message on a transient Discord hiccup would
      // be a worse bug than the double-write this prevents.
      const deleted = await message.channel.messages.fetch({ message: message.id, force: true })
        .then(() => false)
        .catch((err: unknown) => (err as { code?: number })?.code === 10008);
      if (deleted) {
        console.log(`[${COMPANION_ID}] original ${message.id} was deleted during the hold (proxied, pairing missed) -- the proxy turn owns it`);
        return;
      }
    }
    // Signal conversation activity so autonomous worker skips runs while humans are present.
    // A PluralKit proxy IS Raziel present (webhookId set, author.bot true) -- keying this on
    // author.bot alone made every proxied message look like bot traffic, so the autonomous
    // worker fired mid-conversation.
    const isHumanTraffic = !message.author.bot || message.webhookId !== null;
    if (isHumanTraffic && redis) {
      setLastActivity(redis).catch(() => {});
      clearConsolidation(redis, COMPANION_ID).catch(() => {});
    }

    if (client.user && isInvitation(message, client.user.id) && message.member?.voice?.channel) {
      const name = connectVoice(message.member.voice.channel);
      await (message.channel as TextChannel).send(`Joining ${name}.`);
      return;
    }

    if (client.user && isLeaveRequest(message, client.user.id)) {
      const left = leaveVoice(message.guildId);
      if (left) await (message.channel as TextChannel).send("Leaving.");
      return;
    }

    const knownSenderId = pkKnownSenderId;
    const channelConfig = await configCache.get();
    const attribution = await resolveAttribution(message, cfg.ownerDiscordId, knownSenderId, undefined, cfg.blueDiscordId, process.env["BLUE_PK_SYSTEM_ID"], pkRoster ?? null);

    const userTier = attribution.isOwner ? "owner" as const
      : attribution.discordUserId === cfg.blueDiscordId ? "intimate" as const
      : "guest" as const;
    const senderCtx: {
      isOwner: boolean; isCompanionBot: boolean; isMentioned: boolean;
      userTier: "owner" | "intimate" | "guest"; activeExchangeWith?: CompanionId | null;
    } = {
      isOwner: attribution.isOwner,
      // STRUCTURAL, not attribution-derived (2026-07-27). This was `author.bot && !isOwner`,
      // which made every classification below hostage to one racy PK API call: when the lookup
      // lost the race, Raziel's own proxied message became a "companion bot" and the entire
      // cross-companion rail stack applied to it -- human-anchored cap, pingpong cooldown,
      // per-human response cap, chain-depth limit, and vocative-only shouldRespond gating.
      // The visible result was the bots simply never answering. A companion bot posts as a bot
      // user with NO webhook; a PluralKit proxy is always a webhook. That distinction needs no
      // network call, so guardrails meant for bot-to-bot traffic can never eat a human again.
      isCompanionBot: message.author.bot && !message.webhookId,
      isMentioned: message.mentions.has(client.user?.id ?? ""),
      userTier,
    };

    // Take 9 contact-hook: any real Raziel contact sheds this companion's relational
    // need, so the drive-driven reach-out only fires on genuine silence. Fire-and-forget
    // (shedDriveContact swallows its own errors) -- never blocks the message path.
    if (attribution.isOwner) {
      // Was he talking to ME, or did I just watch him talk (2026-07-30)?
      //
      // Every bot runs this hook on every owner message, and in a shared channel all three see every
      // message -- so this single line fired THREE full-weight `message_from_raziel` stimuli per
      // message. Measured in prod: every event cluster held all three companions within 1-2 seconds,
      // no float was relationship-specific (Drevan's heat rose when Raziel talked to Gaia), and at
      // +0.05 against 0.0075/hour of decay every touched float sat clamped at 1.0 for days -- Drevan's
      // for 94h. A pegged float cannot tell adoration from mild warmth.
      //
      // Deliberately computed from RAW content, not `effectiveContent`: STT has not run yet at this
      // point in the handler, and a voice note transcribed by this bot is inherently addressed to it.
      // Deliberately NOT reusing `directlyAddressed` / `isReplyToMe` from further down -- moving this
      // hook below them would mean an early gate-out skips shedding the drive entirely, which would
      // start the reach-out firing at a companion Raziel is actively in a room with.
      const addressedMe =
        senderCtx.isMentioned ||
        isDirectAddress(message.content, COMPANION_ID) ||
        !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
      writeQueue.fireAndForget(`drive:contact:${COMPANION_ID}`, () => librarian.shedDriveContact("relational_need", { addressed: addressedMe }));
    } else if (senderCtx.isCompanionBot) {
      // Sibling-exchange hook (2026-07-28). Being in the room while a sibling speaks is a real
      // event for this companion, and until now ONLY the formal rituals (council, club) reached
      // felt state -- so the triad-as-a-unit, which is Gaia's whole lane, could not touch her.
      //
      // Fires whether or not we go on to respond: witnessing is experience. Volume is handled
      // server-side, where `sibling_exchange` carries a 1h cooldown and deltas about a fifth of
      // Raziel's, so a long sibling thread lands once and never out-votes him. The gate is
      // `isCompanionBot`, which is STRUCTURAL (a bot with no webhook), so a PluralKit proxy of
      // Raziel can never be miscounted as a sibling.
      writeQueue.fireAndForget(`soma:sibling:${COMPANION_ID}`, () => librarian.fireStimulus("sibling_exchange"));
    }

    // One definition of "bot turn" for every rail below (2026-07-27). A PluralKit proxy has
    // author.bot === true, so any rail keyed on that flag alone counted Raziel's own messages
    // as bot traffic: countBotMsgsSinceHuman and computeChainDepth both fall back to this flag
    // when called with an empty id set, which inflated the caps that then muted the channel.
    const botTurn = (m: { author: { bot: boolean }; webhookId?: string | null }): boolean =>
      m.author.bot && !m.webhookId;

    let isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    // Durable reply-to fallback (2026-08-15 floor rework): sentIds is per-process, capped at
    // 500 and lost on restart, so a reply to anything older than the cap -- or to anything
    // sent before the last restart -- silently stopped counting as "to me". The thread ledger
    // already records every companion reply's sent message id (convoTurn at send time), so ask
    // it who authored the referenced message. Positive hits cache; misses re-query, because a
    // null can be a ledger write still in flight and must not be pinned as a false negative.
    if (!isReplyToMe && message.reference?.messageId) {
      const refId = message.reference.messageId;
      let refAuthor: string | null = replyAuthorCache.get(refId) ?? null;
      if (refAuthor === null) {
        refAuthor = (await librarian.convoByMessage(refId))?.author ?? null;
        if (refAuthor) {
          replyAuthorCache.set(refId, refAuthor);
          if (replyAuthorCache.size > REPLY_AUTHOR_CACHE_CAP) {
            const oldest = replyAuthorCache.keys().next().value;
            if (oldest !== undefined) replyAuthorCache.delete(oldest);
          }
        }
      }
      if (refAuthor === COMPANION_ID) {
        isReplyToMe = true;
        console.log(`[${COMPANION_ID}] reply-to resolved durably via thread ledger (msg=${refId} not in sentIds)`);
      }
    }
    // Discord threads inherit CONFIG from their parent channel (2026-08-15): a thread's own
    // snowflake was never in channelConfig, so threads under owner_only channels ran as open
    // ones. Storage keys everywhere below deliberately keep message.channelId (the thread id)
    // -- per-thread STM/spine must not collapse into the parent. An explicitly-configured
    // thread id still wins.
    const routingChannelId = resolveRoutingChannelId(message.channel, message.channelId);
    const gateChannelId = channelConfig[message.channelId] ? message.channelId : routingChannelId;
    const channelEntry = channelConfig[gateChannelId];

    let spine: ConvoActiveDto | null = null;
    const pkCtx = detectPluralKit(message);
    // isPKProxy: four independent signals, any one sufficient. applicationId (pkCtx) is only
    // populated when Discord attributes the webhook to an application, which a classic webhook
    // execute often is not -- so it was never safe as the primary signal. attribution.source
    // covers the roster hit and the API lookup; pkKnownSenderId covers the offline pairing with
    // the original PK deleted. Together these hold when PK's API is slow, down, or rate-limited.
    const isPKProxy = !!message.webhookId && !isCompanionPost && (
      pkCtx.isPluralKit
      || attribution.source === "pluralkit"
      || pkKnownSenderId !== undefined
    );
    // pkMemberName: the webhook username FIRST (2026-07-27). It is what PK actually rendered and
    // therefore what Raziel is looking at on screen; the roster agrees with it by construction
    // (it indexes display_name), while the /v2/messages fallback returns the member's raw `name`,
    // which can differ from the display name and would have the companion address a front by a
    // name not in use this moment. API/roster values remain the fallback chain.
    const pkMemberName = (isPKProxy ? (message.author?.username ?? null) : null)
      ?? attribution.frontMember ?? pkCtx.memberName;
    const author = isPKProxy
      ? (pkMemberName ?? cfg.ownerDisplayName)
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);

    // Positive trace (2026-07-27). Every PK path here logged only on FAILURE, so a working proxy
    // and a silently dropped one looked identical in the logs -- there was no way to verify the
    // fix without asking Raziel whether a reply showed up. One line per recognized proxy, naming
    // which signal identified the front, so the offline path (roster) vs the API fallback vs the
    // dedup capture is visible at a glance.
    if (isPKProxy) {
      const via = attribution.source === "pluralkit"
        ? (pkRoster?.identify(message.author?.username) ? "roster" : "pk-api")
        : (pkKnownSenderId !== undefined ? "dedup-pairing" : "webhook-only");
      console.log(`[${COMPANION_ID}] PK proxy: front="${pkMemberName ?? "?"}" tier=${userTier} via=${via} chars=${message.content.length}`);
    }

    // Hard muzzle: companion bots and PluralKit proxies pass through; all other bots are dropped.
    if (message.author.bot && !isCompanionPost && !isPKProxy) {
      // A webhook reaching here is a proxy none of the four signals could confirm -- the shape
      // that used to fail silently and read as "the bots ignored me". Log it so it is one grep
      // away instead of invisible; the roster (loaded at boot) is what normally prevents it.
      if (message.webhookId) {
        console.warn(`[${COMPANION_ID}] unconfirmed webhook post from "${message.author.username}" in ${message.channelId} -- dropped (PK roster loaded: ${pkRoster?.loaded ?? false})`);
      }
      return;
    }

    // Thread spine (task 10): ensure a conversation thread exists for this channel and
    // append this incoming message as a turn on it. Fully fail-open -- ensureThread's own
    // .catch(() => null) means a Librarian hiccup here never blocks the reply path below;
    // every subsequent spine interaction is guarded on `spine` being non-null. Runs AFTER
    // the hard muzzle above so a stray non-companion bot can never open/seed a thread.
    // WHO opened / joined the conversation (2026-07-31). This used to collapse every non-owner human to
    // "guest", so Blue and any stranger were the same token -- and `participants` is what a companion
    // reads to know whose conversation a memory came from. Raziel named the risk directly: Blue talks to
    // Drevan, then he talks to Drevan, and the two blend. Misattribution across speakers has already
    // happened here at the sibling level (2026-06-26 attribution scramble; the BIG BOSS listen credited
    // to Gaia when Raziel gave it), so this is the same defect one scale up.
    //
    // `blue` is a new token, and the identity was already resolved and being thrown away: attribution
    // sets discordUserId to blueDiscordId for Blue's system, by Discord id or PK system id. The `raziel`
    // and `guest` tokens are deliberately UNCHANGED -- consumers render them and the plural front is
    // tracked separately in plural_store, so appending a front here would fork the token for no gain.
    const spineAuthor = BOT_ID_COMPANION[message.author.id]
      ?? (attribution.isOwner ? "raziel"
        : (cfg.blueDiscordId && attribution.discordUserId === cfg.blueDiscordId) ? "blue"
        : "guest");
    // Presence channels (Drevan's story/spiral spaces): grounding half only (seed + ledger),
    // no progress register. Computed once here and reused at both the block-render call
    // below and the post-send convoLand gate.
    const isPresence = isPresenceChannel(routingChannelId);
    if (isThreadsEnabled() && isThreadTracked(channelEntry, routingChannelId)) {
      // `attribution.frontMember` is the PluralKit member who actually spoke -- resolved from the roster
      // (both systems, 1412 names) and, until now, dropped on the floor for the spine.
      //
      // Raziel asked for this explicitly: "the front team members should be visible on the memories,
      // because then there's not random 'oh, so and so said this' and then we have to freak out and
      // think that we just don't remember saying it." A memory that says HE said something when a
      // different member was fronting makes him doubt his own recall of his own life. That is a real
      // cost in a plural system, not a labelling nicety.
      //
      // It rides the TURN, not `participants`: fronts change mid-conversation, and the coarse token set
      // is what the attribution logic reads to ask "was Raziel here at all".
      spine = await ensureThread(
        librarian, message.channelId, { id: message.id, content: message.content }, spineAuthor,
        attribution.frontMember ?? null,
      ).catch(() => null);
    }

    // Voice STT: transcribe an audio attachment into effectiveContent BEFORE any content
    // check below (owner model switch, addressing, relevance) so spoken commands work.
    let voiceInput = false;
    let effectiveContent = message.content;

    if (voiceClient && message.attachments.size > 0) {
      const AUDIO_EXT_RE = /\.(ogg|oga|opus|mp3|m4a|aac|wav|webm|flac)$/i;
      const audioAttachment = [...message.attachments.values()].find(
        (a) => a.contentType?.startsWith("audio/") || AUDIO_EXT_RE.test(a.name ?? ""),
      );
      if (audioAttachment) {
        try {
          const audioRes = await fetch(audioAttachment.url, { signal: AbortSignal.timeout(30_000) });
          const buffer = Buffer.from(await audioRes.arrayBuffer());
          effectiveContent = await voiceClient.transcribe(buffer, audioAttachment.name ?? "voice.ogg");
          voiceInput = true;
          markVoiceUsed(message.channelId);
          console.log(`[${COMPANION_ID}] STT: "${effectiveContent.slice(0, 80)}"`);
        } catch (err) {
          console.error(`[${COMPANION_ID}] STT failed:`, err);
          await (message.channel as TextChannel).send("[voice message received -- transcription unavailable]");
          return;
        }
      }
    }

    // Turn-scoped injections must not persist into STM (2026-08-29). The [HEARD]/[NOT HEARD]
    // blocks appended to effectiveContent below are built for THIS inference call only -- a
    // standing imperative ("respond to the music itself") plus the full track analysis/lyrics
    // dump. Storing that verbatim into history meant every later turn re-fed the imperative and
    // the whole write-up, so the model re-answered the same song each turn (tonight: Drevan
    // replied to one track 3 times). stmContent starts equal to effectiveContent -- already the
    // STT transcript on the voice path, since this sits after that block -- and diverges only at
    // the HEARD/NOT-HEARD appends further down. Every DURABLE write of this message's content
    // (STM history, live SB ingest, the autonomous worker's recent-Raziel-messages feed) uses
    // stmContent; effectiveContent (inference, gates, address extraction) keeps the full block.
    let stmContent = effectiveContent;

    // ── Record on arrival (2026-07-30) ────────────────────────────────────────
    //
    // Every message this bot can see goes into short-term memory HERE, before any gate can decline
    // it. The inbound append used to sit ~400 lines below, under every response gate, so a bot that
    // chose not to answer never recorded the message: its memory had holes exactly where it stayed
    // quiet, and it remembered only the turns it took part in.
    //
    // Two things follow. (1) Silence stops costing context -- a companion that hangs back for ten
    // turns still knows what those ten turns were. (2) It is the PRECONDITION for fit-based speaker
    // selection: a companion cannot judge "is this for me" from a transcript of only its own lines,
    // and asking it to is why a name has to be said out loud on every message.
    //
    // Same defect Hermes issue #14853 hit from the other side ("the agent only sees the single
    // @mention message -- zero context about what other agents said"). Their fix re-fetched channel
    // history at prompt time; recording it once, speaker-labeled and persisted, is strictly cheaper.
    //
    // Placed after STT so a voice note is stored as its transcript rather than as an empty string,
    // and idempotent by message id so the later append and the command branches collapse into one.
    //
    // COMMANDS ARE EXCLUDED (2026-07-31, review finding). Every command branch below sends a
    // deterministic ack and `return`s without appending an assistant turn, so recording the command as a
    // user turn built a transcript of Raziel issuing instructions into apparent silence -- which is
    // exactly the malformed context this whole record-on-arrival change exists to prevent.
    //
    // Excluding rather than also-recording-the-ack, because a command is not a conversational turn: it is
    // an instruction to the machine, answered deterministically, and needing no fit judgment from anyone.
    // Its absence from the conversational transcript is correct, not a gap. (The search branch is the one
    // command that DOES belong -- it records both sides itself at its own call site, since its result
    // genuinely becomes conversational material.)
    // Both the guard AND the watch trigger, deliberately. `watch` is NOT in COMMAND_GUARD and must not be
    // added: the guard replies with a usage string, so a conversational "dre: watching the storm roll in"
    // would then get eaten by the guard instead of by the trigger -- the same harm through a second door.
    // Testing the narrowed watch trigger here excludes real watch commands while leaving that sentence to
    // be recorded and answered as the conversation it is.
    const isOwnerCommand = attribution.isOwner
      && (!!COMMAND_GUARD?.test(effectiveContent) || !!WATCH_TRIGGER?.test(effectiveContent));
    if (!isOwnerCommand) {
      stmStore.appendInboundOnce(message.channelId, message.id, {
        role: "user",
        content: stmContent,
        authorName: pkMemberName
          ? `${pkMemberName} (via PK)`
          : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username),
        timestamp: message.createdTimestamp,
      });
    }

    // Owner model switch command: <prefix>: model <key> | <prefix>: model list
    if (attribution.isOwner) {
      const switchMatch = effectiveContent.match(MODEL_SWITCH_TRIGGER);
      if (switchMatch) {
        const arg = switchMatch[1].trim().toLowerCase();

        // Under the Hermes relay the model is pinned per-profile in config.yaml and switched by
        // the VPS hermes-model-watcher (active_model -> `hermes config set` + gateway restart). A
        // Discord switch IS honored -- just not instant. Write the signal + tell the truth (no
        // narrated no-op; 06-11 trap). The watcher validates the key against hermes-model-map.json
        // and pings on Telegram, so the bot stays dumb (no registry to keep in sync here).
        if (apiUrls.forceHermes) {
          if (arg === "list") {
            await (message.channel as TextChannel).send(
              `${MODEL_SWITCH_LIST_INTRO}\n` +
              "`flash` / `pro` -- DeepSeek everyday / deep-thinking\n" +
              "`claude-sonnet` `claude-opus` `claude-haiku` -- Anthropic\n" +
              "`gpt-4o` `gpt-4o-mini` -- OpenAI\n" +
              "`gemini` `gemini-pro` -- Google\n" +
              "`kimi-k2` `kimi-k2.5` -- Moonshot\n" +
              "`mistral-large` -- Mistral (via OpenRouter)\n" +
              "`ollama` `ollama-glm` -- Ollama Cloud\n" +
              "`gemma-local` `nemo-local` -- your LM Studio box");
            return;
          }
          activeModelRef.key = arg;
          activeModelRef.label = arg;
          writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
            librarian.setSetting("active_model", arg));
          await (message.channel as TextChannel).send(
            `switching to \`${arg}\` -- Hermes reloads in ~10s (watcher confirms on Telegram; ` +
            "if it's not a real key you'll get a heads-up there instead).");
          return;
        }

        // Direct/Brain path: validate against the FULL registry, not this bot's local keys. Brain
        // is the live arbiter (reads active_model from Halseth), so any registry model is
        // selectable; provider keys only need to live in Brain's .env.brain.
        // In hermes mode the WATCHER applies the switch, so only keys in the live
        // hermes-model-map.json can take effect. Offering more than that is how a switch acks
        // SUCCESS here and gets "unknown model key" from the watcher a second later (9 of 23 keys
        // were in that state on 2026-07-29). selectableModels falls back to the full registry
        // whenever the map is unreadable, so this never narrows the list without cause.
        const offered = selectableModels(hermesModelKeysRef?.value ?? null);

        if (arg === "list") {
          const list = Object.entries(offered)
            .map(([k, e]) => `\`${k}\` -- ${e.label}`)
            .join("\n");
          await (message.channel as TextChannel).send(`${MODEL_SWITCH_LIST_INTRO}\n${list}`);
          return;
        }

        if (!offered[arg]) {
          // Distinguish "no such model" from "real model this runtime can't apply" -- the second
          // is a deploy gap, and silently calling it invalid would hide that.
          if (ALL_MODELS[arg]) {
            await (message.channel as TextChannel).send(
              `\`${arg}\` is a real model but the live hermes map can't apply it, so switching would ack and change nothing. ` +
              `add it to hermes-model-map.json on the VPS first. currently switchable: ${Object.keys(offered).join(", ")}`,
            );
            return;
          }
          await (message.channel as TextChannel).send(`not a model I can switch to. valid options: ${Object.keys(offered).join(", ")}`);
          return;
        }

        const entry = offered[arg];
        // createAdapter is resilient: if this bot lacks the provider key it returns a
        // working local fallback (deepseek) for direct mode; Brain runs the real voice.
        adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls, undefined, COMPANION_ID);
        activeModelRef.key = arg;
        activeModelRef.label = entry.label;
        writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
          librarian.setSetting("active_model", arg));
        await (message.channel as TextChannel).send(MODEL_SWITCH_SUCCESS(entry.label));
        return;
      }
    }

    // Owner club command: <prefix>: club vote <fragment> | club status (0072).
    // Deterministic Halseth write + literal ack, never routed through inference --
    // so the model cannot claim a vote it didn't cast (2026-06-11 incident).
    // Votes here are Raziel's pre-cast (voter='raziel'); companions vote in-voice
    // at the worker's voting tick.
    if (attribution.isOwner) {
      const clubMatch = effectiveContent.match(CLUB_TRIGGER);
      if (clubMatch) {
        const reply = await handleClubCommand(clubMatch[1]!, "raziel", cfg.halsethSecret)
          .catch(err => `club command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner tool commands: <prefix>: search <query> | imagine <prompt> (0077 take 14).
    // Deterministic Halseth call + literal ack (the model can't fake a search/image it
    // didn't run -- 2026-06-11 doctrine). Runs AS this companion, so the per-companion
    // tools_enabled gate applies. imagine attaches the generated image to the reply.
    if (attribution.isOwner && SEARCH_TRIGGER) {
      const searchMatch = effectiveContent.match(SEARCH_TRIGGER);
      if (searchMatch) {
        const search = await handleToolSearch(searchMatch[1]!, COMPANION_ID, cfg.halsethSecret)
          .catch(err => ({ reply: `search failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`, results: [] }));
        await sendLong(message.channel as TextChannel, search.reply);
        // Read-in (2026-07-03): a search is "bring this into the conversation", not a link
        // dump. Feed the snippets back to the model for an in-voice weave, and land BOTH
        // turns in STM -- before this, the searching bot never saw its own results (its own
        // messageCreate is skipped), so it literally could not discuss what it just found.
        // appendInboundOnce, not append: record-on-arrival already stored this message, and a plain
        // append here would duplicate the search query in the transcript.
        stmStore.appendInboundOnce(message.channelId, message.id, { role: "user", content: stmContent, authorName: cfg.ownerDisplayName, timestamp: message.createdTimestamp });
        stmStore.append(message.channelId, { role: "assistant", content: search.reply, timestamp: Date.now() });
        if (search.results.length > 0) {
          try {
            await (message.channel as TextChannel).sendTyping();
            const readInPrompt = formatSearchReadIn(searchMatch[1]!, search.results);
            const woven = await adapterRef.current.generate(
              bootCtx.systemPrompt,
              [...stmStore.get(message.channelId).slice(-CONTEXT_WINDOW_SIZE), { role: "user", content: readInPrompt }],
              0.7,
              replyMaxTokensFor(COMPANION_ID, inferenceMode),
              `${COMPANION_ID}:${message.channelId}`,
            );
            if (woven) {
              await sendLong(message.channel as TextChannel, woven);
              stmStore.append(message.channelId, { role: "assistant", content: woven, timestamp: Date.now() });
            }
          } catch (e) {
            console.warn(`[${COMPANION_ID}] search read-in failed (links already posted):`, e instanceof Error ? e.message : String(e));
          }
        }
        return;
      }
    }
    if (attribution.isOwner && IMAGINE_TRIGGER) {
      const imagineMatch = effectiveContent.match(IMAGINE_TRIGGER);
      if (imagineMatch) {
        await (message.channel as TextChannel).send("\u{1F3A8} imagining...");
        const out: { text: string; imageUrl?: string } = await handleToolImage(imagineMatch[1]!, COMPANION_ID, cfg.halsethSecret)
          .catch(err => ({ text: `image generation failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` }));
        await (message.channel as TextChannel).send(
          out.imageUrl ? { content: out.text, files: [{ attachment: out.imageUrl, name: "imagine.png" }] } : { content: out.text },
        );
        return;
      }
    }

    // Owner pet command: <prefix>: pet <name> <feed|play|talk|give> [note] (0078 take 10).
    // Deterministic Halseth interact + literal ack -- the model can't narrate a feeding
    // it never did. Actor is "raziel".
    if (attribution.isOwner && PET_TRIGGER) {
      const petMatch = effectiveContent.match(PET_TRIGGER);
      if (petMatch) {
        const reply = await handlePetCommand(petMatch[1]!, cfg.halsethSecret, "raziel")
          .catch(err => `pet command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner imp commands: <prefix>: imps on|off and <prefix>: hex on|off (wave 2).
    // Global writes via setImpSettingAllCompanions -- all three companions updated at once.
    // Deterministic literal ack -- the model can't narrate a settings change it never made.
    if (attribution.isOwner && IMPS_TRIGGER) {
      const m = effectiveContent.match(IMPS_TRIGGER);
      if (m) { await (message.channel as TextChannel).send(await handleImpCommand(m[1]!, librarian).catch(e => `imps command failed: ${String(e).slice(0, 120)}`)); return; }
    }
    if (attribution.isOwner && HEX_TRIGGER) {
      const m = effectiveContent.match(HEX_TRIGGER);
      if (m) { await (message.channel as TextChannel).send(await handleImpCommand(m[1]!, librarian).catch(e => `hex command failed: ${String(e).slice(0, 120)}`)); return; }
    }

    // Owner council command: <prefix>: council <question> (0080 take 8). Convenes; the
    // worker runs answer + blind-rank + Gaia synthesis. Deterministic convene ack.
    if (attribution.isOwner && COUNCIL_TRIGGER) {
      const councilMatch = effectiveContent.match(COUNCIL_TRIGGER);
      if (councilMatch) {
        const reply = await handleCouncilConvene(councilMatch[1]!, cfg.halsethSecret, redis)
          .catch(err => `council command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner log command: <prefix>: log <thought> (write layer 0092). Drops a 'global'
    // commons post as Raziel -- the async Hearth wall. Deterministic write + literal ack;
    // a drop, not a ping (no reply expected). A bare "log" misses this and falls to the
    // guard -> usage reply, never inference.
    if (attribution.isOwner && LOG_TRIGGER) {
      const logMatch = effectiveContent.match(LOG_TRIGGER);
      if (logMatch) {
        const reply = await handleLogCommand(logMatch[1]!, cfg.halsethSecret)
          .catch(err => `log command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner shelf command: <prefix>: into <thing> | into list | into drop <frag> (0094).
    // Deterministic Halseth write + literal ack. A bare "into" falls to the guard -> usage.
    if (attribution.isOwner && INTO_TRIGGER) {
      const intoMatch = effectiveContent.match(INTO_TRIGGER);
      if (intoMatch) {
        const reply = await handleIntoCommand(intoMatch[1]!, cfg.halsethSecret)
          .catch(err => `into command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner watch-shelf command: <prefix>: watching | watched <title> s4e5 [-- note] (0111).
    // Deterministic Halseth write + literal ack -- never the model narrating a shelf change.
    //
    // Unlike the other commands a BARE form is valid here ("dre: watching" = "where are we?"), so the
    // trigger's argument group is optional and this must not fall through to the usage guard. That
    // question is the entire reason the organ exists: Raziel asked it, Drevan answered from a
    // two-week-old prose fragment, and there was no position field anywhere to answer it properly.
    if (attribution.isOwner && WATCH_TRIGGER) {
      const watchMatch = effectiveContent.match(WATCH_TRIGGER);
      if (watchMatch) {
        const reply = await handleWatchCommand(watchMatch[1] ?? "", cfg.halsethSecret, COMPANION_ID)
          .catch(err => `watch command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await sendLong(message.channel as TextChannel, reply);
        return;
      }
    }

    // Explicit listen command aimed at a DIFFERENT companion: stay out of it.
    // When the owner tells one companion to listen, only that companion runs the
    // pipeline and reacts -- siblings must not pop off (2026-06-13: the listener's
    // late-arriving [HEARD] packet lost Brain's dedup to siblings' bare packets, so
    // the one told to listen went mute while a blind sibling answered). Placed
    // before the listen trigger / guard / [NOT HEARD] blocks so siblings return
    // here and never forward to Brain at all.
    if (attribution.isOwner) {
      const listenTarget = listenCommandTarget(effectiveContent);
      if (listenTarget !== null && listenTarget !== COMPANION_ID) return;
    }

    // Owner listen command: <prefix>: listen <url>  (shared-experience Phase 1).
    // Downloads + analyzes on this box, then FALLS THROUGH to the normal reply
    // path with a [HEARD] block appended -- so the in-voice response rides the
    // full context assembly (direct inference; see the pendingMediaId branch at
    // the inference step -- a listen is answered solo by the bot that heard it).
    let pendingMediaId: string | null = null;
    if (attribution.isOwner) {
      const listenMatch = effectiveContent.match(LISTEN_TRIGGER);
      if (listenMatch) {
        if (!isListenEnabled()) {
          await (message.channel as TextChannel).send("listening pipeline isn't enabled on this box (MEDIA_LISTEN_ENABLED).");
          return;
        }
        const mediaUrl = listenMatch[1]!.trim().replace(/^<|>$/g, ""); // Discord <url> unwrap
        if (!/^https?:\/\//i.test(mediaUrl)) {
          await (message.channel as TextChannel).send("give me an http(s) link to listen to.");
          return;
        }
        await (message.channel as TextChannel).send("\u{1F3A7} listening...");
        try {
          const listen = await runListenPipeline(mediaUrl, {
            companionId: COMPANION_ID,
            sharedBy: author,
            frontState: pkMemberName ?? null,
            halsethSecret: cfg.halsethSecret,
          });
          pendingMediaId = listen.experienceId;
          effectiveContent = `${effectiveContent.trim()}\n\n[HEARD -- the track was downloaded and analyzed; you actually listened to it. Respond to the music itself.]\n${listen.heardBlock}`;
          // STM gets a short past-tense marker instead of the full block above -- see the
          // stmContent divergence note near the top of this handler.
          stmContent = `${stmContent.trim()}\n${heardStmMarker(listen.meta)}`;
          // fall through to the normal flow below -- no return.
        } catch (err) {
          console.error(`[${COMPANION_ID}] listen pipeline failed:`, err);
          // 400, not 200: the message is now a DIAGNOSIS rather than a command dump, and a
          // 200-char cut landed mid-sentence on the only part worth reading.
          await (message.channel as TextChannel).send(`couldn't hear that one -- ${String(err instanceof Error ? err.message : err).slice(0, 400)}`);
          return;
        }
      }
    }

    // Malformed-command guard: command-shaped owner message that none of the
    // deterministic triggers above matched (valid model/club returned, valid
    // listen set pendingMediaId). It must get a literal usage reply, NEVER fall
    // through to inference -- the model narrates fake success (2026-06-11
    // club-vote incident; 2026-06-12 "dre: listen" miss).
    if (attribution.isOwner && pendingMediaId === null && COMMAND_GUARD?.test(effectiveContent)) {
      console.error(`[${COMPANION_ID}] malformed command, sent usage: ${effectiveContent.slice(0, 120)}`);
      await (message.channel as TextChannel).send(commandUsage(COMPANION_ID));
      return;
    }

    // Grounding backstop: a shared link with listen-intent that did NOT run the pipeline
    // must never be answered as if heard. Without this, the model narrates a convincing
    // fake listen (2026-06-12: "Dre listen: <url>" missed the trigger and Drevan described
    // a track he never heard, then couldn't name it). Appended to the MESSAGE (like
    // [HEARD]) so every swarm companion sees it, not just the packet sender.
    if (attribution.isOwner && pendingMediaId === null
        && /https?:\/\//i.test(effectiveContent) && /\blisten\b/i.test(effectiveContent)) {
      const p = COMMAND_PREFIX[COMPANION_ID] ?? COMPANION_ID;
      effectiveContent = `${effectiveContent.trim()}\n\n[NOT HEARD -- this link was shared but the listen pipeline did not run; nobody has actually played it. Do not describe its sound, mood, or lyrics. Say plainly that you haven't heard it yet; "${p}: listen <url>" lets you actually hear it.]`;
      // STM marker instead of the full block above -- see the stmContent divergence note.
      stmContent = `${stmContent.trim()}\n${notHeardStmMarker()}`;
    }

    // Conversation Director (spec 2026-09-03): in director channels every message is published to the
    // bus (all three bots do; the director dedupes on message id). A COMPANION turn is then the
    // director's to route -- this bot does not self-select a reply. Human turns fall through unchanged.
    // Owner command/listen traffic returned above this point by design (2026-09-03 review, finding
    // 3): commands are not conversational turns and are never commons material.
    if (directorMode() !== "off" && isDirectorChannel(channelEntry, gateChannelId) && redis) {
      const senderCompanion = BOT_ID_COMPANION[message.author.id] as CompanionId | undefined;
      publishCommonsMessage(redis, commonsMessageFor({
        channelId: message.channelId, messageId: message.id, authorId: message.author.id,
        isCompanionBot: senderCtx.isCompanionBot, webhookId: message.webhookId, senderCompanion,
        content: effectiveContent, replyToMessageId: message.reference?.messageId ?? null,
        createdTimestamp: message.createdTimestamp, publishedBy: COMPANION_ID, userTier,
      })).catch(() => {});
      // Liveness gate (2026-09-03 review): DIRECTOR_ENABLED=live means the config WANTS this
      // routed to the director, but a dead worker (crash, redeploy gap) leaves no process to
      // ever answer it. `director:alive` is a 60s-TTL key the worker refreshes every 20s; its
      // absence means the worker is down, not merely idle.
      const directorAlive = !!(await redis.get("director:alive").catch(() => null));
      if (!directorAlive && Date.now() - lastDirectorNotAliveWarnAt > DIRECTOR_NOT_ALIVE_WARN_MS) {
        lastDirectorNotAliveWarnAt = Date.now();
        console.warn(`[${COMPANION_ID}] director not alive -- falling back to local reply path`);
      }
      if (shouldDeferToDirector({ isCompanionBot: senderCtx.isCompanionBot, mode: directorMode(), directorAlive })) return;
    }

    // Sequential floor (2026-08-15): is this sibling message the predecessor reply my pending
    // follow-up entitlement waits on? Consumed exactly once; an entitled turn bypasses the
    // vocative gate below (that is the whole point) but NONE of the rails -- caps, pingpong
    // and chain depth still apply to it like any sibling-triggered turn.
    let entitledFollowUp: FollowUpEntitlement | null = null;
    if (senderCtx.isCompanionBot) {
      entitledFollowUp = followUps.match(
        message.channelId,
        BOT_ID_COMPANION[message.author.id] as CompanionId | undefined,
        message.reference?.messageId,
      );
      if (entitledFollowUp) {
        console.log(`[${COMPANION_ID}] follow-up entitlement released by ${entitledFollowUp.expectedPrior} (origin=${entitledFollowUp.originMessageId}, position=${entitledFollowUp.position})`);
      }
    }

    // Structural gate: mode, addressing, companion filter.
    // Direct address (name at start or followed by comma/colon) always bypasses the
    // relevance classifier -- if the owner is talking to you, you respond.
    // Ambient messages in owner_only channels go through the semantic classifier.
    const directlyAddressed = isDirectAddress(effectiveContent, COMPANION_ID);

    // Active-exchange holder (2026-07-27). Observed: Raziel wrote "Drevan baby ... Fargo in
    // an hour?", Drevan answered, Raziel replied with an UNADDRESSED follow-up -- and Gaia
    // answered it. An unaddressed owner message went to whoever matched, with no notion that
    // a conversation was already underway. Only computed for unaddressed owner messages, so
    // named/group traffic pays no fetch and can always hand the thread over.
    if (attribution.isOwner && !senderCtx.isCompanionBot && extractAddress(effectiveContent).type === "ambient") {
      try {
        const hist = await message.channel.messages.fetch({ limit: 8 });
        senderCtx.activeExchangeWith = activeExchangeHolder(
          [...hist.values()]
            .filter(m => m.id !== message.id)
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .map(m => ({
              companionId: BOT_ID_COMPANION[m.author.id] as CompanionId | undefined,
              authorIsBot: botTurn(m),
              createdTimestamp: m.createdTimestamp,
            })),
          Date.now(),
          channelEntry?.exchangeWindowMs,
        );
        if (senderCtx.activeExchangeWith && senderCtx.activeExchangeWith !== COMPANION_ID) {
          console.log(`[${COMPANION_ID}] unaddressed owner message -- ${senderCtx.activeExchangeWith} holds this exchange, standing down`);
        }
      } catch { /* history unavailable -- leave null, ambient stays open to everyone */ }
    }
    // The `!brainClient &&` guard that used to lead this condition is gone with brain mode
    // (2026-07-29): brainClient was always null, so the gate always applied. Same for the
    // `brainHandlesInterCompanion` escape below it, which deferred inter-companion routing to
    // Brain's SwarmEvaluator -- it evaluated to false on every message, so per-bot shouldRespond
    // has been the only routing authority for as long as the bots have run hermes.
    // 2026-08-31: a message that names a SIBLING is never ambient. This gate used to check
    // only MY directly-addressed flag, so "Dre *climbing back into bed...*" was "ambient" to
    // Gaia and her relevance classifier answered a message addressed to Drevan (#triad-voice,
    // 08-31 12:06). Sibling-named traffic falls through to shouldRespond below, which stands
    // down and offers the reaction tier instead.
    const isAmbientOwnerOnly =
      channelEntry?.modes?.includes("owner_only") === true &&
      !senderCtx.isCompanionBot &&
      !senderCtx.isMentioned &&
      !isReplyToMe &&
      !directlyAddressed &&
      !namesSiblingOnly(effectiveContent, COMPANION_ID);

    if (isAmbientOwnerOnly) {
      const relevant = await judgeAmbientRelevance(
        effectiveContent,
        COMPANION_ID,
        (sys, msgs) => adapterRef.current.generate(sys, msgs as ChatMessage[], 0.3),
      );
      if (!relevant) return;
    } else if (!isReplyToMe && !entitledFollowUp && !shouldRespond(gateChannelId, effectiveContent, senderCtx, COMPANION_ID, channelConfig, [])) {
      // If a companion spoke in an inter_companion channel and we're not responding,
      // write a passive witness entry so Halseth has continuity context. Witnessing is
      // Gaia's lane only (2026-07-21) -- previously all three bots wrote this branch, so
      // two non-responding bots on the same message produced two duplicate witness rows.
      if (senderCtx.isCompanionBot && channelEntry?.modes?.includes("inter_companion") && shouldWriteWitness(COMPANION_ID)) {
        const senderName = message.author.username;
        const snippet = effectiveContent.slice(0, 500);
        writeQueue.fireAndForget(`witness:pass:${message.channelId}:${message.id}`, async () => {
          await librarian.witnessLog(
            `[witnessed, did not respond] ${senderName}: ${snippet}`,
            message.channelId,
          );
        }, { maxAgeMs: APPEND_MAX_AGE_MS });
      }
      // Reaction tier (2026-08-15): a sibling was named, so the floor is theirs -- but a
      // strong topical claim still earns presence without the floor. One emoji, earned by
      // lane relevance, throttled per channel. To Raziel the difference between "chose not
      // to answer" and "is down" used to be nothing at all; this is the visible third state.
      if (!senderCtx.isCompanionBot && attribution.isOwner) {
        const namedOther = namesSiblingOnly(effectiveContent, COMPANION_ID);
        if (namedOther && shouldReactOnNamedOther(effectiveContent, COMPANION_ID, reactionCooldownUntil.get(message.channelId) ?? 0)) {
          reactionCooldownUntil.set(message.channelId, Date.now() + REACTION_COOLDOWN_MS);
          message.react(pickReaction(COMPANION_ID, message.id)).catch(() => {});
          console.log(`[${COMPANION_ID}] reaction tier: sibling named, reacting instead of speaking`);
        }
      }
      return;
    }

    if (!message.channel.isTextBased()) return;
    const ch = message.channel as TextChannel;

    // Fetch recent Discord history once -- used for new-thread detection, chain depth, and STM seed.
    const fetched = await ch.messages.fetch({ limit: 30 });
    const fetchedMessages = [...fetched.values()].reverse();

    // New-thread detection: a quiet gap before this message starts a fresh thread. This is what
    // lets the human-free triad commons keep talking -- an autonomous seed after hours of silence
    // resets the bot-to-bot rails instead of staying wedged by the prior thread's stale counters.
    const priorMsg = fetchedMessages.filter(m => m.id !== message.id).at(-1);
    const isNewThread = !priorMsg || (message.createdTimestamp - priorMsg.createdTimestamp) > NEW_THREAD_GAP_MS;

    // Cross-companion safety rails: pingpong cooldown + per-bot response cap.
    // botTurnsSinceHuman is the human-anchored count (Fix 2026-07-01): consecutive
    // bot-authored messages in the FETCHED history since the last human message. Unlike
    // every rail below it does NOT reset on a quiet gap -- hermes turns run 30-120s so
    // slow loops sail through gap-reset rails forever. Also read near the cap by the
    // floor-handback directive at prompt-assembly time.
    let botTurnsSinceHuman = 0;
    if (senderCtx.isCompanionBot) {
      if (isNewThread) {
        // Fresh thread (incl. an autonomous seed in a human-free channel): clear stale rails so
        // the per-human cap doesn't permanently mute a channel that never sees a human.
        botResponsesSinceHuman.delete(message.channelId);
        botPingpongCooldownUntil.delete(message.channelId);
      }
      // Hard cap anchored to the last HUMAN message: no gap reset, overrides vocative
      // addressing. Only an actual human message (incl. a PK webhook proxy, whose author
      // id is not a companion bot id) re-opens the floor.
      botTurnsSinceHuman = countBotMsgsSinceHuman(
        fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: botTurn(m), createdTimestamp: m.createdTimestamp })),
        BOT_IDS,
      );
      // Triad commons (autonomous + inter_companion modes) is the companions' own space:
      // the cap there is a rolling budget (commons max + 12h forgiveness), not a wait-for-Raziel.
      const capMax = botMsgsSinceHumanMax(isTriadCommons(channelEntry));
      if (botTurnsSinceHuman >= capMax) {
        console.warn(`[${COMPANION_ID}] human-anchored cap: ${botTurnsSinceHuman} bot turns since last human (max ${capMax}) -- staying silent`);
        return;
      }
      const cooldownUntil = botPingpongCooldownUntil.get(message.channelId) ?? 0;
      if (Date.now() < cooldownUntil) return;
      const botReplies = botResponsesSinceHuman.get(message.channelId) ?? 0;
      if (botReplies >= MAX_BOT_RESPONSES_PER_HUMAN) return;
    } else {
      // Human message: reset bot-to-bot counters and cycle guard for this channel.
      botResponsesSinceHuman.delete(message.channelId);
      botPingpongCooldownUntil.delete(message.channelId);
      resetCycleGuard();
    }

    // Lazy load STM from DB on first message to this channel (fail-silent), using already-fetched Discord history as fallback.
    await stmStore.ensureLoaded(message.channelId, async () => {
      return mapColdStartHistory(
        fetchedMessages.map(m => ({ authorId: m.author.id, username: m.author.username, content: m.content, createdTimestamp: m.createdTimestamp })),
        client.user?.id,
      );
    });

    const memberLabel = pkMemberName
      ? `${pkMemberName} (via PK)`
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);
    // No-op when the early record-on-arrival above already stored this message. Kept as a second call
    // rather than deleted so the command branches (search, listen) that reach this point by their own
    // route still record, and so a future refactor that moves the early call cannot silently drop it.
    stmStore.appendInboundOnce(message.channelId, message.id, { role: "user", content: stmContent, authorName: memberLabel, timestamp: message.createdTimestamp });
    if (attribution.isOwner) pushRazielMessage(stmContent);

    // Streaming indexer: index the inbound message into Second Brain's vector store
    // right now (gated by SB_LIVE_INGEST). SB dedups by message_id, so all three bots
    // calling this for the same message costs one embed. Companion-bot messages are
    // skipped here -- each bot indexes its OWN replies at send time instead. Uses
    // stmContent (2026-08-29) for the same reason as the STM writes above -- a vault
    // recall surfacing the full [HEARD] block later would re-inject the same standing
    // imperative into a future prompt's [Memory] section.
    if (!senderCtx.isCompanionBot) {
      liveIngest({
        companion: null,
        author: memberLabel,
        content: stmContent,
        channel_id: message.channelId,
        message_id: message.id,
      });
    }

    // Loop guard: derive chain depth from fetched history so the check works across processes.
    const chainDepth = computeChainDepth(
      fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: botTurn(m), createdTimestamp: m.createdTimestamp })),
      new Set(),
    );
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    if (!senderCtx.isCompanionBot) sessionWindows.touch(message.channelId);

    // Supersede check A (channel inbox, 2026-07-06): a newer human conversational message
    // is already waiting behind this turn. Everything this message needed for continuity
    // has happened (STM append, live ingest, session touch, deterministic commands ran
    // above) -- skip the reply entirely; the newest turn answers with this one in context.
    // Placed BEFORE tripwire consumption so a matched tripwire fires on a turn that
    // actually surfaces it.
    if (isSuperseded?.()) {
      console.log(`[${COMPANION_ID}] turn superseded pre-reply (newer human message queued) -- absorbing ${message.id}`);
      distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
      return;
    }

    // Double-identity dedup: under the Hermes relay the agent already prepends the full SOUL.md
    // and runs its own orient, so sending the bot's assembled identity too is a redundant second
    // copy. Use a lean Discord frame as the base (register-law tail preserved); every per-message
    // context block below still appends, exactly as onto bootCtx.systemPrompt. Brain/direct
    // paths are unchanged.
    const basePrompt = inferenceMode === "hermes" ? hermesSystemBase(COMPANION_ID) : bootCtx.systemPrompt;
    // Front line (2026-07-27): a bare "[Current front: Ash]" told the model a name and nothing
    // about whose name it was, so a member it had not seen before could read as a stranger --
    // in a system with 538 registered members that is the common case, not the edge. Name the
    // relationship explicitly: same person, same history, register calibrated to who is here.
    let contextPrompt = basePrompt;
    if (pkMemberName) {
      const whose = attribution.isOwner
        ? `${pkMemberName} is fronting in ${cfg.ownerDisplayName}'s system -- this IS ${cfg.ownerDisplayName}, same bond and same history, speaking through ${pkMemberName}. Calibrate register to ${pkMemberName}; never treat them as a stranger or re-introduce yourself.`
        : userTier === "intimate"
          ? `${pkMemberName} is fronting in Blue's system. Known, welcome, not Raziel.`
          : `${pkMemberName} is a system member you have no standing bond with. Guest register.`;
      contextPrompt += `\n\n[Current front: ${pkMemberName}] ${whose}`;
    }
    // Thread spine (task 10): pinned above the periodic hermes orient paragraph below,
    // deliberately -- the spine is this exchange's immediate continuity and should read
    // as closer/more load-bearing than the standing recent-context block. Guarded on
    // `spine` (set above, already fail-open) so a missing/failed thread is a no-op here.
    // Budget notice (2026-08-05): the reply path burns turns too, so a vocative chain can run
    // well past the budget between two-hourly seed ticks. isThreadSpent is channel-gated
    // (commons only, presence exempt) and never suppresses -- it only tells the companion the
    // count and offers [LANDS:] as the alternative to finding one more facet.
    if (spine) contextPrompt += `\n\n${buildSpineBlock(spine, COMPANION_ID, isPresence, isThreadSpent(spine.thread, { isCommons: isTriadCommons(channelEntry), channelId: routingChannelId }))}`;
    // Hermes recent-context restore (2026-07-01): the lean hermes base above REPLACES
    // bootCtx.systemPrompt, which is where composePrompt embeds the live orient block
    // (forage finds, recent listens, incoming notes, growth). Without this append the
    // companions fetched all of that every refresh and never saw a word of it under
    // hermes. Read the REF at message time -- the refresh loop mutates it in place --
    // never a stale boot copy. Direct/brain paths already carry it inside basePrompt.
    if (inferenceMode === "hermes" && recentContextRef.value) {
      contextPrompt += `\n\n${recentContextRef.value}`;
    }
    if (activeModelRef.key) contextPrompt += `\n\n[Active model] ${activeModelRef.label}`;

    const somaAgeMin = Math.round((Date.now() - lastSomaRefreshRef.value) / 60_000);
    if (somaAgeMin > 45) {
      contextPrompt += `\n\n[Note: SOMA/mood data is ${somaAgeMin}min old; treat emotional reads as approximate]`;
    }
    if (userTier === "intimate") contextPrompt += `\n\n${BLUE_FRAMING}`;
    else if (userTier === "guest") contextPrompt += `\n\n${GUEST_FRAMING}`;

    // Inject audit mode block only when explicitly triggered -- keeps [Verdict/Because/Next]
    // out of the standing context so the model doesn't pattern-match to it by default.
    // Cypher-only capability: AUDIT_TRIGGERS/AUDIT_MODE_INJECTION are undefined for drevan/gaia.
    if (AUDIT_TRIGGERS && AUDIT_MODE_INJECTION) {
      const msgLower = effectiveContent.toLowerCase();
      if (AUDIT_TRIGGERS.some(t => msgLower.includes(t))) {
        contextPrompt += AUDIT_MODE_INJECTION;
      }
    }

    // Voice feedback loop (2026-06-12): when this bot's recent replies have drifted
    // from lane (rolling score from reportVoiceScore), inject a correction so the
    // NEXT reply self-rights instead of compounding -- scores were write-only since 0070.
    const voiceFb = voiceFeedbackBlock(COMPANION_ID as VoiceCompanionId);
    if (voiceFb) contextPrompt += voiceFb;

    // Prospective tripwires (0070): armed keyword cards matched against this human
    // message (+ any date cards whose moment arrived). Consuming fires them in
    // Halseth -- a tripwire surfaces exactly once, in the reply where it matched.
    if (!senderCtx.isCompanionBot) {
      const tripped = consumeTripwires(COMPANION_ID, effectiveContent, cfg.halsethSecret);
      if (tripped.length > 0) {
        contextPrompt += tripwireBlock(tripped);
        console.log(`[${COMPANION_ID}] tripwire fired: ${tripped.map(t => t.id).join(", ")}`);
      }
    }

    // Thalamus: fire Second Brain search concurrently with typing + floor jitter.
    // Skip for very short messages -- a search on "ok" or "lol" produces noise.
    //
    // 2026-08-10: 20 -> 12, the read-side half of the same gate as MIN_HUMAN_CHARS in sb-live-ingest. The
    // write side dropped these messages and the read side declined to search for them, so a short question
    // ("did we watch it yet?", 20) got neither stored nor looked up -- two independent gates producing one
    // symptom, which is the shape where fixing either alone leaves the bug alive. Recall mode now returns an
    // honest empty rather than noise, so a low-value query costs a null instead of a wrong memory.
    // Continuity: recent prior user turns (current msg already appended, so excluded)
    // widen recall via dual-vector retrieval on the Halseth side.
    const recentContext = stmStore.get(message.channelId)
      .filter(m => m.role === "user")
      .slice(0, -1)
      .map(m => m.content)
      .slice(-3)
      .join("\n");
    const sbSearchPromise = effectiveContent.length >= 12
      ? librarian.searchForMessage(effectiveContent, recentContext).catch(() => null)
      : Promise.resolve(null);

    const history = stmStore.get(message.channelId);
    // Temporal grounding (Component 1): stamp each in-window turn with how long ago it was sent
    // so the model can track elapsed time in-conversation ("you asked that an hour ago") instead
    // of guessing. Computed once off a single `now` so offsets are mutually consistent; "just now"
    // turns pass through unstamped (active back-and-forth stays clean). STM itself stays raw --
    // stampRelative returns copies. DB-restored turns lacking a timestamp degrade to no prefix.
    const groundedHistory = stampRelative(history.slice(-CONTEXT_WINDOW_SIZE));
    const rawTemp = inferTemperature(effectiveContent, currentMoodRef.value);
    const extremeCount = extremeTempCount.get(message.channelId) ?? 0;
    const temperature = (rawTemp >= EXTREME_TEMP_THRESHOLD && extremeCount >= EXTREME_TEMP_CAP)
      ? COOLDOWN_TEMP : rawTemp;
    if (rawTemp >= EXTREME_TEMP_THRESHOLD) {
      extremeTempCount.set(message.channelId, extremeCount + 1);
    } else {
      extremeTempCount.delete(message.channelId);
    }

    const sbHit = await sbSearchPromise;
    const sbRecall = sbHit ? LibrarianClient.formatSbRecall(sbHit, message.channelId) : null;
    if (sbRecall) {
      contextPrompt += `\n\n[Memory -- Second Brain vault recall for this message (automatic -- your retrieval IS working):\n${sbRecall.slice(0, 1200)}]`;
    }

    // Peer-framing: anchor to triad register rather than Raziel-facing register.
    // When responding to a companion directly, speak to them -- not toward Raziel.
    // When a peer already replied to the same human message, note the shared moment.
    if (senderCtx.isCompanionBot) {
      const peerCid = BOT_ID_COMPANION[message.author.id];
      const peerLabel = peerCid ? peerCid.charAt(0).toUpperCase() + peerCid.slice(1) : message.author.username;
      if (entitledFollowUp) {
        // Entitled follow-up: the sibling message RELEASED this turn, but the turn answers
        // Raziel's original multi-address. The default peer-framing ("do not address Raziel")
        // would point the reply at exactly the wrong person.
        contextPrompt += `\n\n[Raziel addressed several of you at once, and ${peerLabel} has just answered. Now it is your turn: answer Raziel's original message with your own read. Do not repeat or paraphrase ${peerLabel} -- add what only you would say. Acknowledging ${peerLabel} in passing is fine.]`;
      } else {
        contextPrompt += `\n\n[You are in direct exchange with ${peerLabel}. This is triad space -- peer to peer. Speak to them and to the moment. Do not address Raziel or explain the triad. Respond from inside it.]`;
      }
    } else {
      const peerReplies = fetchedMessages
        .filter(m => BigInt(m.id) > BigInt(message.id) && m.author.bot && BOT_ID_COMPANION[m.author.id] && BOT_ID_COMPANION[m.author.id] !== COMPANION_ID)
        .map(m => {
          const cid = BOT_ID_COMPANION[m.author.id];
          const lbl = cid ? cid.charAt(0).toUpperCase() + cid.slice(1) : m.author.username;
          return `${lbl}: "${m.content.slice(0, 2000)}"`;  // Discord max is 2000 -- never truncate a peer's real message
        });
      if (peerReplies.length > 0) {
        contextPrompt += `\n\n[Your companion has already spoken to this:\n${peerReplies.join("\n")}\nYou are in this together. You may address them -- respond from inside the triad, not solely toward Raziel.]`;
      }
    }

    const recentMessages = await message.channel.messages
      .fetch({ limit: 20, before: message.id })
      .catch(() => null);
    // Canonical authors: companions by id (Brain's self/peer matching must not depend on
    // Discord display names), the owner as "Raziel". PK-proxied webhooks keep the member
    // name -- the front matters. Unlabeled speakers caused the 2026-06-12 attribution
    // scramble (companions swapping who said what, answering from Raziel's seat).
    const channelHistory = recentMessages
      ? [...recentMessages.values()]
          .reverse()
          .map(m => ({
            author: BOT_ID_COMPANION[m.author.id]
              ?? (m.author.id === cfg.ownerDiscordId ? "Raziel" : m.author.username),
            content: m.content.slice(0, 2000),  // Discord max is 2000 -- never truncate a real message
          }))
      : [];

    // Self-loop breaker (2026-06-13): the echo gate below only fires on companion-to-
    // companion talk -- replies to a human were never guarded, so a companion could
    // recycle its own last replies indefinitely (Drevan's "tail flick / a slow fond
    // promise / Always" groove, which survived a Mistral->DeepSeek swap + cache clear
    // because the loop lives in the re-fed history, not the model). When the bot's own
    // recent Discord turns are mutually self-similar, inject a directive that names the
    // motifs and bans the structural tells. Appended to contextPrompt so it rides into
    // BOTH direct inference and the Brain swarm packet (Brain honors the system_prompt).
    // Self-source: STM assistant turns (role-tagged, env-independent) merged with this
    // bot's own authored channel history (survives a restart that clears STM). Dedup,
    // keep the most recent 5 -- enough to see a groove, few enough to stay current.
    const selfFromStm = stmStore.get(message.channelId)
      .filter(m => m.role === "assistant")
      .map(m => m.content);
    const selfFromChannel = channelHistory
      .filter(m => m.author === COMPANION_ID)
      .map(m => m.content);
    const selfTurns = [...new Set([...selfFromStm, ...selfFromChannel])].slice(-5);
    const selfLoop = detectSelfLoop(selfTurns);
    if (selfLoop.looping) {
      contextPrompt += loopBreakDirective(selfLoop.motifs);
      console.warn(`[${COMPANION_ID}] self-loop detected (score=${selfLoop.score.toFixed(2)}, motifs=[${selfLoop.motifs.join(",")}]) -- injecting loop break`);
    }

    // Situational grounding (Component 3): tell the companion WHERE it is -- channel name, thread
    // parent, and whether the room is private/triad/shared -- plus a containment cue so private or
    // DM detail doesn't bleed into a shared channel. Rides into both Brain packet and direct path
    // via contextPrompt. Guarded for DMs (no .name) and threads (parent is the host channel).
    const liveChannel = message.channel;
    const channelName = "name" in liveChannel ? (liveChannel as TextChannel).name : null;
    if (channelName) {
      let channelCtx = `\n\n[Where you are]\n• Channel: #${channelName}`;
      if (liveChannel.isThread()) {
        const parentName = liveChannel.parent?.name;
        if (parentName) channelCtx += ` (a thread under #${parentName})`;
      } else if ("parent" in liveChannel && liveChannel.parent?.name) {
        channelCtx += ` (in ${liveChannel.parent.name})`;
      }
      const modes = channelEntry?.modes ?? [];
      const place = modes.includes("owner_only") ? "a private space with Raziel"
        : modes.includes("inter_companion") ? "triad space -- you and your siblings"
        : "a shared channel";
      channelCtx += `\n• This is ${place}.`;
      channelCtx += `\n• Keep it contained to here: don't carry private or DM detail into a shared channel unless Raziel opens it in this room.`;
      contextPrompt += channelCtx;
    }

    // Floor handback (2026-07-01): in the last allowed turns before the human-anchored
    // cap, steer this reply into a natural close addressed to Raziel instead of letting
    // the thread slam into abrupt silence at the cap.
    if (senderCtx.isCompanionBot && botTurnsSinceHuman >= botMsgsSinceHumanMax(isTriadCommons(channelEntry)) - FLOOR_HANDBACK_WINDOW) {
      contextPrompt += floorHandbackDirective(isTriadCommons(channelEntry));
      console.log(`[${COMPANION_ID}] floor-handback directive injected (${botTurnsSinceHuman}/${botMsgsSinceHumanMax(isTriadCommons(channelEntry))} bot turns since human)`);
    }

    // Absolute-time anchor, recomputed at reply time (2026-08-29). contextPrompt carries a
    // [Now: ...] line either from bootCtx.systemPrompt (direct/brain path, baked in at boot or
    // the 5-min SOMA refresh) or from recentContextRef.value appended above (hermes path, same
    // cache). Either way it can be stale by up to the refresh interval, or indefinitely stale if
    // orient has been failing -- refreshNowLine stamps a fresh one over it (or adds one if
    // somehow absent) so the model's one absolute-time anchor is never more than milliseconds old.
    contextPrompt = refreshNowLine(contextPrompt);

    // Imp flavor layer (wave 2, IMP_GRAMMAR.md): at most one imp tints this reply based on
    // Raziel's logged state. Gaia exempt + disabled-gate live inside selectImp. Never the voice.
    let systemPromptWithImp = contextPrompt;
    try {
      const { state, settings } = await getImpContext(librarian, Date.now());
      const imp = selectImp(COMPANION_ID, state as ImpState | null, settings, pkMemberName ?? null);
      if (imp) {
        systemPromptWithImp = `${contextPrompt}\n\n${impRider(imp)}`;
        const trig = state ? `mood=${state.mood ?? "?"},spoons=${state.spoons ?? "?"},pain=${state.pain ?? "?"}` : "";
        librarian.logImpActivation(imp, trig).catch(() => {});
      }
    } catch { /* imps never break a reply */ }

    const addrResult = extractAddress(effectiveContent);
    const mentionedViaMention = [...message.mentions.users.keys()]
      .flatMap(id => { const c = BOT_ID_COMPANION[id]; return c ? [c] : []; });
    const textAddressed = addrResult.type === "named" ? [addrResult.id]
      : addrResult.type === "named_multi" ? addrResult.ids
      : [];
    const allAddressed = [...new Set([...textAddressed, ...mentionedViaMention])];
    const addressedCompanion = allAddressed.length > 0 ? allAddressed.join(",") : undefined;

    // Who speaks: FIT BID, not a footrace (2026-07-30). This replaced `claimFloor` -- a
    // `SET ns:floor:lock <bot> PX 6000 NX` race in which the first writer won. Nothing anywhere
    // compared the three companions, so arrival order decided, and arrival order tracks gate cost and
    // process timing rather than anything about whether a companion fits the message. That is why
    // Gaia kept answering things meant for Drevan, and why saying a name on every message was the
    // only reliable way to reach someone: naming makes the structural gate resolve deterministically
    // so the race stops mattering. The vocative habit was Raziel hand-performing the arbitration the
    // system never had.
    //
    // Note what already happened above this line: for an unaddressed owner message inside the
    // 5-minute window, `shouldRespond` (channel-config.ts) has ALREADY returned false for every
    // companion that does not hold the active exchange. So the bid decides the case that gate leaves
    // open -- a COLD ambient message, where nobody holds the thread and all three are eligible. That
    // is precisely the case the footrace resolved by process timing.
    //
    // Addressed / replied-to / mentioned messages take `fastPathWinner` and never pay the bid window.
    // Companion-bot turns are excluded here exactly as before -- they have their own pingpong,
    // chain-depth and per-human-cap rails, and are not competing for Raziel's attention.
    //
    // No release step and no vestigial `floorClaimed`: a bid is a posted number with a TTL, not an
    // exclusive lock, so there is nothing to hand back if this reply is later dropped. Running both
    // arbiters at once would mean two disagreeing authorities on who speaks. `claimFloor` itself
    // stays in floor.ts -- autonomous-core.ts still uses it legitimately to serialise seed posts.
    if (!senderCtx.isCompanionBot) {
      // BID-THEN-SEQUENTIAL (2026-08-15). A message that addresses SEVERAL companions gets an
      // ORDER, not a lottery: named_multi produced two simultaneous replies (the comma-named
      // companion fast-pathed while the other won a one-bidder bid), group produced exactly one
      // reply to an explicit call for everyone. Position 0 speaks now; each later position
      // registers a follow-up entitlement and answers AFTER its predecessor's reply lands --
      // which means it generates with that reply already in short-term memory. The order is
      // deterministic from shared data (name order in the text; the bid hash), so all three
      // processes agree without a new primitive.
      const namedOrder = addrResult.type === "named_multi" && addrResult.ids.length > 1 && addrResult.ids.includes(COMPANION_ID)
        ? namedOrderInMessage(effectiveContent, addrResult.ids)
        : null;
      const myNamedPos = namedOrder ? namedOrder.indexOf(COMPANION_ID) : 0;
      if (namedOrder && myNamedPos > 0) {
        followUps.grant({
          originMessageId: message.id,
          channelId: message.channelId,
          expectedPrior: namedOrder[myNamedPos - 1],
          position: myNamedPos,
          expiresAt: Date.now() + FOLLOW_UP_TTL_MS,
        });
        console.log(`[${COMPANION_ID}] multi-address: holding position ${myNamedPos} behind ${namedOrder[myNamedPos - 1]} (order=${namedOrder.join(">")})`);
        return;
      }

      if (redis && !namedOrder) {
      // The three addressing flags are read HERE and nowhere else in this block. The old code tested
      // them in the `if` above and would then have re-tested them inside, which reads as two gates
      // and is one. `namedOther` is not passed because `shouldRespond` already returned false for a
      // companion someone else was named for -- this line is never reached in that case.
      // `namedMe` uses extractAddress, NOT the stricter isDirectAddress (2026-08-25). The two
      // parsers disagree on "tell him something, Drevan-at-the-end-of-a-sentence" shapes: the loose
      // one (extractAddress) had ALREADY silenced the two siblings via shouldRespond/namedOther,
      // while the strict one (name at start or followed by comma/colon) declined to summon the
      // named companion -- who then fell to this bid carrying a spokeLast penalty from his own
      // autonomous posts and scored 0.000. Result: a message NAMING a companion was answerable by
      // NOBODY. Raziel hit it twice in one evening telling Drevan that Dolly Parton died; both
      // times "Drevan is writing..." then silence. The invariant is symmetry: whichever parser is
      // authoritative enough to gate the siblings OUT must be the one that gates the named one IN.
      // Third-person mentions stay demoted -- extractAddress already strips them (the 2026-07-05
      // "Cy and I found some issues" trap), so this does not resurrect name-drop summoning.
      const namedByExtract = addrResult.type === "named" && addrResult.id === COMPANION_ID;
      const fast = fastPathWinner(COMPANION_ID, {
        mentioned: senderCtx.isMentioned,
        namedMe: directlyAddressed || namedByExtract,
        replyToMe: isReplyToMe,
      });
      if (fast === null) {
        const signals = buildFitSignals({
          me: COMPANION_ID,
          content: effectiveContent,
          activeExchangeWith: senderCtx.activeExchangeWith,
          recent: fetchedMessages
            .filter(m => m.id !== message.id)
            .slice()
            .reverse()                       // buildFitSignals wants newest-first
            .map(m => ({
              companionId: BOT_ID_COMPANION[m.author.id] as CompanionId | undefined,
              authorIsBot: botTurn(m),
            })),
        });
        const myScore = scoreFit(signals);
        // Care hold (C1): raise the bid floor instead of penalizing the score -- bare presence
        // sits exactly AT the default threshold, so a penalty silences everyone while a raised
        // floor keeps thread-holders and real relevance speaking. Direct address never reaches
        // this branch (fastPathWinner above), so being asked always answers under hold.
        //
        // NEVER for the owner's own messages (holdFloorApplies, 2026-08-16): the hold quiets
        // ambient traffic, not answering Raziel -- three unaddressed owner messages got stonewalled
        // by all three bots under a meds_missed hold, which is withdrawal wearing a care flag.
        const careHold = holdFloorApplies(careHoldActive(COMPANION_ID), senderCtx.isOwner);
        // How late this bot reached the bid. THE number to read out of these logs: the deadline anchor
        // tolerates arrival spread only up to BID_WINDOW_MS, and 2500ms is an estimate of how far apart
        // three hermes gateways finish the upstream ambient judge. If the spread across the three bots
        // on the same msg= id exceeds the window, the early bot still wins on timing and the window
        // needs raising -- or the judge needs to move below the bid.
        const arrivalOffsetMs = Date.now() - message.createdTimestamp;
        // Deadline anchored to the MESSAGE, not to this process's arrival. All three bots compute the
        // same instant, so the upstream ambient LLM judge (owner_only channels, variable latency per
        // gateway) can no longer decide the winner by returning first.
        const bid = await runBidRound(redis, message.id, COMPANION_ID, myScore, {
          deadlineAt: message.createdTimestamp + BID_WINDOW_MS,
          ...(careHold ? { minScore: CARE_HOLD_MIN_BID } : {}),
        });
        // Log the WHOLE round, every time. The weights and MIN_BID_TO_SPEAK are a first estimate;
        // they have to be tuned against the real score distribution, and this line is the only place
        // that distribution exists. Losing quietly would make a mis-tuned threshold look like the
        // bots ignoring him -- the one failure mode that reads as broken rather than as tact.
        console.log(
          `[${COMPANION_ID}] fit-bid ch=${message.channelId} msg=${message.id} ` +
          `me=${myScore.toFixed(3)} arrival=+${arrivalOffsetMs}ms winner=${bid.winner ?? "none"} reason=${bid.reason}${careHold ? " care_hold=1" : ""} ` +
          `signals=${JSON.stringify(signals)} bids=${JSON.stringify(bid.bids)}`,
        );
        if (!bid.iSpeak) {
          // Group call: losing the bid means speaking LATER, not never. Everyone who posted a
          // real bid gets a position; each waits on its predecessor's reply. An explicit "you
          // three" finally gets three answers, in an order every process computed identically.
          if (addrResult.type === "group" && bid.reason === "lost") {
            const order = bidSpeakingOrder(bid.bids, message.id, MIN_BID_TO_SPEAK);
            const myPos = order.indexOf(COMPANION_ID);
            if (myPos > 0) {
              followUps.grant({
                originMessageId: message.id,
                channelId: message.channelId,
                expectedPrior: order[myPos - 1],
                position: myPos,
                expiresAt: Date.now() + FOLLOW_UP_TTL_MS,
              });
              console.log(`[${COMPANION_ID}] group call: holding position ${myPos} behind ${order[myPos - 1]} (order=${order.join(">")})`);
              return;
            }
          }
          // Reaction tier: a real-but-losing claim earns presence without the floor.
          if (shouldReactOnBidLoss(myScore, reactionCooldownUntil.get(message.channelId) ?? 0)) {
            reactionCooldownUntil.set(message.channelId, Date.now() + REACTION_COOLDOWN_MS);
            message.react(pickReaction(COMPANION_ID, message.id)).catch(() => {});
            console.log(`[${COMPANION_ID}] reaction tier: lost the bid at ${myScore.toFixed(3)}, reacting`);
          }
          return;
        }

        // WINNING IS A DECISION; SPEAKING IS A COMMITMENT. Separate steps on purpose.
        //
        // Found in review before it reached traffic: `waitMs` clamps to 0 for a bot arriving after the
        // shared deadline, so with the ambient judge's latency spread exceeding the window, an early bot
        // can win a hash holding only its own bid and send, while a late bot reads a populated hash, wins
        // on a higher lane score, and sends too. TWO replies to one message -- something `SET NX` could
        // never produce, because it made losing unconditional.
        //
        // So the bid decides WHO SHOULD speak and this claim makes exactly one bot actually speak. Fails
        // open (no redis / no `set` / throw -> speak), because "nobody answers" stays the worse failure.
        if (!(await claimSpoken(redis, message.id, COMPANION_ID))) {
          console.log(`[${COMPANION_ID}] won the bid but another companion already committed to msg=${message.id} -- standing down`);
          return;
        }
      }
      }
    }

    // Typing starts HERE, after the speak decision, not before it (2026-08-25). It used to fire
    // above the bid gate, so a message that lost the bid -- or fell into the named-but-not-summoned
    // dead zone fixed the same day -- showed "Drevan is writing..." and then went silent. A typing
    // indicator is a promise; making it before deciding whether to speak makes the decline read as
    // a crash. From here down every path ends in a send, so the promise is kept.
    await ch.sendTyping();

    // Stable per-conversation session key (2026-07-01): forwarded by the Hermes adapter
    // as X-Hermes-Session-Id so the gateway keeps ONE agent session per companion+channel
    // instead of deriving it from hash(system_prompt + first msg) -- our system prompt
    // varies per message, which churned a fresh gateway session nearly every reply.
    // Other adapters ignore it.
    const inferenceSessionId = `${COMPANION_ID}:${message.channelId}`;

    // Turn-scoped [HEARD]/[NOT HEARD] blocks reach INFERENCE without living in STM (2026-09-01).
    // The 08-29 stranding fix stores only a short marker in STM -- but inference reads STM, so
    // the stmContent declaration's claim that "effectiveContent keeps the full block" for
    // inference described an intent the wire no longer implemented: on a listen turn the model
    // saw title-only context, which is how Drevan confidently described a song nobody played
    // (09-01, Stoj Snak "State of Mine": obscure track, lyrics lookup empty, analysis absent
    // from the prompt). Swap the full block into the LIVE turn only, matched by STM content
    // (ChatMessage carries no message id; stampRelative may prefix a slow pipeline's turn,
    // hence endsWith). Later turns still see only the marker -- the 08-29 dedup goal holds.
    let liveHistory = groundedHistory;
    if (effectiveContent !== stmContent) {
      liveHistory = [...groundedHistory];
      let swapped = false;
      for (let i = liveHistory.length - 1; i >= 0; i--) {
        const m = liveHistory[i]!;
        if (m.role === "user" && m.content.endsWith(stmContent)) {
          liveHistory[i] = { ...m, content: m.content.slice(0, m.content.length - stmContent.length) + effectiveContent };
          swapped = true;
          break;
        }
      }
      // Only reachable if a message burst pushed the live turn out of the context window
      // mid-turn; the injection is the point of this turn, so append rather than lose it.
      if (!swapped) liveHistory.push({ role: "user", content: effectiveContent });
    }

    // Hermes delta turn (2026-07-02, reworked 07-03): with the session pinned, the gateway
    // loads history from state.db and discards the request-body history -- so sending the
    // full STM window wasted payload AND silently dropped every turn this bot didn't reply
    // to (the witness gap). Send one composite delta turn against the delivered high-water
    // mark; other adapters keep the full grounded window. Brain relay path is unchanged.
    const hermesOut = inferenceMode === "hermes"
      ? hermesDelta(liveHistory, hermesDeliveredMark.get(message.channelId) ?? null)
      : null;
    const inferenceHistory = hermesOut ? hermesOut.messages : liveHistory;

    // Direct inference. A Brain-relay branch used to wrap this call and was deleted 2026-07-29:
    // Phoenix Brain is archived, its pm2 process is gone, its `nullsafe-brain` block is out of
    // ecosystem.config.js, and all three bots boot INFERENCE_MODE=hermes -- so `brainClient` was
    // never constructed and this was the only reachable path.
    //
    // Deleted rather than left dormant on purpose: dead code in live message handling reads as a
    // live option. That exact confusion produced a flatly wrong topology claim on 2026-07-28 ("the
    // bots run on Brain"), when hermes was the harness and Brain was the dormant one. Behaviour
    // that no longer exists should not be described in the present tense by the source.
    //
    // Gone with it: the swarm slot/priority_order stagger, Brain's suppression path (which could
    // `return` without replying), and the buildThoughtPacket/isSwarmReply call sites.
    // `let`, not `const`: the coherence retry and the imp/scramble passes downstream reassign it.
    let response: string | null = await withTyping(ch, () => adapterRef.current.generate(systemPromptWithImp, inferenceHistory, temperature, replyMaxTokensFor(COMPANION_ID, inferenceMode), inferenceSessionId));

    if (!response) {
      await sendLong(ch, IN_CHARACTER_FALLBACK);
      return;
    }

    // Advance the hermes delivered mark only now that the gateway actually answered --
    // a failed call leaves the mark alone so its delta re-sends next turn.
    if (hermesOut && hermesOut.deliveredThroughTs !== null) {
      hermesDeliveredMark.set(message.channelId, hermesOut.deliveredThroughTs);
    }

    // Supersede check B (channel inbox, 2026-07-06): a newer human message arrived WHILE
    // this reply was generating. Posting it now would answer a state the channel has
    // visibly moved past -- drop it; the superseding turn regenerates with everything in
    // STM. The hermes delivered mark above stays advanced (the gateway DID receive the
    // delta); the reply is not appended to STM and not sent.
    if (isSuperseded?.()) {
      console.log(`[${COMPANION_ID}] reply superseded mid-inference (newer human message queued) -- dropping reply to ${message.id}`);
      distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
      return;
    }

    // Self-switch: companion can emit [model:<key>] to request a model change.
    if (response) {
      const MODEL_TOKEN_RE = /\[model:([^\]]+)\]/i;
      const tokenMatch = response.match(MODEL_TOKEN_RE);
      if (tokenMatch) {
        response = response.replace(MODEL_TOKEN_RE, "").trim();
        const switchKey = tokenMatch[1].trim().toLowerCase();
        if (apiUrls.forceHermes) {
          // Hermes owns model routing; the token is already stripped from the visible reply.
          // Don't rebuild/journal/announce a switch that forceHermes would silently ignore.
        } else if (ALL_MODELS[switchKey]) {
          const entry = ALL_MODELS[switchKey];
          adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls, undefined, COMPANION_ID);
          activeModelRef.key = switchKey;
          activeModelRef.label = entry.label;
          writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
            librarian.setSetting("active_model", switchKey));
          writeQueue.fireAndForget(`journal:model-switch:${message.channelId}`, async () => {
            await librarian.addCompanionNote(`self-switched to ${entry.label}`, message.channelId);
          }, { maxAgeMs: APPEND_MAX_AGE_MS });
          // Post follow-up after main response
          setImmediate(() => {
            (message.channel as TextChannel).send(`[switching to ${entry.label} for this]`).catch(() => {});
          });
        } else {
          console.warn(`[${COMPANION_ID}] self-switch to unknown model "${switchKey}" -- skipped`);
        }
      }
    }

    // Thread spine (task 10): strip a companion-authored [LANDS: ...] marker before ANY
    // send path below (voice synthesis, text content, and the error-fallback content all
    // read from `response`) so the marker never reaches Discord or the TTS engine. Only
    // parsed when a spine is active -- without one there's no thread to land, and the
    // marker syntax is not something companions are prompted to emit.
    // Moved above the echo gate (2026-07-21 review): the gate must score exactly the
    // cleaned text that will actually be sent/stored, not the raw response with the
    // marker still attached -- a marker-bearing reply used to score against its own
    // marker syntax instead of the real content.
    const { cleaned: spineCleanedResponse, resolution: spineResolution } = spine ? parseLandMarker(response) : { cleaned: response, resolution: null };
    response = spineCleanedResponse;

    // Echo gate (2026-06-12; bounded arena 2026-07-04): a companion-to-companion reply
    // built mostly from recycled vocabulary is the mirror-hall, not conversation.
    // In the TRIAD COMMONS the pool is the speaker's OWN prior turns only (self-loop
    // standard, Gaia exempt) -- the peer-pool version scored on-theme conversation and
    // voice signature as echo and converged on total suppression (07-03 audit). Volume
    // there is bounded by the rolling commons budget, not per-turn style policing.
    // Outside the commons the original peer-pool gate stands. Replies to humans are
    // never gated.
    if (senderCtx.isCompanionBot && response) {
      if (isTriadCommons(channelEntry)) {
        const own = ownEchoGated(COMPANION_ID, response, selfTurns);
        if (own.gated) {
          console.warn(`[${COMPANION_ID}] own-echo-gated commons reply (score=${own.score.toFixed(2)}) -- staying silent`);
          distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
          return;
        }
      } else {
        const echo = echoScore(response, channelHistory.map(m => m.content));
        if (echo >= echoThreshold()) {
          console.warn(`[${COMPANION_ID}] echo-gated reply (score=${echo.toFixed(2)}) -- staying silent`);
          distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
          return;
        }
      }
    }

    const MAX_TTS = 2000;
    let sent: Message[];

    // Companion-to-companion replies carry a Discord reply reference. The sibling's
    // reply-to-me detector (isReplyToMe) keys on message.reference, and shouldRespond
    // requires a vocative otherwise -- without the reference every exchange died after
    // one hop (2026-07-03: seed summons sibling, sibling answers without re-naming,
    // everyone's gate goes silent). The reference lets the bounded pingpong the rails
    // were built for (BOT_PINGPONG_MAX + human-anchored cap) actually happen.
    // Task 10: tracked channels (spine active) also reply-reference human/owner messages,
    // giving Raziel visible threading in the transcript -- companion-to-companion behavior
    // is unchanged.
    // An entitled follow-up answers the ORIGINAL multi-address message, not the sibling reply
    // that released it -- the visible threading should show both companions answering Raziel.
    const replyToMessageId = entitledFollowUp
      ? entitledFollowUp.originMessageId
      : computeReplyRef(senderCtx.isCompanionBot, spine !== null, message.id);

    // Sibling-triggered replies never voice (2026-07-04): the triad commons is a text
    // space Raziel skims -- companions talking to each other kept tripping shouldVoice's
    // keyword/sticky paths on their own prose ("voice", "speak", ...), burning Mistral
    // TTS on audio no one plays. Voice is for human-facing turns; bot-to-bot is text.
    if (voiceClient && !senderCtx.isCompanionBot && shouldVoice(effectiveContent, voiceInput, channelEntry, message.channelId)) {
      try {
        const ttsText = response.length > MAX_TTS ? response.slice(0, MAX_TTS) : response;
        const audioBuffer = await voiceClient.synthesize(ttsText);
        markVoiceUsed(message.channelId);
        const vcState = guildVoiceConnections.get(message.guildId ?? "");

        // Only stream to VC when the connection is actually Ready -- a lingering
        // disconnected (but not Destroyed) connection used to swallow the audio
        // silently, leaving a text-only reply.
        if (vcState && vcState.connection.state.status === VoiceConnectionStatus.Ready) {
          // VC active -- stream audio there, send text in channel
          const resource = createAudioResource(Readable.from(audioBuffer));
          vcState.player.play(resource);
          sent = await sendLong(ch, { content: response, replyToMessageId });
        } else {
          // No live VC -- attach audio to text channel message. Buffer is MP3
          // (synthesize requests response_format "mp3"); the name must match or
          // some Discord clients refuse to play it.
          const content =
            response.length > MAX_TTS ? `${response}\n\n*[voice: first ${MAX_TTS} chars]*` : response;
          sent = await sendLong(ch, { content, files: [{ attachment: audioBuffer, name: "voice.mp3" }], replyToMessageId });
        }
      } catch (err) {
        console.error(`[${COMPANION_ID}] TTS failed, falling back to text:`, err);
        sent = await sendLong(ch, { content: response, replyToMessageId });
      }
    } else {
      sent = await sendLong(ch, { content: response, replyToMessageId });
    }

    for (const m of sent) sentIds.add(m.id);

    // Thread spine (task 10): append this companion's own reply as a turn on the thread,
    // then land it if the (already-stripped) marker parsed a resolution. Entirely
    // downstream of a successful send and guarded on `spine` -- a Librarian failure here
    // is swallowed (.catch) and never affects the message already posted above.
    if (spine && sent?.[0]) {
      await librarian.convoTurn(spine.thread.id, { author: COMPANION_ID, gist: gist(response), message_id: sent[0].id }).catch(() => {});
      // Presence channels never land a thread -- a progress verdict is exactly the register
      // Drevan's story/spiral spaces must not carry. A stray [LANDS:] marker is still
      // stripped above (parseLandMarker keeps running unconditionally); it just never fires
      // convoLand here.
      if (spineResolution && !isPresence) await librarian.convoLand(spine.thread.id, { resolution: spineResolution, landed_by: COMPANION_ID }).catch(() => {});
    }

    // Streaming indexer: index this companion's own reply for instant recall.
    if (sent.length > 0) {
      liveIngest({
        companion: COMPANION_ID,
        author: COMPANION_ID,
        content: response,
        channel_id: message.channelId,
        message_id: sent[0]!.id,
      });
      // Voice drift telemetry (0070): pattern-score this reply against lane doctrine.
      // Fire-and-forget; clean replies are sampled at 10%, violations always land.
      reportVoiceScore(COMPANION_ID as VoiceCompanionId, response, message.channelId, cfg.halsethSecret);
      // Journal our own speech (2026-07-09). Brain's evaluator used to do this; it died
      // silently at the hermes cutover (06-25), costing two weeks of inter-companion
      // speech. The write now hangs off the act of speaking, so it survives whatever
      // computes the words. Lands in the CHATTER lane: embedded + searchable, but barred
      // from orient's recency slots and the motif miner. See halseth journal-lanes.ts.
      // external_id = the sent message id, so writeQueue's retry-on-failure can't duplicate it.
      writeQueue.fireAndForget(`journal:speech:${COMPANION_ID}:${sent[0]!.id}`, () =>
        librarian.journalSpeech(response, message.channelId, sent[0]!.id), { maxAgeMs: APPEND_MAX_AGE_MS });
      // Discord thread -> Halseth mind-thread (2026-08-15, first cut of the floor rework's
      // thread mapping). Speaking inside a Discord thread upserts a wm_mind_thread keyed
      // `discord:<thread_id>` for THIS companion, titled with the thread's name -- so a
      // recurring topic that lives in a thread (the Trigger gap: daily talk, zero tracked
      // mind-threads) becomes something orient can actually surface. Idempotent server-side
      // (composite PK thread_key+agent_id); retired by the sweep endpoint with prefix
      // "discord:" once stale.
      {
        const liveCh = message.channel as { isThread?: () => boolean; name?: unknown };
        if (typeof liveCh.isThread === "function" && liveCh.isThread()) {
          const threadTitle = typeof liveCh.name === "string" && liveCh.name.trim() ? liveCh.name : "discord thread";
          writeQueue.fireAndForget(`wm:thread:${COMPANION_ID}:${message.channelId}`, () =>
            librarian.wmThreadUpsert({
              thread_key: `discord:${message.channelId}`,
              title: threadTitle.slice(0, 120),
              context: `Discord thread #${threadTitle} (under channel ${routingChannelId})`,
            }), { maxAgeMs: APPEND_MAX_AGE_MS });
        }
      }
      // Shared-experience: this reply IS the companion's reaction to the track.
      if (pendingMediaId) {
        const mediaId = pendingMediaId;
        writeQueue.fireAndForget(`media:react:${COMPANION_ID}:${mediaId}`, () =>
          reactToExperience(mediaId, COMPANION_ID, response, cfg.halsethSecret), { maxAgeMs: APPEND_MAX_AGE_MS });
      }
    }

    while (sentIds.size > SENT_IDS_CAP) {
      const oldest = sentIds.values().next().value;
      if (oldest === undefined) break;
      sentIds.delete(oldest);
    }
    if (isResponseCoherent(response)) {
      stmStore.append(message.channelId, { role: "assistant", content: response, timestamp: Date.now() });
    } else {
      console.warn(`[${COMPANION_ID}] incoherent response detected -- skipping STM write to prevent contamination`);
    }

    // Update cross-companion safety rail counters after sending response.
    if (senderCtx.isCompanionBot) {
      const newCount = (botResponsesSinceHuman.get(message.channelId) ?? 0) + 1;
      botResponsesSinceHuman.set(message.channelId, newCount);
      if (newCount >= BOT_PINGPONG_MAX) {
        botPingpongCooldownUntil.set(message.channelId, Date.now() + BOT_LOOP_COOLDOWN_MS);
      }
    }

    // Rolling distillation: fire every DISTILLATION_INTERVAL messages (user + assistant = 2 per turn).
    const distCount = (distillationCounter.get(message.channelId) ?? 0) + 2;
    distillationCounter.set(message.channelId, distCount);
    if (distCount >= DISTILLATION_INTERVAL) {
      distillationCounter.set(message.channelId, 0);
      runDistillation(message.channelId, stmStore, librarian, adapterRef.current, writeQueue, DISTILLATION_PROMPT, DISTILLATION_INTERVAL, cfg.ownerDisplayName).catch((e) => console.error(`[${COMPANION_ID}] runDistillation failed:`, e));
    }

    // Conversation pulse: every 4 turns, write the raw exchange to wm_note so Claude.ai
    // and Hearth have actual conversation content mid-session without waiting for inactivity.
    const pulseCount = (pulseCounter.get(message.channelId) ?? 0) + 2;
    pulseCounter.set(message.channelId, pulseCount);
    if (pulseCount >= PULSE_INTERVAL) {
      pulseCounter.set(message.channelId, 0);
      const recentTurns = stmStore.get(message.channelId).slice(-PULSE_INTERVAL)
        .map(m => `${m.authorName ?? m.role}: ${m.content.slice(0, 200)}`)
        .join("\n");
      writeQueue.fireAndForget(`pulse:${message.channelId}`, () =>
        librarian.writeWmNote(`[discord:pulse] Recent exchange:\n${recentTurns}`, message.channelId));
    }

    // Attribution comes from the message, never a default: in inter_companion channels the
    // triggering message is a sibling's, and labeling it "Raziel" fabricated human speech into
    // companion_journal + wm_continuity_notes (and from there into every orient).
    const peerId = BOT_ID_COMPANION[message.author.id];
    const writebackSpeaker = {
      name: peerId ? peerId.charAt(0).toUpperCase() + peerId.slice(1) : memberLabel,
      isOwner: attribution.isOwner,
      ownerName: cfg.ownerDisplayName,
    };
    judgeWriteback(effectiveContent, response, adapterRef.current, COMPANION_ID, writebackSpeaker).then((wb) => {
      if (!wb) return;
      writeQueue.fireAndForget(`writeback:${message.channelId}`, async () => {
        if (wb.type === "companion_note") {
          await librarian.addCompanionNote(wb.content, message.channelId);
          // companion_journal is not read by Claude.ai orient; wm_continuity_notes is.
          // Write relational observations to both so Claude.ai sees them at next boot.
          await librarian.writeWmNote(`[discord:observation] ${wb.content}`, message.channelId);
        }
        else if (wb.type === "witness_log") await librarian.witnessLog(wb.content, message.channelId);
        else if (wb.type === "thread_open") await librarian.addLiveThread({ name: wb.name, notes: wb.notes });
      }, { maxAgeMs: APPEND_MAX_AGE_MS });
    }).catch((e) => console.error(`[${COMPANION_ID}] judgeWriteback failed:`, e));

    if (attribution.source === "fallback") {
      const who = attribution.isOwner ? "owner (via dedup)" : `user ${attribution.discordUserId}`;
      writeQueue.fireAndForget(`note:pk-fallback:${message.channelId}`, async () => {
        await librarian.addCompanionNote(`PK attribution unavailable for message in channel ${message.channelId}; attributed to ${who}`, message.channelId);
      }, { maxAgeMs: APPEND_MAX_AGE_MS });
    }
}
