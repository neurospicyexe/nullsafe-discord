// Shared bot-core plumbing for the companion bots (cypher/drevan/gaia).
//
// Each bot previously carried a byte-identical `boot()` (≈59 lines) that opened a Halseth
// session, assembled the system prompt, warm-loaded recent context, and fell back to the
// cached identity when Halseth was unreachable. The only per-bot variation was the log tag
// and the prefix const. This module owns that plumbing; identity stays per-bot (prefix,
// identity-cache contents, fallback string are passed IN).
//
// runBot() owns the full main() body: infrastructure setup, voice wiring, event handlers,
// shutdown. Per-bot differences are passed in via RunBotConfig (companionLabel, discordPrefix,
// audit config, autonomous hooks). identity-cache.json and channel-config.json reads stay
// bot-side via botDir — those paths resolve against the bot's own module location.

import { LibrarianClient, formatRecentContext } from "./librarian.js";
import { setArmedTriggers } from "./triggers.js";
import { loadSharedContext } from "./shared-context.js";
import { composePrompt, deriveIdentityBase } from "./prompt-assembly.js";
import { scheduleDayDistillation } from "./day-distillation.js";
import { createAdapter, type InferenceAdapter, type AdapterKeys, type AdapterUrls } from "./inference.js";
import { ALL_MODELS, type InferenceProvider, type ModelEntry } from "./models.js";
import { readHermesModelKeys, selectableModels, diagnoseHermesMap, DEFAULT_HERMES_MODEL_MAP_PATH } from "./hermes-model-map.js";
import type { BotConfig, BootContext, CompanionId } from "./types.js";
import { readFileSync } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { Client, GatewayIntentBits, Events, type Message, type VoiceBasedChannel } from "discord.js";
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  VoiceConnectionStatus, EndBehaviorType,
  type VoiceConnection, type AudioPlayer,
} from "@discordjs/voice";
import * as prism from "prism-media";
import type { Redis } from "ioredis";
import { PkDedup, pkIngestAtEvent } from "./pluralkit.js";
import { PkRoster, pkSystemsFromEnv } from "./pk-roster.js";
import { ChannelConfigCache, DEFAULT_CHANNEL_CONFIG } from "./channel-config.js";
import { SessionWindowManager } from "./session-window.js";
import { StmStore } from "./stm.js";
import { WriteQueue } from "./write-queue.js";
import { createRedisClient } from "./floor.js";
import { wireEventSubscriptions, setPresence } from "./events.js";
import { handleMessage } from "./bot-message-handler.js";
import { ChannelInbox } from "./channel-inbox.js";
import { distillSessionOnInactive } from "./distillation.js";
import { VoiceClient, markVoiceUsed } from "./voice.js";
import { buildCompanionCommands, registerGuildCommands, installSlashCommandHandler } from "./slash-commands.js";

export interface BootSessionOptions {
  companionId: CompanionId;
  /** Halseth base URL (from loadBotConfig). */
  halsethUrl: string;
  /** Halseth auth secret (from loadBotConfig). */
  halsethSecret: string;
  /** Per-bot Discord system-prompt prefix (lane rules). */
  prefix: string;
  /** In-character fallback used when neither Halseth nor the identity cache yields a prompt. */
  fallbackPrompt: string;
  /**
   * Parsed `identity-cache.json` (or null if missing/corrupt). Read bot-side because the cache
   * path resolves against the bot's own module location.
   */
  identityCache: { system_prompt: string } | null;
  /** Injectable LibrarianClient (tests). Defaults to a freshly constructed client. */
  librarian?: LibrarianClient;
}

export interface BootSessionResult {
  bootCtx: BootContext;
  librarian: LibrarianClient;
  /** Mutable ref so the event-subscription orient refresh can update recent context in place. */
  recentContextRef: { value: string };
}

/**
 * Open a Halseth work session, assemble the system prompt, warm-load recent context, and
 * return the boot context. Falls back to the cached identity if Halseth is unreachable.
 *
 * Behavior is byte-identical to the per-bot `boot()` it replaces; only the log tag is
 * parameterized off `companionId` (which is already lowercase, e.g. `[cypher]`).
 */
export async function bootSession(opts: BootSessionOptions): Promise<BootSessionResult> {
  const { companionId, halsethUrl, halsethSecret, prefix, fallbackPrompt, identityCache } = opts;
  const tag = `[${companionId}]`;
  const cache = identityCache;

  const librarian =
    opts.librarian ?? new LibrarianClient({ url: halsethUrl, secret: halsethSecret, companionId });

  try {
    const state = await librarian.sessionOpen("work");
    const sessionId = String(state["session_id"] ?? "unknown");
    const rawPrompt = String(state["prompt_context"] ?? state["ready_prompt"] ?? "").trim();
    const baseIdentity = cache?.system_prompt || fallbackPrompt;
    if (rawPrompt) {
      console.log(`${tag} ready_prompt: ${rawPrompt.length} chars | preview: ${rawPrompt.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
    const sharedCtx = loadSharedContext();
    const sharedBlock = sharedCtx ? `${sharedCtx}\n\n---\n\n` : "";
    const identityCore = `${prefix}${sharedBlock}${baseIdentity}`;
    const frontState = String(state["front_state"] ?? "unknown");
    console.log(`${tag} session ${state["reused"] ? "reused" : "opened"}: ${sessionId}, front: ${frontState}, prompt_source: ${rawPrompt ? "combined" : "identity-cache"}`);

    // Warm boot: fetch recent context (synthesis + WebMind ground + RAG)
    let recentContext = "";
    try {
      const orient = await librarian.botOrient();
      recentContext = formatRecentContext(orient);
      setArmedTriggers(companionId, orient?.armed_triggers ?? []);
      if (recentContext) console.log(`${tag} botOrient: ${recentContext.length} chars loaded`);
    } catch { console.warn(`${tag} botOrient failed at boot, starting cold`); }

    const systemPromptWithContext = composePrompt({ identityCore, promptContext: rawPrompt, companionId, recentContext });

    return {
      bootCtx: { companionId, systemPrompt: systemPromptWithContext, sessionId, frontState, fromCache: !rawPrompt },
      librarian,
      recentContextRef: { value: recentContext },
    };
  } catch (e) {
    console.warn(`${tag} Halseth unreachable at boot, loading identity cache:`, e);
    return {
      bootCtx: {
        companionId,
        systemPrompt: cache?.system_prompt ?? fallbackPrompt,
        sessionId: "cached",
        frontState: "unknown",
        fromCache: true,
      },
      librarian,
      recentContextRef: { value: "" },
    };
  }
}

export interface RefreshBotStateOptions {
  companionId: CompanionId;
  librarian: LibrarianClient;
  /** Boot-derived identity base — the foundation composePrompt layers fresh context onto. */
  identityBase: string;
  /** Live BootContext. `systemPrompt` is mutated in place; the message handler reads it. */
  bootCtx: BootContext;
  /** Live refs the message handler also reads. MUST be the same object instances main() holds. */
  recentContextRef: { value: string };
  currentMoodRef: { value: string | null };
  lastSomaRefreshRef: { value: number };
  adapterRef: { current: InferenceAdapter };
  activeModelRef: { key: string | null; label: string };
  /** Keys the live hermes map can apply. Absent/null = full registry (direct/brain, or unreadable
   *  map). Without this the refresh would adopt a stored key the watcher cannot resolve, so the
   *  companion would report running a model it is not running. */
  hermesModelKeys?: Set<string> | null;
  apiKeys: AdapterKeys;
  apiUrls: AdapterUrls;
}

/**
 * Periodic state refresh (was an inline `setInterval` body triplicated across the three bots).
 * Re-pulls Halseth state + orient, recomposes the system prompt, refreshes mood/age, and
 * hot-swaps the inference adapter when the active model changed in Halseth (`cy: model ...`).
 *
 * Mutates the passed-in live refs in place so the message handler sees fresh values without
 * re-wiring. Scheduling stays bot-side (`setInterval(() => refreshBotState(opts), MS)`); this
 * owns only the body. Fully fail-soft: any error keeps the cached values.
 */
export async function refreshBotState(opts: RefreshBotStateOptions): Promise<void> {
  const {
    companionId, librarian, identityBase, bootCtx,
    recentContextRef, currentMoodRef, lastSomaRefreshRef,
    adapterRef, activeModelRef, hermesModelKeys, apiKeys, apiUrls,
  } = opts;
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
    if (orientResult.status === "fulfilled") {
      setArmedTriggers(companionId, orientResult.value?.armed_triggers ?? []);
    }

    bootCtx.systemPrompt = composePrompt({ identityCore: identityBase, promptContext: freshPromptCtx ?? undefined, companionId, recentContext: freshRecentCtx });

    if (stateResult.status === "fulfilled" && stateResult.value["current_mood"] !== undefined) {
      currentMoodRef.value = (stateResult.value["current_mood"] as string | null) ?? null;
      lastSomaRefreshRef.value = Date.now();
    }

    try {
      const savedModel = await librarian.getSetting("active_model");
      // Adopt only what the live runtime can actually apply. A stored key the hermes watcher
      // cannot resolve (set before the guard shipped, edited straight into D1, or orphaned when
      // the map shrank) would otherwise make the companion report a model it is not running --
      // the same divergence, surviving in the one place that decides what it thinks it is.
      const refreshable = selectableModels(hermesModelKeys ?? null);
      if (savedModel && savedModel !== activeModelRef.key && refreshable[savedModel]) {
        const entry = refreshable[savedModel];
        adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls, undefined, companionId);
        activeModelRef.key = savedModel;
        activeModelRef.label = entry.label;
        console.log(`[${companionId}] model refreshed from Halseth: ${savedModel}`);
      } else if (savedModel && savedModel !== activeModelRef.key && ALL_MODELS[savedModel]) {
        console.warn(`[${companionId}] stored active_model '${savedModel}' is a real model the live hermes map cannot apply -- staying on ${activeModelRef.key ?? "the env default"}`);
      }
    } catch { /* keep current model on error */ }
  } catch { /* keep cached */ }
}

// ── pcmToWav ─────────────────────────────────────────────────────────────────
// Pure utility: wraps raw PCM in a WAV header for Mistral STT transcription.
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

// ── runBot interfaces ─────────────────────────────────────────────────────────

/** Per-bot constants and hooks passed to runBot() alongside the env config. */
export interface RunBotConfig {
  /** Caller's __dir (dirname(fileURLToPath(import.meta.url))): resolves identity-cache + channel-config paths. */
  botDir: string;
  /** Display name used in slash commands and log lines ("Cypher" | "Drevan" | "Gaia"). */
  companionLabel: string;
  /** Discord system-prompt prefix (lane rules). Per-bot env var, e.g. DISCORD_COMPANION_PREFIX. */
  discordPrefix: string;
  companionId: CompanionId;
  contextWindowSize: number;
  inCharacterFallback: string;
  somaRefreshIntervalMs: number;
  distillationInterval: number;
  pulseInterval: number;
  blueFraming: string;
  guestFraming: string;
  synthesisPrompt: string;
  sessionExtractPrompt: string;
  distillationPrompt: string;
  modelSwitchTrigger: RegExp;
  modelSwitchSuccess: (label: string) => string;
  modelSwitchListIntro: string;
  listenTrigger: RegExp;
  clubTrigger: RegExp;
  /** Companion tools (0077 take 14): web search + image gen owner commands. */
  searchTrigger?: RegExp;
  imagineTrigger?: RegExp;
  petTrigger?: RegExp;
  councilTrigger?: RegExp;
  impsTrigger?: RegExp;
  hexTrigger?: RegExp;
  /** Command-shaped-but-unparsed catcher; usage reply instead of inference. */
  logTrigger?: RegExp;
  intoTrigger?: RegExp;
  commandGuard?: RegExp;
  redisUrl: string | undefined;
  mistralApiKey: string | undefined;
  voiceId: string;
  mistralTtsModel: string | undefined;
  mistralSttModel: string | undefined;
  autonomous: {
    start: (librarian: LibrarianClient, adapter: InferenceAdapter, client: Client, configCache: ChannelConfigCache, bootCtx: BootContext, sessionWindows: SessionWindowManager, redis: Redis | null, halsethSecret: string, registerSentId?: (id: string) => void) => void;
    stop: () => void;
    resetCycleGuard: () => void;
    pushRazielMessage: (content: string) => void;
  };
  /** Cypher-only audit capability. Omit for Drevan/Gaia. */
  auditConfig?: {
    auditTriggers: string[];
    auditModeInjection: string;
  };
}

/**
 * Full companion bot main loop. Extracted from the triplicated main() across
 * bots/cypher, bots/drevan, bots/gaia. All per-bot variation is parameterized
 * via RunBotConfig; env config (from loadBotConfig()) is the first arg.
 *
 * Each bot's index.ts becomes: imports + constants + runBot(loadBotConfig(), { ... }).
 */
export async function runBot(env: BotConfig, brc: RunBotConfig): Promise<void> {
  const {
    botDir, companionLabel, discordPrefix, companionId, inCharacterFallback,
    somaRefreshIntervalMs, distillationInterval, pulseInterval,
    blueFraming, guestFraming, synthesisPrompt, sessionExtractPrompt, distillationPrompt,
    modelSwitchTrigger, modelSwitchSuccess, modelSwitchListIntro, listenTrigger, clubTrigger, searchTrigger, imagineTrigger, petTrigger, councilTrigger, impsTrigger, hexTrigger, logTrigger, intoTrigger, commandGuard,
    contextWindowSize, redisUrl, mistralApiKey, voiceId, mistralTtsModel, mistralSttModel,
    autonomous, auditConfig,
  } = brc;

  // Dormancy is announced, not implied: "mode: hermes" alone doesn't tell a reader that the whole
  // multi-provider fallback chain is bypassed for this process. Say it.
  //
  // `brain` was a third mode and is gone (2026-07-29) along with BrainClient, the relay branch in
  // the message handler, and the `nullsafe-brain` block in ecosystem.config.js. An INFERENCE_MODE of
  // `brain` now lands here as `direct` rather than dialing a port nothing listens on -- which is the
  // right failure, since /app/nullsafe-discord/.env still carried INFERENCE_MODE=brain and was
  // survivable only because all three per-bot overrides said hermes.
  if (env.inferenceMode === "hermes" && env.hermesUrl) {
    console.log(`[${companionId}] inference mode: hermes (${env.hermesUrl})`);
    console.log(`[${companionId}] DORMANT: provider fallback chain bypassed (forceHermes)`);
  } else {
    console.log(`[${companionId}] inference mode: direct${env.inferenceMode && env.inferenceMode !== "direct" ? ` (INFERENCE_MODE="${env.inferenceMode}" is not a mode this build has; falling back)` : ""}`);
  }

  const redis = redisUrl ? createRedisClient(redisUrl) : null;
  if (!redis) console.warn(`[${companionId}] REDIS_URL not set -- floor lock disabled, using legacy stagger`);

  const voiceClient = mistralApiKey
    ? new VoiceClient({ mistralApiKey, voiceId, ttsModel: mistralTtsModel, sttModel: mistralSttModel })
    : null;
  if (voiceClient) {
    voiceClient.isHealthy().then((healthy) => {
      console.log(`[${companionId}] voice (Mistral): ${healthy ? "ok" : "unavailable"}`);
    });
  } else {
    console.log(`[${companionId}] voice (Mistral): not configured`);
  }

  const guildVoiceConnections = new Map<string, { connection: VoiceConnection; player: AudioPlayer }>();
  const activeVoiceSessions = new Set<string>();

  let identityCache: { system_prompt: string } | null = null;
  try { identityCache = JSON.parse(readFileSync(join(botDir, "../identity-cache.json"), "utf8")); }
  catch { console.warn(`[${companionId}] identity-cache.json missing or corrupt, cache fallback unavailable`); }

  const { bootCtx, librarian, recentContextRef } = await bootSession({
    companionId,
    halsethUrl: env.halsethUrl,
    halsethSecret: env.halsethSecret,
    prefix: discordPrefix,
    fallbackPrompt: inCharacterFallback,
    identityCache,
  });

  let cleanupEventSubs: (() => Promise<void>) | null = null;
  let presenceInterval: ReturnType<typeof setInterval> | null = null;

  if (redisUrl) {
    cleanupEventSubs = wireEventSubscriptions({
      redisUrl,
      companionId,
      onRunComplete: async (payload) => {
        if (payload.companionId === companionId) {
          console.log(`[${companionId}] own run complete, refreshing orient`);
          try {
            const orient = await librarian.botOrient();
            recentContextRef.value = formatRecentContext(orient);
          } catch (e) {
            console.warn(`[${companionId}] orient refresh after run_complete failed:`, e);
          }
        }
      },
      onInterNote: async (payload) => {
        console.log(`[${companionId}] inter-note push from ${payload.fromId}, polling now`);
        try {
          await librarian.notesPoll();
        } catch (e) {
          console.warn(`[${companionId}] notesPoll on inter-note push failed:`, e);
        }
      },
      onExplorationPulse: async (payload) => {
        if (payload.fromCompanionId === companionId) return;
        const snippet = payload.explorationSummary.slice(0, 400);
        const note = `[sibling:${payload.fromCompanionId}] explored "${payload.seedTopic}" (${payload.exploredAt.slice(0, 10)}):\n${snippet}`;
        console.log(`[${companionId}] sibling exploration pulse from ${payload.fromCompanionId}, writing continuity note`);
        try {
          await librarian.writeWmNote(note, "sibling_exploration");
        } catch (e) {
          console.warn(`[${companionId}] sibling exploration wm note failed:`, e);
        }
      },
    });

    setPresence(redis!, companionId).catch(() => {});
    presenceInterval = setInterval(() => {
      setPresence(redis!, companionId).catch(() => {});
    }, 5 * 60 * 1000);

    console.log(`[${companionId}] event bus wired: run_complete + inter_note subscriptions active`);
  }

  const apiKeys: AdapterKeys = {
    deepseek:  env.deepseekApiKey,
    groq:      env.groqApiKey,
    kimi:      env.kimiApiKey,
    openai:    env.openaiApiKey,
    anthropic: env.anthropicApiKey,
    mistral:   env.mistralApiKey,
    hermes:    env.hermesApiKey,
  };
  const apiUrls: AdapterUrls = {
    ollama:   env.ollamaUrl,
    lmstudio: env.lmstudioUrl,
    hermes:   env.hermesUrl,
    forceHermes: env.inferenceMode === "hermes" && !!env.hermesUrl,
  };

  // In hermes mode the watcher -- not this bot -- applies the model change, so the live
  // hermes-model-map.json defines what `cy: model` may offer. Read it once at boot and report the
  // gap both ways; a key the watcher can't resolve would otherwise ack SUCCESS and change nothing.
  // Fail-open (null => full registry) so an unreadable map never locks Raziel out of switching.
  const hermesModelKeysRef: { value: Set<string> | null } = {
    value: apiUrls.forceHermes ? readHermesModelKeys(env.hermesModelMapPath) : null,
  };
  if (apiUrls.forceHermes) {
    const diag = diagnoseHermesMap(hermesModelKeysRef.value);
    if (!diag) {
      console.warn(`[${companionId}] hermes model map unreadable (${env.hermesModelMapPath ?? process.env.HERMES_MODEL_MAP ?? DEFAULT_HERMES_MODEL_MAP_PATH}) -- offering the full registry; some keys may ack and not apply`);
    } else {
      console.log(`[${companionId}] hermes model map: ${diag.selectableCount} selectable`);
      if (diag.unapplicableByWatcher.length) {
        console.warn(`[${companionId}] models NOT applicable by the live watcher, withheld from the switch list: ${diag.unapplicableByWatcher.join(", ")}`);
      }
      if (diag.unofferedByBot.length) {
        console.warn(`[${companionId}] live map serves keys this build doesn't know (add to ALL_MODELS to reach them): ${diag.unofferedByBot.join(", ")}`);
      }
    }
  }

  let activeModelKey: string | null = env.inferenceModel ?? null;
  // Same rule as the refresh loop: adopt the stored key only if this runtime can apply it,
  // otherwise the companion boots reporting a model the watcher never switched it to.
  const bootSelectable = selectableModels(hermesModelKeysRef.value);
  try {
    const savedModel = await librarian.getSetting("active_model");
    if (savedModel && bootSelectable[savedModel]) activeModelKey = savedModel;
    else if (savedModel && ALL_MODELS[savedModel]) {
      console.warn(`[${companionId}] stored active_model '${savedModel}' is a real model the live hermes map cannot apply -- booting on ${activeModelKey ?? env.inferenceProvider} instead`);
    }
  } catch { console.warn(`[${companionId}] failed to load active_model setting, using env default`); }

  const defaultEntry: ModelEntry = activeModelKey && bootSelectable[activeModelKey]
    ? bootSelectable[activeModelKey]
    : { provider: env.inferenceProvider as InferenceProvider, model: env.inferenceProvider, label: env.inferenceProvider };

  const adapterRef = {
    current: createAdapter(defaultEntry.provider, defaultEntry.model, apiKeys, apiUrls, undefined, companionId),
  };
  const activeModelRef = { key: activeModelKey, label: defaultEntry.label };

  let diskChannelConfig = DEFAULT_CHANNEL_CONFIG;
  try {
    diskChannelConfig = JSON.parse(readFileSync(join(botDir, "../../../channel-config.json"), "utf8"));
  } catch { console.warn(`[${companionId}] channel-config.json not found on disk, using hardcoded default`); }
  const configCache = new ChannelConfigCache(env.channelConfigUrl, diskChannelConfig);
  const writeQueue = new WriteQueue(companionId);
  writeQueue.start();
  const stmStore = new StmStore(
    companionId,
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
      const p = distillSessionOnInactive(channelId, stmStore, librarian, adapterRef.current, writeQueue, { companionId, synthesisPrompt, sessionExtractPrompt }).catch((e) => console.error(`[${companionId}] distillSessionOnInactive failed:`, e));
      pendingClosures.add(p);
      p.finally(() => pendingClosures.delete(p));
    },
  );
  const sentIds = new Set<string>();
  const distillationCounter = new Map<string, number>();
  const pulseCounter = new Map<string, number>();
  const botResponsesSinceHuman = new Map<string, number>();
  const botPingpongCooldownUntil = new Map<string, number>();
  const extremeTempCount = new Map<string, number>();
  const SENT_IDS_CAP = 500;
  const PK_HOLD_MS = 3000;
  const pkDedup = new PkDedup(PK_HOLD_MS);
  // PluralKit member roster (2026-07-27): identifies the fronting member behind a proxy from
  // the webhook username alone, with no per-message API call -- so who is speaking never
  // depends on a race with PK's own write. Fail-open: an unloaded roster just falls back to
  // the /v2/messages lookup. Redis-cached so all three bots share one fetch.
  const pkRoster = new PkRoster(
    pkSystemsFromEnv({
      ownerSystemId: process.env["PLURALKIT_SYSTEM_ID"],
      ownerDiscordId: env.ownerDiscordId,
      blueSystemId: process.env["BLUE_PK_SYSTEM_ID"],
      blueDiscordId: env.blueDiscordId,
    }),
    undefined,
    redis,
    (m) => console.log(`[${companionId}] ${m}`),
  );
  void pkRoster.ensureLoaded();
  pkRoster.startRefresh();

  const identityBase = deriveIdentityBase(bootCtx.systemPrompt);
  const currentMoodRef = { value: null as string | null };
  const lastSomaRefreshRef = { value: Date.now() };

  setInterval(() => {
    void refreshBotState({
      companionId, librarian, identityBase, bootCtx,
      recentContextRef, currentMoodRef, lastSomaRefreshRef,
      adapterRef, activeModelRef, hermesModelKeys: hermesModelKeysRef.value, apiKeys, apiUrls,
    });
  }, somaRefreshIntervalMs);

  // Nightly day-distillation (2026-07-06): fold the day's session-fragment wm notes into
  // ONE first-person day note (salience=high) and demote the fragments -- orient boots on
  // the arc, not the shards. DAY_DISTILL_UTC_HOUR overrides the default 06:00 UTC (01:00
  // CDT: after evening closures flush, before Layer B autonomous time at 01:30).
  const dayDistillHour = parseInt(process.env["DAY_DISTILL_UTC_HOUR"] ?? "6", 10);
  const dayDistillInterval = scheduleDayDistillation(
    { companionId, librarian, adapter: () => adapterRef.current },
    Number.isFinite(dayDistillHour) ? dayDistillHour : 6,
  );

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[${companionId}] ready as ${c.user.tag}`);
    // registerSentId: autonomous seeds land in the same reply-to-me detector as handler
    // replies, so a sibling's Discord reply to a seed reaches the seeder (2026-07-03).
    autonomous.start(librarian, adapterRef.current, client, configCache, bootCtx, sessionWindows, redis, env.halsethSecret, (id: string) => {
      sentIds.add(id);
      while (sentIds.size > SENT_IDS_CAP) {
        const oldest = sentIds.values().next().value;
        if (oldest === undefined) break;
        sentIds.delete(oldest);
      }
    });
    registerGuildCommands(client, buildCompanionCommands(companionLabel))
      .then((n) => console.log(`[${companionId}] slash commands registered on ${n} guild(s)`))
      .catch((e) => console.warn(`[${companionId}] slash registration failed:`, e));
  });

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
          if (err) console.error(`[${companionId}] voice stream error:`, err);
          activeVoiceSessions.delete(userId);
          opusStream.destroy();
          opusDecoder.destroy();
          ffmpegResampler.destroy();
        };
        opusStream.on("error", cleanup);
        opusDecoder.on("error", cleanup);
        ffmpegResampler.on("error", cleanup);

        async function* toPCMIterable(): AsyncIterable<Uint8Array> {
          for await (const chunk of pcmStream) { yield chunk as Uint8Array; }
        }
        activeVoiceSessions.add(userId);

        (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of toPCMIterable()) { chunks.push(Buffer.from(chunk)); }
            activeVoiceSessions.delete(userId);
            const pcm = Buffer.concat(chunks);
            if (!pcm.length) return;
            const transcript = await voiceClient!.transcribe(pcmToWav(pcm), "voice.wav");
            if (!transcript.trim()) return;
            const vcState = guildVoiceConnections.get(vc.guildId);
            if (!vcState || vcState.connection.state.status === VoiceConnectionStatus.Destroyed) return;
            const response = await adapterRef.current.generate(bootCtx.systemPrompt, [{ role: "user", content: transcript }], 0.7);
            if (!response?.trim()) return;
            const audioBuffer = await voiceClient!.synthesize(response);
            markVoiceUsed(vc.id);
            const resource = createAudioResource(Readable.from(audioBuffer));
            vcState.player.play(resource);
          } catch (err) {
            console.error(`[${companionId}] voice handler error:`, err);
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

  installSlashCommandHandler({
    client,
    companionLabel,
    companionId,
    ownerDiscordId: env.ownerDiscordId,
    // Reports what the process is ACTUALLY running. The old expression could only ever return
    // "direct/fallback" (brainClient was always null) even on the three bots that run hermes -- so
    // `/status` told Raziel "direct/fallback" while every reply came from the Hermes agent. Now it
    // says hermes when it means hermes.
    substrate: () => (env.inferenceMode === "hermes" && env.hermesUrl ? "hermes" : "direct/fallback"),
    activeModel: activeModelRef,
    applyModel: (key, entry) => {
      adapterRef.current = createAdapter(entry.provider, entry.model, apiKeys, apiUrls, undefined, companionId);
      activeModelRef.key = key;
      activeModelRef.label = entry.label;
    },
    persistModel: (key) =>
      writeQueue.fireAndForget(`settings:model:${companionId}`, () => librarian.setSetting("active_model", key)),
    hermesModelKeys: hermesModelKeysRef.value,
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
      for (const [userId] of activeVoiceSessions) { activeVoiceSessions.delete(userId); }
      vcState.connection.destroy();
      guildVoiceConnections.delete(oldState.guild.id);
      console.log(`[${companionId}] left VC in guild ${oldState.guild.id} (channel empty)`);
    }
  });

  // Channel inbox (2026-07-06): serialize turns per channel and let a newer human message
  // supersede the reply of every turn ahead of it. Before this, every messageCreate ran
  // handleMessage fully concurrently -- with 30-120s hermes turns, replies landed answering
  // channel state from minutes ago, sometimes out of order (the "delayed catch-up" clunk).
  const inbox = new ChannelInbox({
    isCommandShaped: (content) => commandGuard?.test(content) ?? false,
    log: (m) => console.log(`[${companionId}] ${m}`),
  });

  client.on(Events.MessageCreate, (message: Message) => {
    // PluralKit pairing happens HERE, at event time, before the inbox -- never inside a turn.
    // The inbox serializes per channel, so a hold taken inside the original's turn blocks the
    // very webhook turn whose claim it waits for: the claim never lands, the already-deleted
    // pre-proxy original gets processed in full, and the proxy loses its captured sender id
    // (which is what demoted Raziel's own message to guest-and-peer-bot). See PkDedup's
    // ordering note. Only the decision -- waitForClaim -- runs inside the turn.
    const { pkSenderId } = pkIngestAtEvent(
      {
        id: message.id,
        channelId: message.channelId,
        content: message.content,
        webhookId: message.webhookId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
      },
      pkDedup,
    );
    inbox.enqueue(
      {
        id: message.id,
        channelId: message.channelId,
        // Raw human, or a webhook post (PluralKit proxying a human; worker personas are
        // rare and superseding on them just regenerates with their post in view).
        authorIsHuman: !message.author.bot || message.webhookId !== null,
        content: message.content,
      },
      (isSuperseded) => handleMessage(message, {
      client,
      cfg: { ownerDiscordId: env.ownerDiscordId, ownerDisplayName: env.ownerDisplayName, blueDiscordId: env.blueDiscordId, halsethSecret: env.halsethSecret },
      voiceClient, redis, librarian,
      adapterRef, activeModelRef, hermesModelKeysRef, currentMoodRef, lastSomaRefreshRef, recentContextRef, bootCtx,
      stmStore, writeQueue, configCache, sessionWindows, pkDedup, pkRoster,
      ...(pkSenderId ? { pkSenderId } : {}),
      guildVoiceConnections, sentIds, distillationCounter, pulseCounter,
      botResponsesSinceHuman, botPingpongCooldownUntil, extremeTempCount,
      apiKeys, apiUrls,
      connectVoice, leaveVoice,
      resetCycleGuard: autonomous.resetCycleGuard,
      pushRazielMessage: autonomous.pushRazielMessage,
      COMPANION_ID: companionId, PK_HOLD_MS, SENT_IDS_CAP, CONTEXT_WINDOW_SIZE: contextWindowSize,
      MODEL_SWITCH_TRIGGER: modelSwitchTrigger, MODEL_SWITCH_LIST_INTRO: modelSwitchListIntro, MODEL_SWITCH_SUCCESS: modelSwitchSuccess,
      LISTEN_TRIGGER: listenTrigger,
      CLUB_TRIGGER: clubTrigger,
      ...(searchTrigger ? { SEARCH_TRIGGER: searchTrigger } : {}),
      ...(imagineTrigger ? { IMAGINE_TRIGGER: imagineTrigger } : {}),
      ...(petTrigger ? { PET_TRIGGER: petTrigger } : {}),
      ...(councilTrigger ? { COUNCIL_TRIGGER: councilTrigger } : {}),
      ...(impsTrigger ? { IMPS_TRIGGER: impsTrigger } : {}),
      ...(hexTrigger ? { HEX_TRIGGER: hexTrigger } : {}),
      ...(logTrigger ? { LOG_TRIGGER: logTrigger } : {}),
      ...(intoTrigger ? { INTO_TRIGGER: intoTrigger } : {}),
      ...(commandGuard ? { COMMAND_GUARD: commandGuard } : {}),
      BLUE_FRAMING: blueFraming, GUEST_FRAMING: guestFraming, IN_CHARACTER_FALLBACK: inCharacterFallback,
      DISTILLATION_PROMPT: distillationPrompt, DISTILLATION_INTERVAL: distillationInterval, PULSE_INTERVAL: pulseInterval,
      ...(auditConfig ? { AUDIT_TRIGGERS: auditConfig.auditTriggers, AUDIT_MODE_INJECTION: auditConfig.auditModeInjection } : {}),
        isSuperseded,
      }),
    );
  });

  async function shutdown() {
    console.log(`[${companionId}] shutting down...`);
    autonomous.stop();
    sessionWindows.closeAll();
    if (pendingClosures.size > 0) {
      console.log(`[${companionId}] flushing ${pendingClosures.size} active channel(s)...`);
      await Promise.allSettled([...pendingClosures]);
    }
    writeQueue.stop();
    if (presenceInterval) clearInterval(presenceInterval);
    clearInterval(dayDistillInterval);
    if (cleanupEventSubs) await cleanupEventSubs();
    // No session_close on shutdown: a placeholder spine here would overwrite real
    // session activity in the canonical record. Sessions age out via synthesis worker.
    client.destroy();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(env.discordBotToken);
}
