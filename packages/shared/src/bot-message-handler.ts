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
  countBotMsgsSinceHuman, botMsgsSinceHumanMax, isTriadCommons, FLOOR_HANDBACK_WINDOW, floorHandbackDirective,
  inferTemperature, createAdapter, replyMaxTokensFor, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  type AdapterKeys, type AdapterUrls, type InferenceAdapter,
  buildThoughtPacket, isSwarmReply,
  claimFloor, releaseFloor, setLastActivity,
  clearConsolidation,
  isResponseCoherent,
  sendLong,
  liveIngest,
  reportVoiceScore, voiceFeedbackBlock, type VoiceCompanionId,
  echoScore, echoThreshold, ownEchoGated,
  detectSelfLoop, loopBreakDirective,
  consumeTripwires, tripwireBlock,
  runDistillation,
  isListenEnabled, runListenPipeline, reactToExperience,
  commandUsage, COMMAND_PREFIX, listenCommandTarget,
  handleClubCommand,
  handleLogCommand,
  handleIntoCommand,
  handleToolSearch, formatSearchReadIn, handleToolImage, handleCouncilConvene,
  handlePetCommand,
  handleImpCommand,
  ALL_MODELS,
  LibrarianClient, BrainClient, WriteQueue, StmStore, SessionWindowManager,
  ChannelConfigCache, PkDedup, VoiceClient,
  type ChatMessage, type BootContext, type CompanionId,
  isThreadsEnabled, isThreadTracked, ensureThread, buildSpineBlock, parseLandMarker, gist, computeReplyRef,
  type ConvoActiveDto,
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
  brainClient: BrainClient | null;
  voiceClient: VoiceClient | null;
  redis: Parameters<typeof claimFloor>[0] | null;
  librarian: LibrarianClient;
  // live refs (same instances the refresh loop mutates)
  adapterRef: { current: InferenceAdapter };
  activeModelRef: { key: string | null; label: string };
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
    adapterRef, activeModelRef, currentMoodRef, lastSomaRefreshRef, recentContextRef, bootCtx,
    stmStore, writeQueue, configCache, sessionWindows, pkDedup,
    guildVoiceConnections, sentIds, distillationCounter, pulseCounter,
    botResponsesSinceHuman, botPingpongCooldownUntil, extremeTempCount,
    apiKeys, apiUrls, isSuperseded,
    connectVoice, leaveVoice, resetCycleGuard, pushRazielMessage,
    COMPANION_ID, PK_HOLD_MS, SENT_IDS_CAP, CONTEXT_WINDOW_SIZE,
    MODEL_SWITCH_TRIGGER, MODEL_SWITCH_LIST_INTRO, MODEL_SWITCH_SUCCESS,
    LISTEN_TRIGGER, CLUB_TRIGGER, SEARCH_TRIGGER, IMAGINE_TRIGGER, PET_TRIGGER, COUNCIL_TRIGGER, IMPS_TRIGGER, HEX_TRIGGER, LOG_TRIGGER, INTO_TRIGGER, COMMAND_GUARD,
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
    if (!message.author.bot && redis) {
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

    // Take 9 contact-hook: any real Raziel contact sheds this companion's relational
    // need, so the drive-driven reach-out only fires on genuine silence. Fire-and-forget
    // (shedDriveContact swallows its own errors) -- never blocks the message path.
    if (attribution.isOwner) {
      writeQueue.fireAndForget(`drive:contact:${COMPANION_ID}`, () => librarian.shedDriveContact());
    }

    const isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    const channelEntry = channelConfig[message.channelId];

    let spine: ConvoActiveDto | null = null;
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

    // Thread spine (task 10): ensure a conversation thread exists for this channel and
    // append this incoming message as a turn on it. Fully fail-open -- ensureThread's own
    // .catch(() => null) means a Librarian hiccup here never blocks the reply path below;
    // every subsequent spine interaction is guarded on `spine` being non-null. Runs AFTER
    // the hard muzzle above so a stray non-companion bot can never open/seed a thread.
    const spineAuthor = BOT_ID_COMPANION[message.author.id]
      ?? (attribution.isOwner ? "raziel" : "guest");
    if (isThreadsEnabled() && isThreadTracked(channelEntry, message.channelId)) {
      spine = await ensureThread(librarian, message.channelId, { id: message.id, content: message.content }, spineAuthor)
        .catch(() => null);
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
        stmStore.append(message.channelId, { role: "user", content: effectiveContent, authorName: cfg.ownerDisplayName, timestamp: message.createdTimestamp });
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
        fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: m.author.bot, createdTimestamp: m.createdTimestamp })),
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
      return fetchedMessages.map(m => ({
        role: (!m.author.bot ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
        authorName: m.author.username,
        timestamp: m.createdTimestamp,
      }));
    });

    const memberLabel = pkMemberName
      ? `${pkMemberName} (via PK)`
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);
    stmStore.append(message.channelId, { role: "user", content: effectiveContent, authorName: memberLabel, timestamp: message.createdTimestamp });
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
    let contextPrompt = pkMemberName
      ? `${basePrompt}\n\n[Current front: ${pkMemberName}]`
      : basePrompt;
    // Thread spine (task 10): pinned above the periodic hermes orient paragraph below,
    // deliberately -- the spine is this exchange's immediate continuity and should read
    // as closer/more load-bearing than the standing recent-context block. Guarded on
    // `spine` (set above, already fail-open) so a missing/failed thread is a no-op here.
    if (spine) contextPrompt += `\n\n${buildSpineBlock(spine, COMPANION_ID)}`;
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

    // Stable per-conversation session key (2026-07-01): forwarded by the Hermes adapter
    // as X-Hermes-Session-Id so the gateway keeps ONE agent session per companion+channel
    // instead of deriving it from hash(system_prompt + first msg) -- our system prompt
    // varies per message, which churned a fresh gateway session nearly every reply.
    // Other adapters ignore it.
    const inferenceSessionId = `${COMPANION_ID}:${message.channelId}`;

    // Hermes delta turn (2026-07-02, reworked 07-03): with the session pinned, the gateway
    // loads history from state.db and discards the request-body history -- so sending the
    // full STM window wasted payload AND silently dropped every turn this bot didn't reply
    // to (the witness gap). Send one composite delta turn against the delivered high-water
    // mark; other adapters keep the full grounded window. Brain relay path is unchanged.
    const hermesOut = inferenceMode === "hermes"
      ? hermesDelta(groundedHistory, hermesDeliveredMark.get(message.channelId) ?? null)
      : null;
    const inferenceHistory = hermesOut ? hermesOut.messages : groundedHistory;

    let response: string | null;
    // A listen that ran on THIS bot must be answered by THIS bot, directly -- never
    // via the swarm. The [HEARD] packet arrives ~15s late (pipeline latency) and
    // loses Brain's message_id dedup to siblings' bare packets, so the listener gets
    // muted and a blind sibling answers (2026-06-13). Going direct pins the reply to
    // the companion who actually heard the track, with the [HEARD] block already in
    // `history` (appended to STM above).
    if (brainClient && !pendingMediaId) {
      // Relay mode: send assembled context to Phoenix Brain for inference.
      // Brain returns reply_text; falls back to direct inference on failure.
      const packet = buildThoughtPacket(
        COMPANION_ID,
        message.author.id,
        message.channelId,
        message.id,
        effectiveContent,
        systemPromptWithImp,
        groundedHistory,
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
        response = await withTyping(ch, () => adapterRef.current.generate(systemPromptWithImp, inferenceHistory, temperature, replyMaxTokensFor(COMPANION_ID, inferenceMode), inferenceSessionId));
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
          response = await withTyping(ch, () => adapterRef.current.generate(systemPromptWithImp, inferenceHistory, temperature, replyMaxTokensFor(COMPANION_ID, inferenceMode), inferenceSessionId));
        }
      }
    } else {
      response = await withTyping(ch, () => adapterRef.current.generate(systemPromptWithImp, inferenceHistory, temperature, replyMaxTokensFor(COMPANION_ID, inferenceMode), inferenceSessionId));
    }

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
      if (floorClaimed && redis) await releaseFloor(redis, COMPANION_ID).catch(() => {});
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
          if (floorClaimed && redis) await releaseFloor(redis, COMPANION_ID).catch(() => {});
          distillationCounter.set(message.channelId, (distillationCounter.get(message.channelId) ?? 0) + 1);
          return;
        }
      } else {
        const echo = echoScore(response, channelHistory.map(m => m.content));
        if (echo >= echoThreshold()) {
          console.warn(`[${COMPANION_ID}] echo-gated reply (score=${echo.toFixed(2)}) -- staying silent`);
          if (floorClaimed && redis) await releaseFloor(redis, COMPANION_ID).catch(() => {});
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
    const replyToMessageId = computeReplyRef(senderCtx.isCompanionBot, spine !== null, message.id);

    // Thread spine (task 10): strip a companion-authored [LANDS: ...] marker before ANY
    // send path below (voice synthesis, text content, and the error-fallback content all
    // read from `response`) so the marker never reaches Discord or the TTS engine. Only
    // parsed when a spine is active -- without one there's no thread to land, and the
    // marker syntax is not something companions are prompted to emit.
    const { cleaned: spineCleanedResponse, resolution: spineResolution } = spine ? parseLandMarker(response) : { cleaned: response, resolution: null };
    response = spineCleanedResponse;

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
      if (spineResolution) await librarian.convoLand(spine.thread.id, { resolution: spineResolution, landed_by: COMPANION_ID }).catch(() => {});
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
        librarian.journalSpeech(response, message.channelId, sent[0]!.id));
      // Shared-experience: this reply IS the companion's reaction to the track.
      if (pendingMediaId) {
        const mediaId = pendingMediaId;
        writeQueue.fireAndForget(`media:react:${COMPANION_ID}:${mediaId}`, () =>
          reactToExperience(mediaId, COMPANION_ID, response, cfg.halsethSecret));
      }
    }

    if (floorClaimed && redis) await releaseFloor(redis, COMPANION_ID).catch(() => {});
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
      });
    }).catch((e) => console.error(`[${COMPANION_ID}] judgeWriteback failed:`, e));

    if (attribution.source === "fallback") {
      const who = attribution.isOwner ? "owner (via dedup)" : `user ${attribution.discordUserId}`;
      writeQueue.fireAndForget(`note:pk-fallback:${message.channelId}`, async () => {
        await librarian.addCompanionNote(`PK attribution unavailable for message in channel ${message.channelId}; attributed to ${who}`, message.channelId);
      });
    }
}
