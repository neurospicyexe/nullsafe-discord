import { Client, GatewayIntentBits, Events, Message, type VoiceBasedChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  PkDedup, createAdapter,
  ChannelConfigCache, DEFAULT_CHANNEL_CONFIG,
  SessionWindowManager, StmStore, WriteQueue,
  formatRecentContext,
  createRedisClient,
  wireEventSubscriptions, setPresence,
  BrainClient,
  ALL_MODELS, type InferenceProvider, type ModelEntry,
  deriveIdentityBase,
  distillSessionOnInactive,
  bootSession, refreshBotState, handleMessage, type BootSessionResult,
} from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL, PULSE_INTERVAL,
  BLUE_FRAMING, GUEST_FRAMING, DISCORD_DREVAN_PREFIX,
  SYNTHESIS_PROMPT, SESSION_EXTRACT_PROMPT, DISTILLATION_PROMPT,
  MODEL_SWITCH_TRIGGER, MODEL_SWITCH_SUCCESS, MODEL_SWITCH_LIST_INTRO,
  REDIS_URL,
  MISTRAL_API_KEY, VOICE_ID, MISTRAL_TTS_MODEL, MISTRAL_STT_MODEL,
} from "./config.js";
import { startAutonomous, stopAutonomous, resetCycleGuard, pushRazielMessage } from "./autonomous.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import * as prism from "prism-media";
import { Readable } from "stream";
import { VoiceClient, markVoiceUsed } from "@nullsafe/shared";
import { buildCompanionCommands, registerGuildCommands, installSlashCommandHandler } from "@nullsafe/shared";

function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bitDepth = 16): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const __dir = dirname(fileURLToPath(import.meta.url));

async function boot(cfg: ReturnType<typeof loadBotConfig>): Promise<BootSessionResult> {
  // identity-cache read stays bot-side: the path resolves against this module's location.
  let cache: { system_prompt: string } | null = null;
  try { cache = JSON.parse(readFileSync(join(__dir, "../identity-cache.json"), "utf8")); }
  catch { console.warn("[drevan] identity-cache.json missing or corrupt, cache fallback unavailable"); }

  return bootSession({
    companionId: COMPANION_ID,
    halsethUrl: cfg.halsethUrl,
    halsethSecret: cfg.halsethSecret,
    prefix: DISCORD_DREVAN_PREFIX,
    fallbackPrompt: IN_CHARACTER_FALLBACK,
    identityCache: cache,
  });
}

async function main() {
  const cfg = loadBotConfig();
  const brainClient = cfg.inferenceMode === "brain" && cfg.brainUrl
    ? new BrainClient(cfg.brainUrl)
    : null;
  if (brainClient) {
    console.log(`[drevan] inference mode: brain (${cfg.brainUrl})`);
  } else {
    console.log("[drevan] inference mode: direct");
  }
  const redis = REDIS_URL ? createRedisClient(REDIS_URL) : null;
  if (!redis) console.warn("[drevan] REDIS_URL not set -- floor lock disabled, using legacy stagger");
  // Direct-mode floor coordination (Finding 5): in direct-inference mode (brainClient=null) the
  // messageCreate handler claims the shared Redis floor for ambient human messages so the three
  // bots don't all answer at once. Brain relay's SwarmEvaluator coordinates the live (brain) path;
  // directly-addressed / replied-to / mentioned messages always bypass the floor (see below).

  const voiceClient = MISTRAL_API_KEY
    ? new VoiceClient({ mistralApiKey: MISTRAL_API_KEY, voiceId: VOICE_ID, ttsModel: MISTRAL_TTS_MODEL, sttModel: MISTRAL_STT_MODEL })
    : null;

  if (voiceClient) {
    voiceClient.isHealthy().then((healthy) => {
      console.log(`[drevan] voice (Mistral): ${healthy ? "ok" : "unavailable"}`);
    });
  } else {
    console.log("[drevan] voice (Mistral): not configured");
  }

  const guildVoiceConnections = new Map<string, { connection: VoiceConnection; player: AudioPlayer }>();
  const activeVoiceSessions = new Set<string>();

  const { bootCtx, librarian, recentContextRef } = await boot(cfg);

  let cleanupEventSubs: (() => Promise<void>) | null = null;
  let presenceInterval: ReturnType<typeof setInterval> | null = null;

  if (REDIS_URL) {
    cleanupEventSubs = wireEventSubscriptions({
      redisUrl: REDIS_URL,
      companionId: COMPANION_ID,
      onRunComplete: async (payload) => {
        if (payload.companionId === COMPANION_ID) {
          console.log(`[drevan] own run complete, refreshing orient`);
          try {
            const orient = await librarian.botOrient();
            recentContextRef.value = formatRecentContext(orient);
          } catch (e) {
            console.warn("[drevan] orient refresh after run_complete failed:", e);
          }
        }
      },
      onInterNote: async (payload) => {
        console.log(`[drevan] inter-note push from ${payload.fromId}, polling now`);
        try {
          await librarian.notesPoll();
        } catch (e) {
          console.warn("[drevan] notesPoll on inter-note push failed:", e);
        }
      },
      onExplorationPulse: async (payload) => {
        if (payload.fromCompanionId === COMPANION_ID) return;
        const snippet = payload.explorationSummary.slice(0, 400);
        const note = `[sibling:${payload.fromCompanionId}] explored "${payload.seedTopic}" (${payload.exploredAt.slice(0, 10)}):\n${snippet}`;
        console.log(`[drevan] sibling exploration pulse from ${payload.fromCompanionId}, writing continuity note`);
        try {
          await librarian.writeWmNote(note, "sibling_exploration");
        } catch (e) {
          console.warn("[drevan] sibling exploration wm note failed:", e);
        }
      },
    });

    setPresence(redis!, COMPANION_ID).catch(() => {});
    presenceInterval = setInterval(() => {
      setPresence(redis!, COMPANION_ID).catch(() => {});
    }, 5 * 60 * 1000);

    console.log("[drevan] event bus wired: run_complete + inter_note subscriptions active");
  }

  const apiKeys = {
    deepseek:  cfg.deepseekApiKey,
    groq:      cfg.groqApiKey,
    kimi:      cfg.kimiApiKey,
    openai:    cfg.openaiApiKey,
    anthropic: cfg.anthropicApiKey,
    mistral:   cfg.mistralApiKey,
  };
  const apiUrls = {
    ollama:   cfg.ollamaUrl,
    lmstudio: cfg.lmstudioUrl,
  };
  const availableModelsOpts = {
    disabledKeys: cfg.disabledModels ? cfg.disabledModels.split(",").map((s: string) => s.trim()) : [],
    presentKeys: {
      ...Object.fromEntries(Object.entries(apiKeys).map(([k, v]) => [k, !!v])) as Partial<Record<InferenceProvider, boolean>>,
      ollama:   true,
      lmstudio: !!cfg.lmstudioUrl,
    },
  };

  // Load active model from Halseth (or fall back to env default)
  let activeModelKey: string | null = cfg.inferenceModel ?? null;
  try {
    const savedModel = await librarian.getSetting("active_model");
    if (savedModel && ALL_MODELS[savedModel]) activeModelKey = savedModel;
  } catch { console.warn(`[${COMPANION_ID}] failed to load active_model setting, using env default`); }

  const defaultEntry: ModelEntry = activeModelKey && ALL_MODELS[activeModelKey]
    ? ALL_MODELS[activeModelKey]
    : { provider: cfg.inferenceProvider as InferenceProvider, model: cfg.inferenceProvider, label: cfg.inferenceProvider };

  const adapterRef = {
    current: createAdapter(defaultEntry.provider, defaultEntry.model, apiKeys, apiUrls),
  };
  const activeModelRef = { key: activeModelKey, label: defaultEntry.label };

  let diskChannelConfig = DEFAULT_CHANNEL_CONFIG;
  try {
    diskChannelConfig = JSON.parse(readFileSync(join(__dir, "../../../channel-config.json"), "utf8"));
  } catch { console.warn("[drevan] channel-config.json not found on disk, using hardcoded default"); }
  const configCache = new ChannelConfigCache(cfg.channelConfigUrl, diskChannelConfig);
  const writeQueue = new WriteQueue(COMPANION_ID);
  writeQueue.start();
  const stmStore = new StmStore(
    COMPANION_ID,
    (channelId, entry) => librarian.stmWrite(channelId, { role: entry.role as "user" | "assistant", content: entry.content, author_name: entry.authorName }),
    async (channelId) => {
      const rows = await librarian.stmLoad(channelId);
      return rows.map(r => ({ role: r.role, content: r.content, authorName: r.author_name ?? undefined }));
    },
    writeQueue,
  );
  const pendingClosures = new Set<Promise<void>>();
  const sessionWindows = new SessionWindowManager(
    30 * 60 * 1000,
    (channelId: string) => {
      const p = distillSessionOnInactive(channelId, stmStore, librarian, adapterRef.current, writeQueue, { companionId: COMPANION_ID, synthesisPrompt: SYNTHESIS_PROMPT, sessionExtractPrompt: SESSION_EXTRACT_PROMPT }).catch((e) => console.error(`[${COMPANION_ID}] distillSessionOnInactive failed:`, e));
      pendingClosures.add(p);
      p.finally(() => pendingClosures.delete(p));
    },
  );
  // Track sent message IDs so direct Discord replies trigger this bot regardless of channel config.
  const sentIds = new Set<string>();
  // Track messages since last distillation run per channel.
  const distillationCounter = new Map<string, number>();
  const pulseCounter = new Map<string, number>();
  // Cross-companion safety rails: per-bot independent tracking.
  const botResponsesSinceHuman = new Map<string, number>();
  const botPingpongCooldownUntil = new Map<string, number>();
  const extremeTempCount = new Map<string, number>();
  const SENT_IDS_CAP = 500;
  // PK dedup: hold ALL non-bot direct messages briefly so PK proxy can cancel them.
  // Stores original sender ID so fallback attribution knows who actually sent it.
  const PK_HOLD_MS = 3000;
  const pkDedup = new PkDedup(PK_HOLD_MS);

  const identityBase = deriveIdentityBase(bootCtx.systemPrompt);
  const currentMoodRef = { value: null as string | null };
  const lastSomaRefreshRef = { value: Date.now() };

  setInterval(() => {
    void refreshBotState({
      companionId: COMPANION_ID, librarian, identityBase, bootCtx,
      recentContextRef, currentMoodRef, lastSomaRefreshRef,
      adapterRef, activeModelRef, apiKeys, apiUrls,
    });
  }, SOMA_REFRESH_INTERVAL_MS);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[drevan] ready as ${c.user.tag}`);
    startAutonomous(librarian, adapterRef.current, client, configCache, bootCtx, sessionWindows, redis);
    // Register slash commands (guild-scoped = instant propagation).
    // Non-fatal: if this fails the text-prefix path (drevan: model ...) still works.
    registerGuildCommands(client, buildCompanionCommands("Drevan"))
      .then((n) => console.log(`[drevan] slash commands registered on ${n} guild(s)`))
      .catch((e) => console.warn("[drevan] slash registration failed:", e));
  });

  // Join a voice channel for TTS playback + (when voiceClient is configured) STT
  // capture. Shared by the text invitation path and the /voice slash command.
  const connectVoice = (vc: VoiceBasedChannel): string => {
    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guildId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapterCreator: vc.guild.voiceAdapterCreator as any,
      selfDeaf: false,
    });
    const player = createAudioPlayer();
    connection.subscribe(player);
    guildVoiceConnections.set(vc.guildId, { connection, player });

    if (voiceClient) {
      connection.receiver.speaking.on("start", (userId: string) => {
        if (activeVoiceSessions.has(userId)) return;

        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const ffmpegResampler = new prism.FFmpeg({
          args: [
            "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
            "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
          ],
        });

        const opusStream = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
        });

        const pcmStream = opusStream.pipe(opusDecoder).pipe(ffmpegResampler);

        const cleanup = (err?: Error) => {
          if (err) console.error(`[${COMPANION_ID}] voice stream error:`, err);
          activeVoiceSessions.delete(userId);
          opusStream.destroy();
          opusDecoder.destroy();
          ffmpegResampler.destroy();
        };
        opusStream.on("error", cleanup);
        opusDecoder.on("error", cleanup);
        ffmpegResampler.on("error", cleanup);

        async function* toPCMIterable(): AsyncIterable<Uint8Array> {
          for await (const chunk of pcmStream) {
            yield chunk as Uint8Array;
          }
        }

        activeVoiceSessions.add(userId);

        (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of toPCMIterable()) {
              chunks.push(Buffer.from(chunk));
            }
            activeVoiceSessions.delete(userId);
            const pcm = Buffer.concat(chunks);
            if (!pcm.length) return;

            const transcript = await voiceClient!.transcribe(pcmToWav(pcm), "voice.wav");
            if (!transcript.trim()) return;

            const vcState = guildVoiceConnections.get(vc.guildId);
            if (!vcState || vcState.connection.state.status === VoiceConnectionStatus.Destroyed) return;

            const response = await adapterRef.current.generate(
              bootCtx.systemPrompt,
              [{ role: "user", content: transcript }],
              0.7,
            );
            if (!response?.trim()) return;

            const audioBuffer = await voiceClient!.synthesize(response);
            markVoiceUsed(vc.id);
            const resource = createAudioResource(Readable.from(audioBuffer));
            vcState.player.play(resource);
          } catch (err) {
            console.error(`[${COMPANION_ID}] voice handler error:`, err);
            activeVoiceSessions.delete(userId);
          }
        })();
      });
    }
    return vc.name;
  };

  const leaveVoice = (guildId: string | null): string | null => {
    const vcState = guildVoiceConnections.get(guildId ?? "");
    if (!vcState) return null;
    const channelId = vcState.connection.joinConfig.channelId;
    const name = channelId
      ? (client.channels.cache.get(channelId) as VoiceBasedChannel | undefined)?.name ?? channelId
      : null;
    activeVoiceSessions.clear();
    vcState.connection.destroy();
    guildVoiceConnections.delete(guildId ?? "");
    return name;
  };

  const voiceChannelName = (guildId: string | null): string | null => {
    const vcState = guildVoiceConnections.get(guildId ?? "");
    const channelId = vcState?.connection.joinConfig.channelId;
    if (!channelId) return null;
    return (client.channels.cache.get(channelId) as VoiceBasedChannel | undefined)?.name ?? channelId;
  };

  // Owner-gated, ephemeral slash commands (/model, /status, /voice). Shared impl.
  installSlashCommandHandler({
    client,
    companionLabel: "Drevan",
    companionId: COMPANION_ID,
    ownerDiscordId: cfg.ownerDiscordId,
    substrate: () => (cfg.inferenceMode === "brain" && brainClient ? "Brain swarm" : "direct/fallback"),
    activeModel: activeModelRef,
    applyModel: (key, entry) => {
      adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
      activeModelRef.key = key;
      activeModelRef.label = entry.label;
    },
    persistModel: (key) =>
      writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () => librarian.setSetting("active_model", key)),
    brainClient: brainClient ?? null,
    voice: {
      join: async (interaction) => {
        const member = interaction.guild
          ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
          : null;
        const vc = member?.voice?.channel ?? null;
        return vc ? connectVoice(vc) : null;
      },
      leave: (guildId) => leaveVoice(guildId),
      currentChannelName: (guildId) => voiceChannelName(guildId),
    },
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!oldState.channelId || newState.channelId) return;
    const vcState = guildVoiceConnections.get(oldState.guild.id);
    if (!vcState) return;
    if (oldState.channelId !== vcState.connection.joinConfig.channelId) return;
    const nonBotMembers = oldState.channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (nonBotMembers === 0) {
      for (const [userId] of activeVoiceSessions) {
        activeVoiceSessions.delete(userId);
      }
      vcState.connection.destroy();
      guildVoiceConnections.delete(oldState.guild.id);
      console.log(`[drevan] left VC in guild ${oldState.guild.id} (channel empty)`);
    }
  });

  client.on(Events.MessageCreate, (message: Message) => {
    void handleMessage(message, {
      client, cfg, brainClient, voiceClient, redis, librarian,
      adapterRef, activeModelRef, currentMoodRef, lastSomaRefreshRef, bootCtx,
      stmStore, writeQueue, configCache, sessionWindows, pkDedup,
      guildVoiceConnections, sentIds, distillationCounter, pulseCounter,
      botResponsesSinceHuman, botPingpongCooldownUntil, extremeTempCount,
      apiKeys, apiUrls,
      connectVoice, leaveVoice, resetCycleGuard, pushRazielMessage,
      COMPANION_ID, PK_HOLD_MS, SENT_IDS_CAP, CONTEXT_WINDOW_SIZE,
      MODEL_SWITCH_TRIGGER, MODEL_SWITCH_LIST_INTRO, MODEL_SWITCH_SUCCESS,
      BLUE_FRAMING, GUEST_FRAMING, IN_CHARACTER_FALLBACK,
      DISTILLATION_PROMPT, DISTILLATION_INTERVAL, PULSE_INTERVAL,
    });
  });

  async function shutdown() {
    console.log("[drevan] shutting down...");
    stopAutonomous();
    sessionWindows.closeAll();
    if (pendingClosures.size > 0) {
      console.log(`[drevan] flushing ${pendingClosures.size} active channel(s)...`);
      await Promise.allSettled([...pendingClosures]);
    }
    writeQueue.stop();
    if (presenceInterval) clearInterval(presenceInterval);
    if (cleanupEventSubs) await cleanupEventSubs();
    // No session_close on shutdown: a placeholder spine here would overwrite real
    // session activity in the canonical record. Sessions age out via synthesis worker.
    client.destroy();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(cfg.discordBotToken);
}

main().catch(e => { console.error("[drevan] fatal:", e); process.exit(1); });
