import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  LibrarianClient, resolveAttribution, createAdapter,
  ChannelConfigCache, shouldRespond, judgeWriteback, judgeAmbientRelevance, isDirectAddress, DEFAULT_CHANNEL_CONFIG,
  SessionWindowManager, StmStore, WriteQueue, COMPANION_CHAIN_LIMIT,
  BOT_PINGPONG_MAX, BOT_LOOP_COOLDOWN_MS, MAX_BOT_RESPONSES_PER_HUMAN,
  inferTemperature, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  formatRecentContext, computeChainDepth,
  createRedisClient, setLastActivity,
  wireEventSubscriptions, setPresence,
  BrainClient, buildThoughtPacket, isSwarmReply,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import { detectPluralKit } from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL,
  BLUE_FRAMING, GUEST_FRAMING, DISCORD_PEOPLE_CONTEXT,
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
import { VoiceClient } from "@nullsafe/shared";

const __dir = dirname(fileURLToPath(import.meta.url));

const VOICE_KEYWORDS = ["say", "speak", "tell me out loud", "voice this"];
const JOIN_KEYWORDS = ["join", "come in", "join me", "get in here"];
const LEAVE_KEYWORDS = ["leave", "get out", "disconnect"];

function shouldVoice(
  content: string,
  voiceInput: boolean,
  channelEntry?: { voice?: boolean },
): boolean {
  if (channelEntry?.voice) return true;
  if (voiceInput) return true;
  const lower = content.toLowerCase();
  return VOICE_KEYWORDS.some((k) => lower.includes(k));
}

function isInvitation(message: Message, botUserId: string): boolean {
  return (
    message.mentions.users.has(botUserId) &&
    JOIN_KEYWORDS.some((k) => message.content.toLowerCase().includes(k)) &&
    message.member?.voice?.channel != null
  );
}

function isLeaveRequest(message: Message, botUserId: string): boolean {
  return (
    message.mentions.users.has(botUserId) &&
    LEAVE_KEYWORDS.some((k) => message.content.toLowerCase().includes(k))
  );
}

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
    const systemPrompt = rawPrompt
      ? `${DISCORD_PEOPLE_CONTEXT}${baseIdentity}\n\n---\n\n${rawPrompt}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`
      : `${DISCORD_PEOPLE_CONTEXT}${baseIdentity}`;
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

  const voiceClient = VOICE_SIDECAR_URL
    ? new VoiceClient({ url: VOICE_SIDECAR_URL, voiceId: VOICE_ID })
    : null;

  if (voiceClient) {
    const healthy = await voiceClient.isHealthy();
    console.log(`[drevan] voice sidecar: ${healthy ? "ok" : "unavailable"}`);
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

  const inference = createAdapter(
    cfg.inferenceProvider,
    cfg.deepseekApiKey,
    cfg.groqApiKey,
    cfg.ollamaUrl,
    undefined,
    cfg.lmstudioUrl,
  );
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
      const p = onChannelInactive(channelId, stmStore, librarian, inference, writeQueue).catch(() => {});
      pendingClosures.add(p);
      p.finally(() => pendingClosures.delete(p));
    },
  );
  // Track sent message IDs so direct Discord replies trigger this bot regardless of channel config.
  const sentIds = new Set<string>();
  // Track messages since last distillation run per channel.
  const distillationCounter = new Map<string, number>();
  // Cross-companion safety rails: per-bot independent tracking.
  const botResponsesSinceHuman = new Map<string, number>();
  const botPingpongCooldownUntil = new Map<string, number>();
  const extremeTempCount = new Map<string, number>();
  const SENT_IDS_CAP = 500;
  // PluralKit dedup: hold direct owner messages briefly so PK proxy can cancel them.
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
    startAutonomous(librarian, inference, client, configCache, bootCtx, sessionWindows, redis);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!oldState.channelId || newState.channelId) return;
    const vcState = guildVoiceConnections.get(oldState.guild.id);
    if (!vcState) return;
    const nonBotMembers = oldState.channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (nonBotMembers === 0) {
      vcState.connection.destroy();
      guildVoiceConnections.delete(oldState.guild.id);
      console.log(`[drevan] left VC in guild ${oldState.guild.id} (channel empty)`);
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === client.user?.id) return;

    const BOT_IDS = new Set([
      process.env["CYPHER_BOT_ID"],
      process.env["DREVAN_BOT_ID"],
      process.env["GAIA_BOT_ID"],
    ].filter(Boolean) as string[]);
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
      ? (pkCtx.memberName ?? "Raziel")
      : (attribution.isOwner ? "Raziel" : message.author.username);

    // Hard muzzle: only companion bots pass through; all other bots are dropped.
    if (message.author.bot && !isCompanionPost) return;

    // STT: transcribe audio attachments before routing/response decisions.
    let voiceInput = false;
    let effectiveContent = message.content;

    if (voiceClient && message.attachments.size > 0) {
      const audioAttachment = [...message.attachments.values()].find(
        (a) => a.contentType?.startsWith("audio/"),
      );
      if (audioAttachment) {
        try {
          const audioRes = await fetch(audioAttachment.url);
          const buffer = Buffer.from(await audioRes.arrayBuffer());
          effectiveContent = await voiceClient.transcribe(buffer, audioAttachment.name ?? "voice.ogg");
          voiceInput = true;
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

    if (isAmbientOwnerOnly) {
      const relevant = await judgeAmbientRelevance(
        effectiveContent,
        COMPANION_ID,
        (sys, msgs) => inference.generate(sys, msgs as ChatMessage[], 0.3),
      );
      if (!relevant) return;
    } else if (!isReplyToMe && !shouldRespond(message.channelId, effectiveContent, senderCtx, COMPANION_ID, channelConfig, [])) {
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

    // Loop guard: derive chain depth from fetched history so the check works across processes.
    const chainDepth = computeChainDepth(
      fetchedMessages.map(m => ({ authorId: m.author.id, authorIsBot: m.author.bot })),
      new Set(),
    );
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    // Lazy load STM from DB on first message to this channel (fail-silent), using already-fetched Discord history as fallback.
    await stmStore.ensureLoaded(message.channelId, async () => {
      return fetchedMessages.map(m => ({
        role: (m.author.id === client.user?.id ? "assistant" : "user") as "user" | "assistant",
        content: m.content,
        authorName: m.author.username,
      }));
    });

    const memberLabel = attribution.frontMember
      ? `${attribution.frontMember} (via PK)`
      : message.author.username;
    stmStore.append(message.channelId, { role: "user", content: effectiveContent, authorName: memberLabel });

    sessionWindows.touch(message.channelId);

    let contextPrompt = attribution.frontMember
      ? `${systemPrompt}\n\n[Current front: ${attribution.frontMember}]`
      : systemPrompt;

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

    const recentMessages = await message.channel.messages
      .fetch({ limit: 20, before: message.id })
      .catch(() => null);
    const channelHistory = recentMessages
      ? [...recentMessages.values()]
          .reverse()
          .map(m => ({ author: m.author.username, content: m.content.slice(0, 500) }))
      : [];

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
        },
      );
      const brainResult = await brainClient.chat(packet);
      if (brainResult === null) {
        console.warn(`[${COMPANION_ID}] brain relay failed, falling back to direct inference`);
        response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
      } else if (isSwarmReply(brainResult)) {
        const slotReply = brainResult.responses[COMPANION_ID];
        if (slotReply === null || slotReply === undefined) return;
        response = slotReply;
      } else {
        if (brainResult.status === "ok" && brainResult.reply_text) {
          response = brainResult.reply_text;
        } else {
          console.warn(`[${COMPANION_ID}] brain relay failed (status=${brainResult.status}), falling back to direct inference`);
          response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
        }
      }
    } else {
      response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
    }

    if (!response) {
      await ch.send(IN_CHARACTER_FALLBACK);
      return;
    }

    const MAX_TTS = 2000;
    let sent: Message;

    if (voiceClient && shouldVoice(effectiveContent, voiceInput, channelEntry)) {
      try {
        const ttsText = response.length > MAX_TTS ? response.slice(0, MAX_TTS) : response;
        const audioBuffer = await voiceClient.synthesize(ttsText);
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
    stmStore.append(message.channelId, { role: "assistant", content: response });

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
      runDistillation(message.channelId, stmStore, librarian, inference, writeQueue).catch((e) => console.error(`[${COMPANION_ID}] runDistillation failed:`, e));
    }

    judgeWriteback(effectiveContent, response, inference, COMPANION_ID).then((wb) => {
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
    if (bootCtx.sessionId !== "cached") {
      await librarian.sessionClose({
        sessionId: bootCtx.sessionId,
        spine: "discord presence session ended",
        lastRealThing: "process shutdown",
        motionState: "at_rest",
      }).catch(() => {});
    }
    client.destroy();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(cfg.discordBotToken);
}

main().catch(e => { console.error("[drevan] fatal:", e); process.exit(1); });
