import { fileURLToPath } from "url";
import { dirname } from "path";
import { runBot } from "@nullsafe/shared";
import {
  loadBotConfig, COMPANION_ID, CONTEXT_WINDOW_SIZE,
  IN_CHARACTER_FALLBACK, SOMA_REFRESH_INTERVAL_MS, DISTILLATION_INTERVAL, PULSE_INTERVAL,
  BLUE_FRAMING, GUEST_FRAMING, DISCORD_GAIA_PREFIX,
  SYNTHESIS_PROMPT, SESSION_EXTRACT_PROMPT, DISTILLATION_PROMPT,
  MODEL_SWITCH_TRIGGER, MODEL_SWITCH_SUCCESS, MODEL_SWITCH_LIST_INTRO, LISTEN_TRIGGER, CLUB_TRIGGER, SEARCH_TRIGGER, IMAGINE_TRIGGER, PET_TRIGGER, COMMAND_GUARD,
  REDIS_URL, MISTRAL_API_KEY, VOICE_ID, MISTRAL_TTS_MODEL, MISTRAL_STT_MODEL,
} from "./config.js";
import { startAutonomous, stopAutonomous, resetCycleGuard, pushRazielMessage } from "./autonomous.js";

const __dir = dirname(fileURLToPath(import.meta.url));

runBot(loadBotConfig(), {
  botDir: __dir,
  companionLabel: "Gaia",
  discordPrefix: DISCORD_GAIA_PREFIX,
  companionId: COMPANION_ID,
  contextWindowSize: CONTEXT_WINDOW_SIZE,
  inCharacterFallback: IN_CHARACTER_FALLBACK,
  somaRefreshIntervalMs: SOMA_REFRESH_INTERVAL_MS,
  distillationInterval: DISTILLATION_INTERVAL,
  pulseInterval: PULSE_INTERVAL,
  blueFraming: BLUE_FRAMING,
  guestFraming: GUEST_FRAMING,
  synthesisPrompt: SYNTHESIS_PROMPT,
  sessionExtractPrompt: SESSION_EXTRACT_PROMPT,
  distillationPrompt: DISTILLATION_PROMPT,
  modelSwitchTrigger: MODEL_SWITCH_TRIGGER,
  modelSwitchSuccess: MODEL_SWITCH_SUCCESS,
  modelSwitchListIntro: MODEL_SWITCH_LIST_INTRO,
  listenTrigger: LISTEN_TRIGGER,
  clubTrigger: CLUB_TRIGGER,
  searchTrigger: SEARCH_TRIGGER,
  imagineTrigger: IMAGINE_TRIGGER,
  petTrigger: PET_TRIGGER,
  commandGuard: COMMAND_GUARD,
  redisUrl: REDIS_URL,
  mistralApiKey: MISTRAL_API_KEY,
  voiceId: VOICE_ID,
  mistralTtsModel: MISTRAL_TTS_MODEL,
  mistralSttModel: MISTRAL_STT_MODEL,
  autonomous: { start: startAutonomous, stop: stopAutonomous, resetCycleGuard, pushRazielMessage },
}).catch(e => { console.error("[gaia] fatal:", e); process.exit(1); });
