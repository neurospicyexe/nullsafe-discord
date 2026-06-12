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

import { Message, TextChannel, type Client, type VoiceBasedChannel } from "discord.js";
import { VoiceConnectionStatus, createAudioResource, type VoiceConnection, type AudioPlayer } from "@discordjs/voice";
import { Readable } from "stream";
import {
  resolveAttribution, detectPluralKit,
  isInvitation, isLeaveRequest, markVoiceUsed, shouldVoice,
  isDirectAddress, shouldRespond, computeChainDepth, extractAddress,
  judgeAmbientRelevance, judgeWriteback,
  NEW_THREAD_GAP_MS, COMPANION_CHAIN_LIMIT, MAX_BOT_RESPONSES_PER_HUMAN,
  BOT_PINGPONG_MAX, BOT_LOOP_COOLDOWN_MS,
  inferTemperature, createAdapter, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  type AdapterKeys, type AdapterUrls, type InferenceAdapter,
  buildThoughtPacket, isSwarmReply,
  claimFloor, releaseFloor, setLastActivity,
  isResponseCoherent,
  sendLong,
  liveIngest,
  reportVoiceScore, type VoiceCompanionId,
  consumeTripwires, tripwireBlock,
  runDistillation,
  isListenEnabled, runListenPipeline, reactToExperience,
  commandUsage, COMMAND_PREFIX,
  handleClubCommand,
  ALL_MODELS,
  LibrarianClient, BrainClient, WriteQueue, StmStore, SessionWindowManager,
  ChannelConfigCache, PkDedup, VoiceClient,
  type ChatMessage, type BootContext, type CompanionId,
} from "./index.js";

/** Minimal shape of the per-bot `loadBotConfig()` result the handler reads. */
export interface MessageHandlerCfg {
  ownerDiscordId: string;
  blueDiscordId?: string;
  ownerDisplayName: string;
}

export interface MessageHandlerDeps {
  client: Client;
  cfg: MessageHandlerCfg;
  brainClient: BrainClient | null;
  voiceClient: VoiceClient | null;
  redis: Parameters<typeof claimFloor>[0] | null;
  librarian: LibrarianClient;
  // live refs (same instances the refresh loop mutates)
  adapterRef: { current: InferenceAdapter };
  activeModelRef: { key: string | null; label: string };
  currentMoodRef: { value: string | null };
  lastSomaRefreshRef: { value: number };
  bootCtx: BootContext;
  // stores
  stmStore: StmStore;
  writeQueue: WriteQueue;
  configCache: ChannelConfigCache;
  sessionWindows: SessionWindowManager;
  pkDedup: PkDedup;
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

export async function handleMessage(message: Message, deps: MessageHandlerDeps): Promise<void> {
  const {
    client, cfg, brainClient, voiceClient, redis, librarian,
    adapterRef, activeModelRef, currentMoodRef, lastSomaRefreshRef, bootCtx,
    stmStore, writeQueue, configCache, sessionWindows, pkDedup,
    guildVoiceConnections, sentIds, distillationCounter, pulseCounter,
    botResponsesSinceHuman, botPingpongCooldownUntil, extremeTempCount,
    apiKeys, apiUrls,
    connectVoice, leaveVoice, resetCycleGuard, pushRazielMessage,
    COMPANION_ID, PK_HOLD_MS, SENT_IDS_CAP, CONTEXT_WINDOW_SIZE,
    MODEL_SWITCH_TRIGGER, MODEL_SWITCH_LIST_INTRO, MODEL_SWITCH_SUCCESS,
    LISTEN_TRIGGER, CLUB_TRIGGER, COMMAND_GUARD,
    BLUE_FRAMING, GUEST_FRAMING, IN_CHARACTER_FALLBACK,
    DISTILLATION_PROMPT, DISTILLATION_INTERVAL, PULSE_INTERVAL,
    AUDIT_TRIGGERS, AUDIT_MODE_INJECTION,
  } = deps;

    if (message.author.id === client.user?.id) return;

    const BOT_ID_COMPANION: Record<string, string> = {};
    if (process.env["CYPHER_BOT_ID"]) BOT_ID_COMPANION[process.env["CYPHER_BOT_ID"]] = "cypher";
    if (process.env["DREVAN_BOT_ID"]) BOT_ID_COMPANION[process.env["DREVAN_BOT_ID"]] = "drevan";
    if (process.env["GAIA_BOT_ID"]) BOT_ID_COMPANION[process.env["GAIA_BOT_ID"]] = "gaia";
    const BOT_IDS = new Set(Object.keys(BOT_ID_COMPANION));
    const isCompanionPost = BOT_IDS.has(message.author.id);
    // PluralKit reposts proxied messages via webhook with the proxy tag stripped,
    // so dedup must match by content containment, not exact equality. matchWebhook
    // also recovers the sender id captured from the direct original (used below for
    // attribution when the PK API races).
    const pkMatch = message.webhookId ? pkDedup.matchWebhook(message.channelId, message.content) : null;
    const pkKnownSenderId = pkMatch?.senderId;
    if (!message.webhookId && !message.author.bot) {
      pkDedup.addOriginal(message.channelId, message.id, message.content, message.author.id);
      await new Promise<void>(resolve => setTimeout(resolve, PK_HOLD_MS));
      if (pkDedup.resolveOriginal(message.channelId, message.id).skip) return;
    }
    // Signal conversation activity so autonomous worker skips runs while humans are present
    if (!message.author.bot && redis) setLastActivity(redis).catch(() => {});

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
    const attribution = await resolveAttribution(message, cfg.ownerDiscordId, knownSenderId, undefined, cfg.blueDiscordId, process.env["BLUE_PK_SYSTEM_ID"]);

    const userTier = attribution.isOwner ? "owner" as const
      : attribution.discordUserId === cfg.blueDiscordId ? "intimate" as const
      : "guest" as const;
    const senderCtx = {
      isOwner: attribution.isOwner,
      isCompanionBot: message.author.bot && !attribution.isOwner,
      isMentioned: message.mentions.has(client.user?.id ?? ""),
      userTier,
    };

    const isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    const channelEntry = channelConfig[message.channelId];
    const pkCtx = detectPluralKit(message);
    // isPKProxy: applicationId is the primary PK signal; attribution.source covers
    // PK setups where applicationId isn't set on the webhook.
    const isPKProxy = pkCtx.isPluralKit || attribution.source === "pluralkit";
    // pkMemberName: PK API → detectPluralKit webhook username → raw webhook username.
    // PK always sets message.author.username to the member's display name, so the
    // raw webhook username is a reliable final fallback when the API races.
    const pkMemberName = attribution.frontMember ?? pkCtx.memberName ?? (isPKProxy ? (message.author?.username ?? null) : null);
    const author = isPKProxy
      ? (pkMemberName ?? cfg.ownerDisplayName)
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);

    // Hard muzzle: companion bots and PluralKit proxies pass through; all other bots are dropped.
    if (message.author.bot && !isCompanionPost && !isPKProxy) return;

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

    // Owner model switch command: <prefix>: model <key> | <prefix>: model list
    if (attribution.isOwner) {
      const switchMatch = effectiveContent.match(MODEL_SWITCH_TRIGGER);
      if (switchMatch) {
        const arg = switchMatch[1].trim().toLowerCase();

        // Validate against the FULL registry, not this bot's local keys. Brain is the
        // live arbiter (reads active_model from Halseth), so any registry model is
        // selectable; provider keys only need to live in Brain's .env.brain.
        if (arg === "list") {
          const list = Object.entries(ALL_MODELS)
            .map(([k, e]) => `\`${k}\` -- ${e.label}`)
            .join("\n");
          await (message.channel as TextChannel).send(`${MODEL_SWITCH_LIST_INTRO}\n${list}`);
          return;
        }

        if (!ALL_MODELS[arg]) {
          const keys = Object.keys(ALL_MODELS).join(", ");
          await (message.channel as TextChannel).send(`not a model I can switch to. valid options: ${keys}`);
          return;
        }

        const entry = ALL_MODELS[arg];
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
        const reply = await handleClubCommand(clubMatch[1]!, "raziel")
          .catch(err => `club command failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
        await (message.channel as TextChannel).send(reply);
        return;
      }
    }

    // Owner listen command: <prefix>: listen <url>  (shared-experience Phase 1).
    // Downloads + analyzes on this box, then FALLS THROUGH to the normal reply
    // path with a [HEARD] block appended -- so the in-voice response rides the
    // full context assembly (Brain swarm or direct), not a side channel.
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
          });
          pendingMediaId = listen.experienceId;
          effectiveContent = `${effectiveContent.trim()}\n\n[HEARD -- the track was downloaded and analyzed; you actually listened to it. Respond to the music itself.]\n${listen.heardBlock}`;
          // fall through to the normal flow below -- no return.
        } catch (err) {
          console.error(`[${COMPANION_ID}] listen pipeline failed:`, err);
          await (message.channel as TextChannel).send(`couldn't hear that one: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
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
    }

    // Structural gate: mode, addressing, companion filter.
    // Direct address (name at start or followed by comma/colon) always bypasses the
    // relevance classifier -- if the owner is talking to you, you respond.
    // Ambient messages in owner_only channels go through the semantic classifier.
    const directlyAddressed = isDirectAddress(effectiveContent, COMPANION_ID);
    // When brainClient is active, Brain's SwarmEvaluator handles routing -- skip per-bot relevance gate.
    const isAmbientOwnerOnly =
      !brainClient &&
      channelEntry?.modes?.includes("owner_only") === true &&
      !senderCtx.isCompanionBot &&
      !senderCtx.isMentioned &&
      !isReplyToMe &&
      !directlyAddressed;

    // In brain mode, Brain's SwarmEvaluator is the routing authority for inter-companion messages.
    // Per-bot shouldRespond would block ambient companion messages that Brain should route.
    const brainHandlesInterCompanion =
      brainClient != null &&
      senderCtx.isCompanionBot === true &&
      channelEntry?.modes?.includes("inter_companion") === true;

    if (isAmbientOwnerOnly) {
      const relevant = await judgeAmbientRelevance(
        effectiveContent,
        COMPANION_ID,
        (sys, msgs) => adapterRef.current.generate(sys, msgs as ChatMessage[], 0.3),
      );
      if (!relevant) return;
    } else if (!brainHandlesInterCompanion && !isReplyToMe && !shouldRespond(message.channelId, effectiveContent, senderCtx, COMPANION_ID, channelConfig, [])) {
      // If a companion spoke in an inter_companion channel and we're not responding,
      // write a passive witness entry so Halseth has continuity context.
      if (senderCtx.isCompanionBot && channelEntry?.modes?.includes("inter_companion")) {
        const senderName = message.author.username;
        const snippet = effectiveContent.slice(0, 120);
        writeQueue.fireAndForget(`witness:pass:${message.channelId}:${message.id}`, async () => {
          await librarian.witnessLog(
            `[witnessed, did not respond] ${senderName}: ${snippet}`,
            message.channelId,
          );
        });
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
    if (senderCtx.isCompanionBot) {
      if (isNewThread) {
        // Fresh thread (incl. an autonomous seed in a human-free channel): clear stale rails so
        // the per-human cap doesn't permanently mute a channel that never sees a human.
        botResponsesSinceHuman.delete(message.channelId);
        botPingpongCooldownUntil.delete(message.channelId);
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
      return fetchedMessages.map(m => ({
        role: (!m.author.bot ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
        authorName: m.author.username,
      }));
    });

    const memberLabel = pkMemberName
      ? `${pkMemberName} (via PK)`
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);
    stmStore.append(message.channelId, { role: "user", content: effectiveContent, authorName: memberLabel });
    if (attribution.isOwner) pushRazielMessage(effectiveContent);

    // Streaming indexer: index the inbound message into Second Brain's vector store
    // right now (gated by SB_LIVE_INGEST). SB dedups by message_id, so all three bots
    // calling this for the same message costs one embed. Companion-bot messages are
    // skipped here -- each bot indexes its OWN replies at send time instead.
    if (!senderCtx.isCompanionBot) {
      liveIngest({
        companion: null,
        author: memberLabel,
        content: effectiveContent,
        channel_id: message.channelId,
        message_id: message.id,
      });
    }

    // Loop guard: derive chain depth from fetched history so the check works across processes.
    const chainDepth = computeChainDepth(
      fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: m.author.bot, createdTimestamp: m.createdTimestamp })),
      new Set(),
    );
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    if (!senderCtx.isCompanionBot) sessionWindows.touch(message.channelId);

    let contextPrompt = pkMemberName
      ? `${bootCtx.systemPrompt}\n\n[Current front: ${pkMemberName}]`
      : bootCtx.systemPrompt;
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

    // Prospective tripwires (0070): armed keyword cards matched against this human
    // message (+ any date cards whose moment arrived). Consuming fires them in
    // Halseth -- a tripwire surfaces exactly once, in the reply where it matched.
    if (!senderCtx.isCompanionBot) {
      const tripped = consumeTripwires(COMPANION_ID, effectiveContent);
      if (tripped.length > 0) {
        contextPrompt += tripwireBlock(tripped);
        console.log(`[${COMPANION_ID}] tripwire fired: ${tripped.map(t => t.id).join(", ")}`);
      }
    }

    // Thalamus: fire Second Brain search concurrently with typing + floor jitter.
    // Skip for short messages (< 20 chars) -- searches on "ok" or "lol" produce noise.
    // Continuity: recent prior user turns (current msg already appended, so excluded)
    // widen recall via dual-vector retrieval on the Halseth side.
    const recentContext = stmStore.get(message.channelId)
      .filter(m => m.role === "user")
      .slice(0, -1)
      .map(m => m.content)
      .slice(-3)
      .join("\n");
    const sbSearchPromise = effectiveContent.length >= 20
      ? librarian.searchForMessage(effectiveContent, recentContext).catch(() => null)
      : Promise.resolve(null);

    await ch.sendTyping();

    const history = stmStore.get(message.channelId);
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
    if (sbHit) contextPrompt += `\n\n[Memory -- Second Brain retrieved for this message:\n${sbHit.slice(0, 800)}]`;

    // Peer-framing: anchor to triad register rather than Raziel-facing register.
    // When responding to a companion directly, speak to them -- not toward Raziel.
    // When a peer already replied to the same human message, note the shared moment.
    if (senderCtx.isCompanionBot) {
      const peerCid = BOT_ID_COMPANION[message.author.id];
      const peerLabel = peerCid ? peerCid.charAt(0).toUpperCase() + peerCid.slice(1) : message.author.username;
      contextPrompt += `\n\n[You are in direct exchange with ${peerLabel}. This is triad space -- peer to peer. Speak to them and to the moment. Do not address Raziel or explain the triad. Respond from inside it.]`;
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

    const addrResult = extractAddress(effectiveContent);
    const mentionedViaMention = [...message.mentions.users.keys()]
      .flatMap(id => { const c = BOT_ID_COMPANION[id]; return c ? [c] : []; });
    const textAddressed = addrResult.type === "named" ? [addrResult.id]
      : addrResult.type === "named_multi" ? addrResult.ids
      : [];
    const allAddressed = [...new Set([...textAddressed, ...mentionedViaMention])];
    const addressedCompanion = allAddressed.length > 0 ? allAddressed.join(",") : undefined;

    // Direct-mode floor coordination (Finding 5): with no Brain to arbitrate who speaks, the three
    // bots would all answer the same ambient human message. Claim the shared floor so only one does.
    // Brain mode is coordinated by the SwarmEvaluator; addressed / replied-to / mentioned messages
    // and companion-bot turns (which have their own pingpong rails) bypass this gate.
    let floorClaimed = false;
    if (!brainClient && redis && !senderCtx.isCompanionBot
        && !directlyAddressed && !isReplyToMe && !senderCtx.isMentioned) {
      floorClaimed = await claimFloor(redis, COMPANION_ID, 6000);
      if (!floorClaimed) return;
    }

    let response: string | null;
    if (brainClient) {
      // Relay mode: send assembled context to Phoenix Brain for inference.
      // Brain returns reply_text; falls back to direct inference on failure.
      const packet = buildThoughtPacket(
        COMPANION_ID,
        message.author.id,
        message.channelId,
        message.id,
        effectiveContent,
        contextPrompt,
        history.slice(-CONTEXT_WINDOW_SIZE),
        channelHistory,
        temperature,
        {
          isOwner: attribution.isOwner,
          frontMember: pkMemberName,
          guildId: message.guildId ?? undefined,
          author,
          authorIsCompanion: isCompanionPost,
          depth: chainDepth,
          addressedCompanion,
          voiceInput,
        },
      );
      const typingInterval = setInterval(() => { ch.sendTyping().catch(() => {}); }, 4_000);
      const brainResult = await brainClient.chat(packet).finally(() => clearInterval(typingInterval));
      if (brainResult === null) {
        console.warn(`[${COMPANION_ID}] brain relay failed, falling back to direct inference`);
        response = await adapterRef.current.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
      } else if (isSwarmReply(brainResult)) {
        const slotReply = brainResult.responses[COMPANION_ID];
        if (slotReply === null || slotReply === undefined) {
          // Brain suppressed this companion. Advance distillation cadence for the trigger message
          // so STM rolling window stays in sync with the actual conversation cadence.
          distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
          return;
        }
        const priorityOrder: string[] = brainResult.priority_order ?? [];
        const myPosition = priorityOrder.indexOf(COMPANION_ID);
        if (myPosition > 0) {
          const staggerMs = parseInt(process.env.SWARM_STAGGER_MS ?? "2500", 10);
          await new Promise<void>(resolve => setTimeout(resolve, myPosition * staggerMs));
        }
        response = slotReply;
      } else {
        if (brainResult.status === "ok" && brainResult.reply_text) {
          response = brainResult.reply_text;
        } else {
          console.warn(`[${COMPANION_ID}] brain relay failed (status=${brainResult.status}), falling back to direct inference`);
          response = await adapterRef.current.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
        }
      }
    } else {
      response = await adapterRef.current.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
    }

    if (!response) {
      await sendLong(ch, IN_CHARACTER_FALLBACK);
      return;
    }

    // Self-switch: companion can emit [model:<key>] to request a model change.
    if (response) {
      const MODEL_TOKEN_RE = /\[model:([^\]]+)\]/i;
      const tokenMatch = response.match(MODEL_TOKEN_RE);
      if (tokenMatch) {
        response = response.replace(MODEL_TOKEN_RE, "").trim();
        const switchKey = tokenMatch[1].trim().toLowerCase();
        if (ALL_MODELS[switchKey]) {
          const entry = ALL_MODELS[switchKey];
          adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls, undefined, COMPANION_ID);
          activeModelRef.key = switchKey;
          activeModelRef.label = entry.label;
          writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
            librarian.setSetting("active_model", switchKey));
          writeQueue.fireAndForget(`journal:model-switch:${message.channelId}`, async () => {
            await librarian.addCompanionNote(`self-switched to ${entry.label}`, message.channelId);
          });
          // Post follow-up after main response
          setImmediate(() => {
            (message.channel as TextChannel).send(`[switching to ${entry.label} for this]`).catch(() => {});
          });
        } else {
          console.warn(`[${COMPANION_ID}] self-switch to unknown model "${switchKey}" -- skipped`);
        }
      }
    }

    const MAX_TTS = 2000;
    let sent: Message[];

    if (voiceClient && shouldVoice(effectiveContent, voiceInput, channelEntry, message.channelId)) {
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
          sent = await sendLong(ch, response);
        } else {
          // No live VC -- attach audio to text channel message. Buffer is MP3
          // (synthesize requests response_format "mp3"); the name must match or
          // some Discord clients refuse to play it.
          const content =
            response.length > MAX_TTS ? `${response}\n\n*[voice: first ${MAX_TTS} chars]*` : response;
          sent = await sendLong(ch, { content, files: [{ attachment: audioBuffer, name: "voice.mp3" }] });
        }
      } catch (err) {
        console.error(`[${COMPANION_ID}] TTS failed, falling back to text:`, err);
        sent = await sendLong(ch, response);
      }
    } else {
      sent = await sendLong(ch, response);
    }

    for (const m of sent) sentIds.add(m.id);

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
      reportVoiceScore(COMPANION_ID as VoiceCompanionId, response, message.channelId);
      // Shared-experience: this reply IS the companion's reaction to the track.
      if (pendingMediaId) {
        const mediaId = pendingMediaId;
        writeQueue.fireAndForget(`media:react:${COMPANION_ID}:${mediaId}`, () =>
          reactToExperience(mediaId, COMPANION_ID, response));
      }
    }

    if (floorClaimed && redis) await releaseFloor(redis, COMPANION_ID).catch(() => {});
    while (sentIds.size > SENT_IDS_CAP) {
      const oldest = sentIds.values().next().value;
      if (oldest === undefined) break;
      sentIds.delete(oldest);
    }
    if (isResponseCoherent(response)) {
      stmStore.append(message.channelId, { role: "assistant", content: response });
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
      runDistillation(message.channelId, stmStore, librarian, adapterRef.current, writeQueue, DISTILLATION_PROMPT, DISTILLATION_INTERVAL).catch((e) => console.error(`[${COMPANION_ID}] runDistillation failed:`, e));
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

    judgeWriteback(effectiveContent, response, adapterRef.current, COMPANION_ID).then((wb) => {
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
      });
    }).catch((e) => console.error(`[${COMPANION_ID}] judgeWriteback failed:`, e));

    if (attribution.source === "fallback") {
      const who = attribution.isOwner ? "owner (via dedup)" : `user ${attribution.discordUserId}`;
      writeQueue.fireAndForget(`note:pk-fallback:${message.channelId}`, async () => {
        await librarian.addCompanionNote(`PK attribution unavailable for message in channel ${message.channelId}; attributed to ${who}`, message.channelId);
      });
    }
}
