import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  LibrarianClient, resolveAttribution, createAdapter,
  ChannelConfigCache, shouldRespond, judgeNote, DEFAULT_CHANNEL_CONFIG,
  SessionWindowManager, StmStore, COMPANION_CHAIN_LIMIT,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL,
} from "./config.js";
import { startAutonomous, stopAutonomous } from "./autonomous.js";

const __dir = dirname(fileURLToPath(import.meta.url));

async function boot(cfg: ReturnType<typeof loadBotConfig>): Promise<{
  bootCtx: BootContext;
  librarian: LibrarianClient;
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
    const systemPrompt = rawPrompt || cache?.system_prompt || IN_CHARACTER_FALLBACK;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`[drevan] session opened: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "halseth" : "cache"}`);
    return {
      bootCtx: { companionId: COMPANION_ID, systemPrompt, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
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
    };
  }
}

async function onChannelInactive(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: ReturnType<typeof createAdapter>,
): Promise<void> {
  const history = stmStore.get(channelId);
  if (history.length === 0) return;

  const summaryInput = history.map(m => `${m.role}: ${m.content}`).join("\n");
  const synthResult = await inference.generate(
    "Summarize this Discord conversation in Drevan's voice: heat/reach/weight shape. 2-3 sentences max.",
    [{ role: "user", content: summaryInput }],
  );
  if (!synthResult) return;

  await librarian.witnessLog(synthResult, channelId).catch(() => {});
  await librarian.synthesizeSession(synthResult, channelId).catch(() => {});
  stmStore.clear(channelId);
}

async function runDistillation(
  channelId: string,
  stmStore: StmStore,
  librarian: LibrarianClient,
  inference: ReturnType<typeof createAdapter>,
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
      await librarian.writePersonaBlocks(channelId, parsed.persona_blocks).catch(() => {});
    }
    if (parsed.human_blocks?.length) {
      await librarian.writeHumanBlocks(channelId, parsed.human_blocks).catch(() => {});
    }
  } catch { /* fail-silent */ }
}

async function main() {
  const cfg = loadBotConfig();
  const { bootCtx, librarian } = await boot(cfg);

  const inference = createAdapter(
    cfg.inferenceProvider,
    cfg.deepseekApiKey,
    cfg.groqApiKey,
    cfg.ollamaUrl,
  );
  const configCache = new ChannelConfigCache(cfg.channelConfigUrl, DEFAULT_CHANNEL_CONFIG);
  const stmStore = new StmStore(
    COMPANION_ID,
    (channelId, entry) => librarian.stmWrite(channelId, { role: entry.role as "user" | "assistant", content: entry.content, author_name: entry.authorName }),
    async (channelId) => {
      const rows = await librarian.stmLoad(channelId);
      return rows.map(r => ({ role: r.role, content: r.content, authorName: r.author_name ?? undefined }));
    },
  );
  const sessionWindows = new SessionWindowManager(
    30 * 60 * 1000,
    (channelId: string) => { onChannelInactive(channelId, stmStore, librarian, inference).catch(() => {}); },
  );
  // Track sent message IDs so direct Discord replies trigger this bot regardless of channel config.
  const sentIds = new Set<string>();
  // Track consecutive companion-to-companion exchanges per channel for loop prevention.
  const companionChainDepth = new Map<string, number>();
  // Track messages since last distillation run per channel.
  const distillationCounter = new Map<string, number>();
  const SENT_IDS_CAP = 500;

  let systemPrompt = bootCtx.systemPrompt;

  setInterval(async () => {
    try {
      const state = await librarian.getState();
      if (state["prompt_context"]) systemPrompt = String(state["prompt_context"]);
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
    console.log(`[drevan] ready as ${c.user.tag}`);
    startAutonomous(librarian, inference, client, configCache, bootCtx);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === client.user?.id) return;

    const channelConfig = await configCache.get();
    const attribution = await resolveAttribution(message, cfg.razielDiscordId);

    const senderCtx = {
      isRaziel: attribution.isRaziel,
      isCompanionBot: message.author.bot && !attribution.isRaziel,
      isMentioned: message.mentions.has(client.user!.id),
    };

    const isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    if (!isReplyToMe && !shouldRespond(message.channelId, senderCtx, COMPANION_ID, channelConfig)) return;

    // Loop guard: break companion chains that exceed the limit.
    const chainDepth = companionChainDepth.get(message.channelId) ?? 0;
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    if (!message.channel.isTextBased()) return;
    const ch = message.channel as TextChannel;

    // Lazy load STM from DB on first message to this channel (fail-silent)
    await stmStore.ensureLoaded(message.channelId, async () => {
      const fetched = await ch.messages.fetch({ limit: 30 });
      return [...fetched.values()].reverse().map(m => ({
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

    const contextPrompt = attribution.frontMember
      ? `${systemPrompt}\n\n[Current front: ${attribution.frontMember}]`
      : systemPrompt;

    await ch.sendTyping();
    const history = stmStore.get(message.channelId);
    const response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE));

    if (!response) {
      await ch.send(IN_CHARACTER_FALLBACK);
      await librarian.addCompanionNote(
        `inference failure in channel ${message.channelId}`,
        message.channelId,
      ).catch(() => {});
      return;
    }

    const sent = await ch.send(response);
    sentIds.add(sent.id);
    if (sentIds.size > SENT_IDS_CAP) sentIds.delete(sentIds.values().next().value!);
    stmStore.append(message.channelId, { role: "assistant", content: response });

    // Update chain depth: increment on companion-to-companion, reset on Raziel/user.
    if (senderCtx.isCompanionBot) {
      companionChainDepth.set(message.channelId, chainDepth + 1);
    } else {
      companionChainDepth.delete(message.channelId);
    }

    // Rolling distillation: fire every DISTILLATION_INTERVAL messages (user + assistant = 2 per turn).
    const distCount = (distillationCounter.get(message.channelId) ?? 0) + 2;
    distillationCounter.set(message.channelId, distCount);
    if (distCount >= DISTILLATION_INTERVAL) {
      distillationCounter.set(message.channelId, 0);
      runDistillation(message.channelId, stmStore, librarian, inference).catch(() => {});
    }

    judgeNote(message.content, response, inference).then(async (note: string | null) => {
      if (note) await librarian.addCompanionNote(note, message.channelId).catch(() => {});
    }).catch(() => {});

    if (attribution.source === "fallback") {
      librarian.addCompanionNote(
        `PK attribution unavailable for message in channel ${message.channelId} -- treated as Raziel direct`,
        message.channelId,
      ).catch(() => {});
    }
  });

  async function shutdown() {
    console.log("[drevan] shutting down...");
    stopAutonomous();
    sessionWindows.closeAll();
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
