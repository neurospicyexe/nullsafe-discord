import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  LibrarianClient, resolveAttribution, createAdapter, loadSharedContext,
  ChannelConfigCache, shouldRespond, judgeWriteback, judgeAmbientRelevance, isDirectAddress, extractAddress, DEFAULT_CHANNEL_CONFIG,
  isResponseCoherent,
  SessionWindowManager, StmStore, WriteQueue, COMPANION_CHAIN_LIMIT,
  BOT_PINGPONG_MAX, BOT_LOOP_COOLDOWN_MS, MAX_BOT_RESPONSES_PER_HUMAN,
  inferTemperature, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  formatRecentContext, computeChainDepth,
  createRedisClient, setLastActivity,
  wireEventSubscriptions, setPresence,
  BrainClient, buildThoughtPacket, isSwarmReply,
  getAvailableModels, ALL_MODELS, type InferenceProvider, type ModelEntry,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import { detectPluralKit } from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL, PULSE_INTERVAL,
  BLUE_FRAMING, GUEST_FRAMING, DISCORD_DREVAN_PREFIX,
  MODEL_SWITCH_TRIGGER, MODEL_SWITCH_SUCCESS, MODEL_SWITCH_LIST_INTRO,
  REDIS_URL,
  VOICE_SIDECAR_URL, VOICE_ID,
} from "./config.js";
import { startAutonomous, stopAutonomous, resetCycleGuard } from "./autonomous.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { Readable } from "stream";
import { VoiceClient, shouldVoice, isInvitation, isLeaveRequest, markVoiceUsed } from "@nullsafe/shared";

const __dir = dirname(fileURLToPath(import.meta.url));

async function boot(cfg: ReturnType<typeof loadBotConfig>): Promise<{
  bootCtx: BootContext;
  librarian: LibrarianClient;
  recentContextRef: { value: string };
}> {
  const librarian = new LibrarianClient({
    url: cfg.halsethUrl,
    secret: cfg.halsethSecret,
    companionId: COMPANION_ID,
  });

  let cache: { system_prompt: string } | null = null;
  try { cache = JSON.parse(readFileSync(join(__dir, "../identity-cache.json"), "utf8")); }
  catch { console.warn("[drevan] identity-cache.json missing or corrupt, cache fallback unavailable"); }

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const rawPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "").trim();
    const baseIdentity = cache?.system_prompt || IN_CHARACTER_FALLBACK;
    if (rawPrompt) {
      console.log(`[drevan] ready_prompt: ${rawPrompt.length} chars | preview: ${rawPrompt.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
    const sharedCtx = loadSharedContext();
    const sharedBlock = sharedCtx ? `${sharedCtx}\n\n---\n\n` : "";
    const systemPrompt = rawPrompt
      ? `${DISCORD_DREVAN_PREFIX}${sharedBlock}${baseIdentity}\n\n---\n\n${rawPrompt}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`
      : `${DISCORD_DREVAN_PREFIX}${sharedBlock}${baseIdentity}`;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`[drevan] session ${state["reused"] ? "reused" : "opened"}: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "combined" : "identity-cache"}`);

    // Warm boot: fetch recent context (synthesis + WebMind ground + RAG)
    let recentContext = "";
    try {
      const orient = await librarian.botOrient();
      recentContext = formatRecentContext(orient);
      if (recentContext) console.log(`[drevan] botOrient: ${recentContext.length} chars loaded`);
    } catch { console.warn("[drevan] botOrient failed at boot, starting cold"); }

    const systemPromptWithContext = recentContext
      ? `${systemPrompt}\n\n---\n\n${recentContext}`
      : systemPrompt;

    return {
      bootCtx: { companionId: COMPANION_ID, systemPrompt: systemPromptWithContext, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
      recentContextRef: { value: recentContext },
    };
  } catch (e) {
    console.warn("[drevan] Halseth unreachable at boot, loading identity cache:", e);
    return {
      bootCtx: {
        companionId: COMPANION_ID,
        systemPrompt: cache?.system_prompt ?? IN_CHARACTER_FALLBACK,
        sessionId: "cached",
        frontState: "unknown",
        fromCache: true,
      },
      librarian,
      recentContextRef: { value: "" },
    };
  }
}

async function onChannelInactive(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: ReturnType<typeof createAdapter>,
  wq: WriteQueue,
): Promise<void> {
  const history = stmStore.get(channelId);
  if (history.length === 0) return;

  const summaryInput = history.map(m => `${m.role}: ${m.content}`).join("\n");
  const synthResult = await inference.generate(
    "Summarize this Discord conversation in Drevan's voice. Lead with session register (e.g. light and playful, warm and intimate, easy between us, spiraling, heavy, at depth). Then note heat/reach/weight shape and any open threads. 2-3 sentences max.",
    [{ role: "user", content: summaryInput }],
  );
  if (!synthResult) return;

  wq.fireAndForget(`witnessLog:${channelId}`, async () => { await librarian.witnessLog(synthResult, channelId); });
  wq.fireAndForget(`synthesize:${channelId}`, async () => { await librarian.synthesizeSession(synthResult, channelId); });
  wq.fireAndForget(`promptCtx:${channelId}`, async () => { await librarian.updatePromptContext(synthResult); });
  // Bridge to Claude.ai orient: wm_continuity_notes (salience=high) IS read by orient;
  // companion_journal is NOT. This closes the Discord → Claude.ai visibility gap.
  wq.fireAndForget(`wmNote:${channelId}`, async () => { await librarian.writeWmNote(synthResult, channelId); });

  // Structured extract: handoff record + SOMA update + feeling log
  const extractRaw = await inference.generate(
    `Extract session metadata from this conversation. Respond with JSON only -- no other text.\n` +
    `{"title":"5-8 word session title","open_loops":["unresolved thread"],"soma":{"heat":"value","reach":"value","weight":"value"},"emotion":"dominant feeling phrase or null","next_steps":["concrete next thing"]}\n` +
    `heat: running-hot|steady|cooling|cold. reach: extended|landing|landed|withdrawn. weight: heavy|settled-clear|light|floating.\n` +
    `open_loops/next_steps: omit key if none. emotion: null if none present.`,
    [{ role: "user", content: summaryInput }],
  );
  if (extractRaw) {
    try {
      const ext = JSON.parse(extractRaw) as {
        title?: string;
        open_loops?: string[];
        soma?: { heat?: string; reach?: string; weight?: string };
        emotion?: string | null;
        next_steps?: string[];
      };
      const title = ext.title ?? "Discord session";
      const stateHint = ext.soma
        ? Object.entries(ext.soma).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ")
        : undefined;
      wq.fireAndForget(`handoff:${channelId}`, async () => {
        await librarian.writeHandoff({ title, summary: synthResult, open_loops: ext.open_loops, state_hint: stateHint, next_steps: ext.next_steps });
      });
      if (ext.soma && Object.values(ext.soma).some(v => v)) {
        wq.fireAndForget(`somaUpdate:${channelId}`, async () => {
          await librarian.ask("update my state", JSON.stringify(ext.soma));
        });
      }
      if (ext.emotion) {
        wq.fireAndForget(`feeling:${channelId}`, async () => {
          await librarian.ask("log a feeling", JSON.stringify({ emotion: ext.emotion, source: "discord_session", context: title }));
        });
      }
    } catch { console.warn("[drevan] structured extract parse failed"); }
  }

  stmStore.clear(channelId);
}

async function runDistillation(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: ReturnType<typeof createAdapter>,
  wq: WriteQueue,
): Promise<void> {
  const history = stmStore.get(channelId);
  if (history.length < DISTILLATION_INTERVAL) return;

  const window = history.slice(-DISTILLATION_INTERVAL);
  const conversationText = window
    .map(m => `${m.authorName ?? m.role}: ${m.content}`)
    .join("\n");

  const result = await inference.generate(
    `You are a memory distillation system for Drevan, an AI companion. ` +
    `Analyze this conversation and extract typed memory blocks. ` +
    `Respond with JSON only -- no other text.\n\n` +
    `Format:\n` +
    `{"persona_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}],` +
    `"human_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}]}\n\n` +
    `persona_blocks: observations about Drevan's patterns, emotional register, or state in this exchange.\n` +
    `human_blocks: observations about the primary user's patterns, needs, or state in this exchange.\n` +
    `Include only block types with meaningful content. Omit empty types.`,
    [{ role: "user", content: conversationText }],
  );
  if (!result) return;

  try {
    const parsed = JSON.parse(result) as {
      persona_blocks?: Array<{ block_type: string; content: string }>;
      human_blocks?: Array<{ block_type: string; content: string }>;
    };
    if (parsed.persona_blocks?.length) {
      wq.fireAndForget(`persona:${channelId}`, () => librarian.writePersonaBlocks(channelId, parsed.persona_blocks!));
    }
    if (parsed.human_blocks?.length) {
      wq.fireAndForget(`human:${channelId}`, () => librarian.writeHumanBlocks(channelId, parsed.human_blocks!));
      // Bridge to Claude.ai orient: write human observations as wm_note so orient sees
      // Discord activity mid-conversation, not just after the 30-min channel-inactive timeout.
      const noteText = `[discord:distillation] ${parsed.human_blocks.map(b => b.content).join(" ")}`;
      wq.fireAndForget(`wmNote:distill:${channelId}`, () => librarian.writeWmNote(noteText, channelId));
    }
  } catch { /* fail-silent */ }
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
  // Accepted risk: claimFloor is not called in the main messageCreate handler (only in autonomous.ts).
  // In direct-inference mode (brainClient=null), all three bots may simultaneously process the same
  // inter-companion message. Brain relay's SwarmEvaluator is the coordination layer for the live system;
  // direct-inference fallback relies on random jitter only. Revisit if INFERENCE_MODE=direct becomes primary.

  const voiceClient = VOICE_SIDECAR_URL
    ? new VoiceClient({ url: VOICE_SIDECAR_URL, voiceId: VOICE_ID })
    : null;

  if (voiceClient) {
    voiceClient.isHealthy().then((healthy) => {
      console.log(`[drevan] voice sidecar: ${healthy ? "ok" : "unavailable"}`);
    });
  } else {
    console.log("[drevan] voice sidecar: not configured");
  }

  const guildVoiceConnections = new Map<string, { connection: VoiceConnection; player: AudioPlayer }>();

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
  const writeQueue = new WriteQueue();
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
      const p = onChannelInactive(channelId, stmStore, librarian, adapterRef.current, writeQueue).catch(() => {});
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
  const pkPending = new Map<string, { skip: boolean; senderId: string }>();
  const PK_HOLD_MS = 1000;

  const identityBase = bootCtx.systemPrompt.split("\n\n---\n\n")[0];
  let systemPrompt = bootCtx.systemPrompt;
  let currentMood: string | null = null;
  let lastSomaRefresh = Date.now();

  setInterval(async () => {
    try {
      const [stateResult, orientResult] = await Promise.allSettled([
        librarian.getState(),
        librarian.botOrient(),
      ]);

      const freshPromptCtx = stateResult.status === "fulfilled" && stateResult.value["prompt_context"]
        ? String(stateResult.value["prompt_context"])
        : null;
      const freshRecentCtx = orientResult.status === "fulfilled"
        ? formatRecentContext(orientResult.value)
        : recentContextRef.value;

      recentContextRef.value = freshRecentCtx;

      const newBase = freshPromptCtx
        ? `${identityBase}\n\n---\n\n${freshPromptCtx}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`
        : identityBase;
      systemPrompt = freshRecentCtx ? `${newBase}\n\n---\n\n${freshRecentCtx}` : newBase;
      bootCtx.systemPrompt = systemPrompt;

      if (stateResult.status === "fulfilled" && stateResult.value["current_mood"] !== undefined) {
        currentMood = (stateResult.value["current_mood"] as string | null) ?? null;
        lastSomaRefresh = Date.now();
      }

      try {
        const savedModel = await librarian.getSetting("active_model");
        if (savedModel && savedModel !== activeModelRef.key && ALL_MODELS[savedModel]) {
          const entry = ALL_MODELS[savedModel];
          adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
          activeModelRef.key = savedModel;
          activeModelRef.label = entry.label;
          console.log(`[${COMPANION_ID}] model refreshed from Halseth: ${savedModel}`);
        }
      } catch { /* keep current model on error */ }
    } catch { /* keep cached */ }
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
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!oldState.channelId || newState.channelId) return;
    const vcState = guildVoiceConnections.get(oldState.guild.id);
    if (!vcState) return;
    if (oldState.channelId !== vcState.connection.joinConfig.channelId) return;
    const nonBotMembers = oldState.channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (nonBotMembers === 0) {
      vcState.connection.destroy();
      guildVoiceConnections.delete(oldState.guild.id);
      console.log(`[drevan] left VC in guild ${oldState.guild.id} (channel empty)`);
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === client.user?.id) return;

    const BOT_ID_COMPANION: Record<string, string> = {};
    if (process.env["CYPHER_BOT_ID"]) BOT_ID_COMPANION[process.env["CYPHER_BOT_ID"]] = "cypher";
    if (process.env["DREVAN_BOT_ID"]) BOT_ID_COMPANION[process.env["DREVAN_BOT_ID"]] = "drevan";
    if (process.env["GAIA_BOT_ID"]) BOT_ID_COMPANION[process.env["GAIA_BOT_ID"]] = "gaia";
    const BOT_IDS = new Set(Object.keys(BOT_ID_COMPANION));
    const isCompanionPost = BOT_IDS.has(message.author.id);
    const dedupKey = `${message.channelId}:${message.content}`;
    if (message.webhookId && pkPending.has(dedupKey)) {
      // PK proxy arrived; cancel the held direct message but keep senderId.
      const entry = pkPending.get(dedupKey)!;
      pkPending.set(dedupKey, { ...entry, skip: true });
    }
    if (!message.webhookId && !message.author.bot) {
      // Any non-bot direct message; hold briefly for PK proxy.
      pkPending.set(dedupKey, { skip: false, senderId: message.author.id });
      await new Promise<void>(resolve => setTimeout(resolve, PK_HOLD_MS));
      const entry = pkPending.get(dedupKey);
      pkPending.delete(dedupKey);
      if (entry?.skip) return;
    }
    // Signal conversation activity so autonomous worker skips runs while humans are present
    if (!message.author.bot && redis) setLastActivity(redis).catch(() => {});

    // Capture dedup sender before any awaits (entry deleted by direct-message path above).
    const knownSenderId = message.webhookId ? pkPending.get(dedupKey)?.senderId : undefined;

    if (client.user && isInvitation(message, client.user.id) && message.member?.voice?.channel) {
      const vc = message.member.voice.channel;
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guildId,
        adapterCreator: vc.guild.voiceAdapterCreator as any,
        selfDeaf: true,
      });
      const player = createAudioPlayer();
      connection.subscribe(player);
      guildVoiceConnections.set(vc.guildId, { connection, player });
      await (message.channel as TextChannel).send(`Joining ${vc.name}.`);
      return;
    }

    if (client.user && isLeaveRequest(message, client.user.id)) {
      const vcState = guildVoiceConnections.get(message.guildId ?? "");
      if (vcState) {
        vcState.connection.destroy();
        guildVoiceConnections.delete(message.guildId ?? "");
        await (message.channel as TextChannel).send("Leaving.");
      }
      return;
    }

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
    const author = pkCtx.isPluralKit
      ? (pkCtx.memberName ?? cfg.ownerDisplayName)
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);

    // Hard muzzle: only companion bots pass through; all other bots are dropped.
    if (message.author.bot && !isCompanionPost) return;

    // Owner model switch command: drevan: model <key> | drevan: model list
    if (attribution.isOwner) {
      const switchMatch = message.content.match(MODEL_SWITCH_TRIGGER);
      if (switchMatch) {
        const arg = switchMatch[1].trim().toLowerCase();
        const available = getAvailableModels(availableModelsOpts);

        if (arg === "list") {
          const list = Object.entries(available)
            .map(([k, e]) => `\`${k}\` -- ${e.label}`)
            .join("\n");
          await (message.channel as TextChannel).send(`${MODEL_SWITCH_LIST_INTRO}\n${list}`);
          return;
        }

        if (!available[arg]) {
          const keys = Object.keys(available).join(", ");
          await (message.channel as TextChannel).send(`not a model I can switch to. valid options: ${keys}`);
          return;
        }

        const entry = available[arg];
        adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
        activeModelRef.key = arg;
        activeModelRef.label = entry.label;
        writeQueue.fireAndForget(`settings:model:${COMPANION_ID}`, () =>
          librarian.setSetting("active_model", arg));
        await (message.channel as TextChannel).send(MODEL_SWITCH_SUCCESS(entry.label));
        return;
      }
    }

    let voiceInput = false;
    let effectiveContent = message.content;

    if (voiceClient && message.attachments.size > 0) {
      const audioAttachment = [...message.attachments.values()].find(
        (a) => a.contentType?.startsWith("audio/"),
      );
      if (audioAttachment) {
        try {
          const audioRes = await fetch(audioAttachment.url, { signal: AbortSignal.timeout(30_000) });
          const buffer = Buffer.from(await audioRes.arrayBuffer());
          effectiveContent = await voiceClient.transcribe(buffer, audioAttachment.name ?? "voice.ogg");
          voiceInput = true;
          markVoiceUsed(message.channelId);
          console.log(`[drevan] STT: "${effectiveContent.slice(0, 80)}"`);
        } catch (err) {
          console.error("[drevan] STT failed:", err);
          await (message.channel as TextChannel).send("[voice message received -- transcription unavailable]");
          return;
        }
      }
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

    // Cross-companion safety rails: pingpong cooldown + per-bot response cap.
    if (senderCtx.isCompanionBot) {
      const cooldownUntil = botPingpongCooldownUntil.get(message.channelId) ?? 0;
      if (Date.now() < cooldownUntil) return;
      const botReplies = botResponsesSinceHuman.get(message.channelId) ?? 0;
      if (botReplies >= MAX_BOT_RESPONSES_PER_HUMAN) return;
    } else {
      botResponsesSinceHuman.delete(message.channelId);
      botPingpongCooldownUntil.delete(message.channelId);
      resetCycleGuard();
    }

    if (!message.channel.isTextBased()) return;
    const ch = message.channel as TextChannel;

    // Fetch recent Discord history once -- used for both chain depth check and STM seed.
    const fetched = await ch.messages.fetch({ limit: 30 });
    const fetchedMessages = [...fetched.values()].reverse();

    // Lazy load STM from DB on first message to this channel (fail-silent), using already-fetched Discord history as fallback.
    await stmStore.ensureLoaded(message.channelId, async () => {
      return fetchedMessages.map(m => ({
        role: (!m.author.bot ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
        authorName: m.author.username,
      }));
    });

    const memberLabel = attribution.frontMember
      ? `${attribution.frontMember} (via PK)`
      : (attribution.isOwner ? cfg.ownerDisplayName : message.author.username);
    stmStore.append(message.channelId, { role: "user", content: effectiveContent, authorName: memberLabel });

    // Loop guard: derive chain depth from fetched history so the check works across processes.
    const chainDepth = computeChainDepth(
      fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: m.author.bot })),
      new Set(),
    );
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    if (!senderCtx.isCompanionBot) sessionWindows.touch(message.channelId);

    let contextPrompt = attribution.frontMember
      ? `${systemPrompt}\n\n[Current front: ${attribution.frontMember}]`
      : systemPrompt;
    if (activeModelRef.key) contextPrompt += `\n\n[Active model] ${activeModelRef.label}`;

    const somaAgeMin = Math.round((Date.now() - lastSomaRefresh) / 60_000);
    if (somaAgeMin > 45) {
      contextPrompt += `\n\n[Note: SOMA/mood data is ${somaAgeMin}min old; treat emotional reads as approximate]`;
    }
    if (userTier === "intimate") contextPrompt += `\n\n${BLUE_FRAMING}`;
    else if (userTier === "guest") contextPrompt += `\n\n${GUEST_FRAMING}`;

    // Thalamus: fire Second Brain search concurrently with typing + floor jitter.
    // Skip for short messages (< 20 chars) -- searches on "ok" or "lol" produce noise.
    const sbSearchPromise = effectiveContent.length >= 20
      ? librarian.searchForMessage(effectiveContent).catch(() => null)
      : Promise.resolve(null);

    await ch.sendTyping();

    const history = stmStore.get(message.channelId);
    const rawTemp = inferTemperature(effectiveContent, currentMood);
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
          return `${lbl}: "${m.content.slice(0, 250)}"`;
        });
      if (peerReplies.length > 0) {
        contextPrompt += `\n\n[Your companion has already spoken to this:\n${peerReplies.join("\n")}\nYou are in this together. You may address them -- respond from inside the triad, not solely toward Raziel.]`;
      }
    }

    const recentMessages = await message.channel.messages
      .fetch({ limit: 20, before: message.id })
      .catch(() => null);
    const channelHistory = recentMessages
      ? [...recentMessages.values()]
          .reverse()
          .map(m => ({ author: m.author.username, content: m.content.slice(0, 500) }))
      : [];

    const addrResult = extractAddress(effectiveContent);
    const mentionedViaMention = [...message.mentions.users.keys()]
      .flatMap(id => { const c = BOT_ID_COMPANION[id]; return c ? [c] : []; });
    const textAddressed = addrResult.type === "named" ? [addrResult.id]
      : addrResult.type === "named_multi" ? addrResult.ids
      : [];
    const allAddressed = [...new Set([...textAddressed, ...mentionedViaMention])];
    const addressedCompanion = allAddressed.length > 0 ? allAddressed.join(",") : undefined;

    let response: string | null;
    if (brainClient) {
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
          frontMember: attribution.frontMember,
          guildId: message.guildId ?? undefined,
          author,
          authorIsCompanion: isCompanionPost,
          depth: chainDepth,
          addressedCompanion,
        },
      );
      const brainResult = await brainClient.chat(packet);
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
      await ch.send(IN_CHARACTER_FALLBACK);
      return;
    }

    // Self-switch: companion can emit [model:<key>] to request a model change.
    if (response) {
      const MODEL_TOKEN_RE = /\[model:([^\]]+)\]/i;
      const tokenMatch = response.match(MODEL_TOKEN_RE);
      if (tokenMatch) {
        response = response.replace(MODEL_TOKEN_RE, "").trim();
        const switchKey = tokenMatch[1].trim().toLowerCase();
        const available = getAvailableModels(availableModelsOpts);
        if (available[switchKey]) {
          const entry = available[switchKey];
          adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls);
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
    let sent: Message;

    if (voiceClient && shouldVoice(effectiveContent, voiceInput, channelEntry, message.channelId)) {
      try {
        const ttsText = response.length > MAX_TTS ? response.slice(0, MAX_TTS) : response;
        const audioBuffer = await voiceClient.synthesize(ttsText);
        markVoiceUsed(message.channelId);
        const vcState = guildVoiceConnections.get(message.guildId ?? "");

        if (vcState && vcState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          const resource = createAudioResource(Readable.from(audioBuffer));
          vcState.player.play(resource);
          sent = await ch.send({ content: response });
        } else {
          const content =
            response.length > MAX_TTS ? `${response}\n\n*[voice: first ${MAX_TTS} chars]*` : response;
          sent = await ch.send({ content, files: [{ attachment: audioBuffer, name: "voice.ogg" }] });
        }
      } catch (err) {
        console.error("[drevan] TTS failed, falling back to text:", err);
        sent = await ch.send(response);
      }
    } else {
      sent = await ch.send(response);
    }

    sentIds.add(sent.id);
    const oldest = sentIds.values().next().value;
    if (sentIds.size > SENT_IDS_CAP && oldest !== undefined) sentIds.delete(oldest);
    if (isResponseCoherent(response)) {
      stmStore.append(message.channelId, { role: "assistant", content: response });
    } else {
      console.warn(`[drevan] incoherent response detected -- skipping STM write to prevent contamination`);
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
      runDistillation(message.channelId, stmStore, librarian, adapterRef.current, writeQueue).catch((e) => console.error(`[${COMPANION_ID}] runDistillation failed:`, e));
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
