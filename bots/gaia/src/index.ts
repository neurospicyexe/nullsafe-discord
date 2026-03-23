import { Client, GatewayIntentBits, Events, Message, TextChannel } from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  LibrarianClient, resolveAttribution, createAdapter,
  ChannelConfigCache, shouldRespond, judgeNote,
  SessionWindowManager,
  type ChatMessage, type BootContext,
} from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS,
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

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const systemPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "");
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`[gaia] session opened: ${sessionId}, front: ${frontState}`);
    return {
      bootCtx: { companionId: COMPANION_ID, systemPrompt, sessionId, frontState, fromCache: false },
      librarian,
    };
  } catch (e) {
    console.warn("[gaia] Halseth unreachable at boot, loading identity cache:", e);
    const cache = JSON.parse(readFileSync(join(__dir, "../identity-cache.json"), "utf8")) as { system_prompt: string };
    return {
      bootCtx: {
        companionId: COMPANION_ID,
        systemPrompt: cache.system_prompt,
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
  channelHistory: Map<string, ChatMessage[]>,
  librarian: LibrarianClient,
  inference: ReturnType<typeof createAdapter>,
): Promise<void> {
  const history = channelHistory.get(channelId);
  if (!history || history.length === 0) return;

  const summaryInput = history.map(m => `${m.role}: ${m.content}`).join("\n");
  const synthResult = await inference.generate(
    "Witness this conversation in Gaia's voice: one or two lines, what was present. No questions.",
    [{ role: "user", content: summaryInput }],
  );
  if (!synthResult) return;

  await librarian.witnessLog(synthResult, channelId).catch(() => {});
  await librarian.synthesizeSession(synthResult, channelId).catch(() => {});
  channelHistory.delete(channelId);
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
  const configCache = new ChannelConfigCache(cfg.channelConfigUrl);
  const channelHistory = new Map<string, ChatMessage[]>();
  const sessionWindows = new SessionWindowManager(
    30 * 60 * 1000,
    (channelId: string) => { onChannelInactive(channelId, channelHistory, librarian, inference).catch(() => {}); },
  );

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
    console.log(`[gaia] ready as ${c.user.tag}`);
    startAutonomous(librarian, inference, client, configCache, channelHistory, bootCtx);
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

    if (!shouldRespond(message.channelId, senderCtx, COMPANION_ID, channelConfig)) return;

    const history = channelHistory.get(message.channelId) ?? [];
    const memberLabel = attribution.frontMember
      ? `${attribution.frontMember} (via PK)`
      : message.author.username;
    history.push({ role: "user", content: message.content, authorName: memberLabel });
    if (history.length > CONTEXT_WINDOW_SIZE) history.shift();
    channelHistory.set(message.channelId, history);

    sessionWindows.touch(message.channelId);

    const contextPrompt = attribution.frontMember
      ? `${systemPrompt}\n\n[Current front: ${attribution.frontMember}]`
      : systemPrompt;

    if (!message.channel.isTextBased()) return;
    const ch = message.channel as TextChannel;

    await ch.sendTyping();
    const response = await inference.generate(contextPrompt, history.slice(-CONTEXT_WINDOW_SIZE));

    if (!response) {
      await ch.send(IN_CHARACTER_FALLBACK);
      await librarian.addCompanionNote(
        `inference failure in channel ${message.channelId}`,
        message.channelId,
      ).catch(() => {});
      return;
    }

    await ch.send(response);
    history.push({ role: "assistant", content: response });
    channelHistory.set(message.channelId, history);

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
    console.log("[gaia] shutting down...");
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

main().catch(e => { console.error("[gaia] fatal:", e); process.exit(1); });
