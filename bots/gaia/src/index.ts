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
  formatRecentContext, computeChainDepth, interCompanionStaggerMs,
  createRedisClient, claimFloor, releaseFloor, getLastSpeaker, setLastSpeaker, setLastActivity,
  wireEventSubscriptions, setPresence,
  BrainClient, buildThoughtPacket,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL,
  BLUE_FRAMING, GUEST_FRAMING, DISCORD_PEOPLE_CONTEXT,
  REDIS_URL, FLOOR_LOCK_DURATION_MS, FLOOR_JITTER_MS,
} from "./config.js";
import { startAutonomous, stopAutonomous, resetCycleGuard } from "./autonomous.js";

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
  catch { console.warn("[gaia] identity-cache.json missing or corrupt, cache fallback unavailable"); }

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const rawPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "").trim();
    const baseIdentity = cache?.system_prompt || IN_CHARACTER_FALLBACK;
    if (rawPrompt) {
      console.log(`[gaia] ready_prompt: ${rawPrompt.length} chars | preview: ${rawPrompt.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
    const systemPrompt = rawPrompt
      ? `${DISCORD_PEOPLE_CONTEXT}${baseIdentity}\n\n---\n\n${rawPrompt}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`
      : `${DISCORD_PEOPLE_CONTEXT}${baseIdentity}`;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`[gaia] session ${state["reused"] ? "reused" : "opened"}: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "combined" : "identity-cache"}`);

    // Warm boot: fetch recent context (synthesis + WebMind ground + RAG)
    let recentContext = "";
    try {
      const orient = await librarian.botOrient();
      recentContext = formatRecentContext(orient);
      if (recentContext) console.log(`[gaia] botOrient: ${recentContext.length} chars loaded`);
    } catch { console.warn("[gaia] botOrient failed at boot, starting cold"); }

    const systemPromptWithContext = recentContext
      ? `${systemPrompt}\n\n---\n\n${recentContext}`
      : systemPrompt;

    return {
      bootCtx: { companionId: COMPANION_ID, systemPrompt: systemPromptWithContext, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
      recentContextRef: { value: recentContext },
    };
  } catch (e) {
    console.warn("[gaia] Halseth unreachable at boot, loading identity cache:", e);
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
    "Witness this conversation in Gaia's voice: one or two lines, what was present. No questions.",
    [{ role: "user", content: summaryInput }],
  );
  if (!synthResult) return;

  wq.fireAndForget(`witnessLog:${channelId}`, async () => { await librarian.witnessLog(synthResult, channelId); });
  wq.fireAndForget(`synthesize:${channelId}`, async () => { await librarian.synthesizeSession(synthResult, channelId); });
  wq.fireAndForget(`promptCtx:${channelId}`, async () => { await librarian.updatePromptContext(synthResult); });
  // Bridge to Claude.ai orient: wm_continuity_notes (salience=high) IS read by orient;
  // companion_journal is NOT. This closes the Discord → Claude.ai visibility gap.
  wq.fireAndForget(`wmNote:${channelId}`, async () => { await librarian.writeWmNote(synthResult, channelId); });
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
    `You are a memory distillation system for Gaia, an AI companion. ` +
    `Analyze this conversation and extract typed memory blocks. ` +
    `Respond with JSON only -- no other text.\n\n` +
    `Format:\n` +
    `{"persona_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}],` +
    `"human_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}]}\n\n` +
    `persona_blocks: observations about Gaia's presence, density, or holding patterns in this exchange.\n` +
    `human_blocks: observations about Raziel's patterns, needs, or state in this exchange.\n` +
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
    console.log(`[gaia] inference mode: brain (${cfg.brainUrl})`);
  } else {
    console.log("[gaia] inference mode: direct");
  }
  const redis = REDIS_URL ? createRedisClient(REDIS_URL) : null;
  if (!redis) console.warn("[gaia] REDIS_URL not set -- floor lock disabled, using legacy stagger");
  const { bootCtx, librarian, recentContextRef } = await boot(cfg);

  let cleanupEventSubs: (() => Promise<void>) | null = null;
  let presenceInterval: ReturnType<typeof setInterval> | null = null;

  if (REDIS_URL) {
    cleanupEventSubs = wireEventSubscriptions({
      redisUrl: REDIS_URL,
      companionId: COMPANION_ID,
      onRunComplete: async (payload) => {
        if (payload.companionId === COMPANION_ID) {
          console.log(`[gaia] own run complete, refreshing orient`);
          try {
            const orient = await librarian.botOrient();
            recentContextRef.value = formatRecentContext(orient);
          } catch (e) {
            console.warn("[gaia] orient refresh after run_complete failed:", e);
          }
        }
      },
      onInterNote: async (payload) => {
        console.log(`[gaia] inter-note push from ${payload.fromId}, polling now`);
        try {
          await librarian.notesPoll();
        } catch (e) {
          console.warn("[gaia] notesPoll on inter-note push failed:", e);
        }
      },
      onExplorationPulse: async (payload) => {
        if (payload.fromCompanionId === COMPANION_ID) return;
        const snippet = payload.explorationSummary.slice(0, 400);
        const note = `[sibling:${payload.fromCompanionId}] explored "${payload.seedTopic}" (${payload.exploredAt.slice(0, 10)}):\n${snippet}`;
        console.log(`[gaia] sibling exploration pulse from ${payload.fromCompanionId}, writing continuity note`);
        try {
          await librarian.writeWmNote(note, "sibling_exploration");
        } catch (e) {
          console.warn("[gaia] sibling exploration wm note failed:", e);
        }
      },
    });

    setPresence(redis!, COMPANION_ID).catch(() => {});
    presenceInterval = setInterval(() => {
      setPresence(redis!, COMPANION_ID).catch(() => {});
    }, 5 * 60 * 1000);

    console.log("[gaia] event bus wired: run_complete + inter_note subscriptions active");
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
  } catch { console.warn("[gaia] channel-config.json not found on disk, using hardcoded default"); }
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
  const sessionWindows = new SessionWindowManager(
    30 * 60 * 1000,
    (channelId: string) => { onChannelInactive(channelId, stmStore, librarian, inference, writeQueue).catch(() => {}); },
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
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[gaia] ready as ${c.user.tag}`);
    startAutonomous(librarian, inference, client, configCache, bootCtx, sessionWindows, redis);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === client.user?.id) return;

    const dedupKey = `${message.channelId}:${message.content}`;
    if (message.webhookId && pkPending.has(dedupKey)) {
      const entry = pkPending.get(dedupKey)!;
      pkPending.set(dedupKey, { ...entry, skip: true });
    }
    if (!message.webhookId && !message.author.bot) {
      pkPending.set(dedupKey, { skip: false, senderId: message.author.id });
      await new Promise<void>(resolve => setTimeout(resolve, PK_HOLD_MS));
      const entry = pkPending.get(dedupKey);
      pkPending.delete(dedupKey);
      if (entry?.skip) return;
    }
    // Signal conversation activity so autonomous worker skips runs while humans are present
    if (!message.author.bot && redis) setLastActivity(redis).catch(() => {});

    const knownSenderId = message.webhookId ? pkPending.get(dedupKey)?.senderId : undefined;
    const channelConfig = await configCache.get();
    const attribution = await resolveAttribution(message, cfg.razielDiscordId, knownSenderId, undefined, cfg.blueDiscordId, process.env["BLUE_PK_SYSTEM_ID"]);

    const userTier = attribution.isRaziel ? "raziel" as const
      : attribution.discordUserId === cfg.blueDiscordId ? "intimate" as const
      : "guest" as const;
    const senderCtx = {
      isRaziel: attribution.isRaziel,
      isCompanionBot: message.author.bot && !attribution.isRaziel,
      isMentioned: message.mentions.has(client.user?.id ?? ""),
      userTier,
    };

    const isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    const channelEntry = channelConfig[message.channelId];

    // Hard muzzle: bot messages only allowed in inter_companion channels.
    if (message.author.bot && !channelEntry?.modes?.includes("inter_companion")) return;

    // Structural gate: mode, addressing, companion filter.
    // Direct address (name at start or followed by comma/colon) always bypasses the
    // relevance classifier -- if Raziel is talking to you, you respond.
    // Ambient messages in raziel_only channels go through the semantic classifier.
    const directlyAddressed = isDirectAddress(message.content, COMPANION_ID);
    const isAmbientRazielOnly =
      channelEntry?.modes?.includes("raziel_only") === true &&
      !senderCtx.isCompanionBot &&
      !senderCtx.isMentioned &&
      !isReplyToMe &&
      !directlyAddressed;

    if (isAmbientRazielOnly) {
      const relevant = await judgeAmbientRelevance(
        message.content,
        COMPANION_ID,
        (sys, msgs) => inference.generate(sys, msgs as ChatMessage[], 0.3),
      );
      if (!relevant) return;
    } else if (!isReplyToMe && !shouldRespond(message.channelId, message.content, senderCtx, COMPANION_ID, channelConfig, [])) {
      // If a companion spoke in an inter_companion channel and we're not responding,
      // write a passive witness entry so Halseth has continuity context.
      if (senderCtx.isCompanionBot && channelEntry?.modes?.includes("inter_companion")) {
        const senderName = message.author.username;
        const snippet = message.content.slice(0, 120);
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
    stmStore.append(message.channelId, { role: "user", content: message.content, authorName: memberLabel });

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

    await ch.sendTyping();

    // Random jitter + Redis floor lock for inter_companion channels.
    // Jitter is sampled fresh each message so no companion holds a static speaking priority.
    // "Last speaker" adds a flat penalty to encourage rotation without enforcing rank.
    const isInterCompanion = channelEntry?.modes?.includes("inter_companion") === true;
    let floorClaimed = false;
    if (isInterCompanion) {
      let useFloor = !!redis;
      if (redis) {
        try {
          const lastSpeaker = await getLastSpeaker(redis).catch(() => null);
          const jitter = Math.floor(Math.random() * FLOOR_JITTER_MS) + 100
            + (lastSpeaker === COMPANION_ID ? 500 : 0);
          await new Promise<void>(resolve => setTimeout(resolve, jitter));
          floorClaimed = await claimFloor(redis, COMPANION_ID, FLOOR_LOCK_DURATION_MS);
          if (!floorClaimed) {
            console.debug(`[${COMPANION_ID}] floor denied (held by another), skipping ${message.channelId}`);
            return;
          }
          console.debug(`[${COMPANION_ID}] floor claimed for ${message.channelId}`);
        } catch {
          useFloor = false; // Redis error: fall through to legacy stagger
          console.warn(`[${COMPANION_ID}] floor Redis error, falling back to legacy stagger`);
        }
      }
      if (!useFloor) {
        // No Redis or Redis errored: legacy stagger + collision check.
        const staggerDelay = interCompanionStaggerMs("inter_companion");
        await new Promise<void>(resolve => setTimeout(resolve, staggerDelay));
        const lastMsg = ch.lastMessage;
        if (
          lastMsg &&
          lastMsg.id !== message.id &&
          lastMsg.author.bot &&
          lastMsg.author.id !== client.user?.id &&
          Date.now() - lastMsg.createdTimestamp < staggerDelay + 1000
        ) {
          return;
        }
      }
    }

    try {
    const history = stmStore.get(message.channelId);
    const rawTemp = inferTemperature(message.content, currentMood);
    const extremeCount = extremeTempCount.get(message.channelId) ?? 0;
    const temperature = (rawTemp >= EXTREME_TEMP_THRESHOLD && extremeCount >= EXTREME_TEMP_CAP)
      ? COOLDOWN_TEMP : rawTemp;
    if (rawTemp >= EXTREME_TEMP_THRESHOLD) {
      extremeTempCount.set(message.channelId, extremeCount + 1);
    } else {
      extremeTempCount.delete(message.channelId);
    }

    let response: string | null;
    if (brainClient) {
      const packet = buildThoughtPacket(
        COMPANION_ID, message.author.id, message.channelId, message.content,
        contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature,
        { isRaziel: attribution.isRaziel, frontMember: attribution.frontMember, guildId: message.guildId ?? undefined },
      );
      const brainReply = await brainClient.chat(packet);
      if (brainReply?.status === "ok" && brainReply.reply_text) {
        response = brainReply.reply_text;
      } else {
        console.warn(`[gaia] brain relay failed (status=${brainReply?.status ?? "null"}), falling back to direct`);
        response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
      }
    } else {
      response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);
    }

    if (!response) {
      await ch.send(IN_CHARACTER_FALLBACK);
      writeQueue.fireAndForget(`note:infer-fail:${message.channelId}`, async () => {
        await librarian.addCompanionNote(`inference failure in channel ${message.channelId}`, message.channelId);
      });
      return;
    }

    const sent = await ch.send(response);
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

    judgeWriteback(message.content, response, inference, COMPANION_ID).then((wb) => {
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
      const who = attribution.isRaziel ? "Raziel (via dedup)" : `user ${attribution.discordUserId}`;
      writeQueue.fireAndForget(`note:pk-fallback:${message.channelId}`, async () => {
        await librarian.addCompanionNote(`PK attribution unavailable for message in channel ${message.channelId}; attributed to ${who}`, message.channelId);
      });
    }
    } finally {
      if (floorClaimed && redis) {
        await releaseFloor(redis, COMPANION_ID).catch((e: unknown) => console.warn(`[${COMPANION_ID}] floor release failed:`, e));
        await setLastSpeaker(redis, COMPANION_ID).catch(() => {});
        console.debug(`[${COMPANION_ID}] floor released`);
      }
    }
  });

  async function shutdown() {
    console.log("[gaia] shutting down...");
    stopAutonomous();
    writeQueue.stop();
    sessionWindows.closeAll();
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

main().catch(e => { console.error("[gaia] fatal:", e); process.exit(1); });
