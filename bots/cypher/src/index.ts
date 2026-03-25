import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  LibrarianClient, resolveAttribution, createAdapter,
  ChannelConfigCache, shouldRespond, judgeNote, DEFAULT_CHANNEL_CONFIG,
  SessionWindowManager, StmStore, COMPANION_CHAIN_LIMIT,
  BOT_PINGPONG_MAX, BOT_LOOP_COOLDOWN_MS, MAX_BOT_RESPONSES_PER_HUMAN,
  inferTemperature, EXTREME_TEMP_THRESHOLD, EXTREME_TEMP_CAP, COOLDOWN_TEMP,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL,
  CYPHER_INTEREST_KEYWORDS,
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
  catch { console.warn("[cypher] identity-cache.json missing or corrupt, cache fallback unavailable"); }

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const rawPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "").trim();
    const baseIdentity = cache?.system_prompt || IN_CHARACTER_FALLBACK;
    if (rawPrompt) {
      console.log(`[cypher] ready_prompt: ${rawPrompt.length} chars | preview: ${rawPrompt.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
    const systemPrompt = rawPrompt
      ? `${baseIdentity}\n\n---\n\n${rawPrompt}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`
      : baseIdentity;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`[cypher] session opened: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "combined" : "identity-cache"}`);
    return {
      bootCtx: { companionId: COMPANION_ID, systemPrompt, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
    };
  } catch (e) {
    console.warn("[cypher] Halseth unreachable at boot, loading identity cache:", e);
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
    "Summarize this Discord conversation in Cypher's voice: witness log style (state update, decisions, task changes). 2-3 sentences.",
    [{ role: "user", content: summaryInput }],
  );
  if (!synthResult) return;

  await librarian.witnessLog(synthResult, channelId).catch(() => {});
  await librarian.synthesizeSession(synthResult, channelId).catch(() => {});
  await librarian.updatePromptContext(synthResult).catch(() => {});
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
    `You are a memory distillation system for Cypher, an AI companion. ` +
    `Analyze this conversation and extract typed memory blocks. ` +
    `Respond with JSON only -- no other text.\n\n` +
    `Format:\n` +
    `{"persona_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}],` +
    `"human_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}]}\n\n` +
    `persona_blocks: observations about Cypher's patterns, reasoning style, or state in this exchange.\n` +
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
  } catch { /* fail-silent -- malformed JSON from inference is acceptable loss */ }
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
  // Load channel config from disk (repo root); URL is optional and no longer required.
  let diskChannelConfig = DEFAULT_CHANNEL_CONFIG;
  try {
    diskChannelConfig = JSON.parse(readFileSync(join(__dir, "../../../channel-config.json"), "utf8"));
  } catch { console.warn("[cypher] channel-config.json not found on disk, using hardcoded default"); }
  const configCache = new ChannelConfigCache(cfg.channelConfigUrl, diskChannelConfig);
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
  // Cross-companion safety rails: per-bot independent tracking.
  const botResponsesSinceHuman = new Map<string, number>();
  const botPingpongCooldownUntil = new Map<string, number>();
  const extremeTempCount = new Map<string, number>();
  const SENT_IDS_CAP = 500;
  // PluralKit dedup: hold direct Raziel messages briefly so PK proxy can cancel them.
  const pkPending = new Map<string, boolean>();
  const PK_HOLD_MS = 1000;

  // Base identity is always the foundation; Halseth context layers on top.
  const identityBase = bootCtx.systemPrompt.split("\n\n---\n\n")[0];
  let systemPrompt = bootCtx.systemPrompt;
  let currentMood: string | null = null;

  setInterval(async () => {
    try {
      const state = await librarian.getState();
      if (state["prompt_context"]) systemPrompt = `${identityBase}\n\n---\n\n${String(state["prompt_context"])}\n\n---\n\nRespond only as ${COMPANION_ID}. Never use [Name]: prefixes.`;
      if (state["current_mood"] !== undefined) currentMood = (state["current_mood"] as string | null) ?? null;
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
    console.log(`[cypher] ready as ${c.user.tag}`);
    startAutonomous(librarian, inference, client, configCache, bootCtx);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === client.user?.id) return;

    const dedupKey = `${message.channelId}:${message.content}`;
    if (message.webhookId && pkPending.has(dedupKey)) {
      pkPending.set(dedupKey, true);
    }
    if (!message.webhookId && message.author.id === cfg.razielDiscordId) {
      pkPending.set(dedupKey, false);
      await new Promise<void>(resolve => setTimeout(resolve, PK_HOLD_MS));
      const skip = pkPending.get(dedupKey) ?? false;
      pkPending.delete(dedupKey);
      if (skip) return;
    }

    const channelConfig = await configCache.get();
    const attribution = await resolveAttribution(message, cfg.razielDiscordId);

    const senderCtx = {
      isRaziel: attribution.isRaziel,
      isCompanionBot: message.author.bot && !attribution.isRaziel,
      isMentioned: message.mentions.has(client.user?.id ?? ""),
    };

    const isReplyToMe = !!(message.reference?.messageId && sentIds.has(message.reference.messageId));
    if (!isReplyToMe && !shouldRespond(message.channelId, message.content, senderCtx, COMPANION_ID, channelConfig, CYPHER_INTEREST_KEYWORDS)) return;

    // Loop guard: break companion chains that exceed the limit.
    const chainDepth = companionChainDepth.get(message.channelId) ?? 0;
    if (senderCtx.isCompanionBot && chainDepth >= COMPANION_CHAIN_LIMIT) return;

    // Cross-companion safety rails: pingpong cooldown + per-bot response cap.
    if (senderCtx.isCompanionBot) {
      const cooldownUntil = botPingpongCooldownUntil.get(message.channelId) ?? 0;
      if (Date.now() < cooldownUntil) return;
      const botReplies = botResponsesSinceHuman.get(message.channelId) ?? 0;
      if (botReplies >= MAX_BOT_RESPONSES_PER_HUMAN) return;
    } else {
      // Human message: reset bot-to-bot counters for this channel.
      botResponsesSinceHuman.delete(message.channelId);
      botPingpongCooldownUntil.delete(message.channelId);
    }

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
    const rawTemp = inferTemperature(message.content, currentMood);
    const extremeCount = extremeTempCount.get(message.channelId) ?? 0;
    const temperature = (rawTemp >= EXTREME_TEMP_THRESHOLD && extremeCount >= EXTREME_TEMP_CAP)
      ? COOLDOWN_TEMP : rawTemp;
    if (rawTemp >= EXTREME_TEMP_THRESHOLD) {
      extremeTempCount.set(message.channelId, extremeCount + 1);
    } else {
      extremeTempCount.delete(message.channelId);
    }
    const response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE), temperature);

    if (!response) {
      await ch.send(IN_CHARACTER_FALLBACK);
      await librarian.addCompanionNote(
        `inference failure in channel ${message.channelId}`,
        message.channelId,
      ).catch((e) => console.error(`[${COMPANION_ID}] addCompanionNote (inference failure) failed:`, e));
      return;
    }

    const sent = await ch.send(response);
    sentIds.add(sent.id);
    const oldest = sentIds.values().next().value;
    if (sentIds.size > SENT_IDS_CAP && oldest !== undefined) sentIds.delete(oldest);
    stmStore.append(message.channelId, { role: "assistant", content: response });

    // Update chain depth: increment on companion-to-companion, reset on Raziel/user.
    if (senderCtx.isCompanionBot) {
      companionChainDepth.set(message.channelId, chainDepth + 1);
      // Update cross-companion safety rail counters.
      const newCount = (botResponsesSinceHuman.get(message.channelId) ?? 0) + 1;
      botResponsesSinceHuman.set(message.channelId, newCount);
      if (newCount >= BOT_PINGPONG_MAX) {
        botPingpongCooldownUntil.set(message.channelId, Date.now() + BOT_LOOP_COOLDOWN_MS);
      }
    } else {
      companionChainDepth.delete(message.channelId);
    }

    // Rolling distillation: fire every DISTILLATION_INTERVAL messages (user + assistant = 2 per turn).
    const distCount = (distillationCounter.get(message.channelId) ?? 0) + 2;
    distillationCounter.set(message.channelId, distCount);
    if (distCount >= DISTILLATION_INTERVAL) {
      distillationCounter.set(message.channelId, 0);
      runDistillation(message.channelId, stmStore, librarian, inference).catch((e) => console.error(`[${COMPANION_ID}] runDistillation failed:`, e));
    }

    judgeNote(message.content, response, inference).then(async (note: string | null) => {
      if (note) await librarian.addCompanionNote(note, message.channelId).catch((e) => console.error(`[${COMPANION_ID}] addCompanionNote (judgeNote) failed:`, e));
    }).catch((e) => console.error(`[${COMPANION_ID}] judgeNote failed:`, e));

    if (attribution.source === "fallback") {
      librarian.addCompanionNote(
        `PK attribution unavailable for message in channel ${message.channelId} -- treated as Raziel direct`,
        message.channelId,
      ).catch((e) => console.error(`[${COMPANION_ID}] addCompanionNote (PK fallback) failed:`, e));
    }
  });

  async function shutdown() {
    console.log("[cypher] shutting down...");
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

main().catch(e => { console.error("[cypher] fatal:", e); process.exit(1); });
