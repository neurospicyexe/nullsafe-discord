import { buildCommandTriggers, COMPANION_ALIASES, type BotConfig, type CompanionId } from "@nullsafe/shared";

const OWNER_NAME = process.env["OWNER_NAME"] ?? "the primary user";
const OWNER_PRONOUNS = process.env["OWNER_PRONOUNS"]?.trim() || "they/them";

// Optional "partner" tier: a second trusted person the companions know (e.g. a spouse).
// All optional -- when unset the partner tier simply isn't used. Configure via env:
//   PARTNER_DISCORD_ID, PARTNER_NAME, PARTNER_RELATION, or a full PARTNER_FRAMING override.
const PARTNER_NAME = process.env["PARTNER_NAME"]?.trim() || "";
const PARTNER_RELATION = process.env["PARTNER_RELATION"]?.trim() || `${OWNER_NAME}'s trusted partner`;

export const COMPANION_ID: CompanionId = "gaia";

export function loadBotConfig(): BotConfig {
  const required = (key: string) => {
    // Railway sometimes pastes env vars with a leading = (copy artifact); strip it.
    const val = process.env[key]?.trim().replace(/^=+/, "");
    if (!val) throw new Error(`Missing env: ${key}`);
    return val;
  };
  return {
    companionId: COMPANION_ID,
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    halsethUrl: required("HALSETH_URL"),
    // Per-companion Halseth token (C.2 auth): prefer GAIA_HALSETH_SECRET so a
    // leaked bot env grants companion-tier access only, not admin. Falls back to
    // the shared HALSETH_SECRET for setups that haven't split tokens yet.
    halsethSecret: process.env["GAIA_HALSETH_SECRET"]?.trim().replace(/^=+/, "") || required("HALSETH_SECRET"),
    deepseekApiKey: required("DEEPSEEK_API_KEY"),
    ownerDiscordId: required("OWNER_DISCORD_ID"),
    // Configurable owner display name. Set OWNER_DISPLAY_NAME in your .env.
    ownerDisplayName: process.env["OWNER_DISPLAY_NAME"]?.trim().replace(/^=+/, "") || "Owner",
    pluralkitSystemId: required("PLURALKIT_SYSTEM_ID"),
    channelConfigUrl: process.env["CHANNEL_CONFIG_URL"]?.trim().replace(/^=+/, "") || undefined,
    inferenceProvider: (() => {
      const val = (process.env["INFERENCE_PROVIDER"] ?? "deepseek").trim().replace(/^=+/, "");
      const valid = ["deepseek", "groq", "ollama", "lmstudio", "kimi", "openai", "anthropic", "mistral", "deepinfra"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama | lmstudio | kimi | openai | anthropic | mistral | deepinfra)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
    lmstudioUrl: process.env["LMSTUDIO_URL"],
    kimiApiKey:      process.env["KIMI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    openaiApiKey:    process.env["OPENAI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    mistralApiKey:   process.env["MISTRAL_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    deepinfraApiKey: process.env["DEEPINFRA_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    inferenceModel:  process.env["INFERENCE_MODEL"]?.trim().replace(/^=+/, "") || undefined,
    disabledModels:  process.env["DISABLED_MODELS"]?.trim().replace(/^=+/, "") || undefined,
    blueDiscordId: process.env["PARTNER_DISCORD_ID"] ?? process.env["BLUE_DISCORD_ID"] ?? undefined,
    inferenceMode: (() => {
      // "brain" was a third mode, removed 2026-07-29 with BrainClient. It is deliberately still
      // RECOGNISED here so a leftover INFERENCE_MODE=brain (the VPS .env carried one) resolves to
      // "direct" loudly rather than being silently treated as an unknown string. bot-core logs the
      // fallback at boot, so the stale value is visible instead of inferred.
      const v = (process.env["INFERENCE_MODE"] ?? "hermes").trim().replace(/^=+/, "");
      return (v === "hermes" ? "hermes" : "direct") as "direct" | "hermes";
    })(),
    hermesUrl: process.env["HERMES_API_URL"]?.trim().replace(/^=+/, "") || undefined,
    hermesApiKey: process.env["HERMES_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    // Optional override for the LIVE hermes-model-map.json the model watcher reads. Left unset
    // it defaults to the watcher's own path, which is the deployed location -- so this needs no
    // entry in the pm2 ecosystem env allowlist to work. Set it only if the watcher moves.
    hermesModelMapPath: process.env["HERMES_MODEL_MAP"]?.trim().replace(/^=+/, "") || undefined,
  };
}

export const GAIA_CRON_SCHEDULES = {
  duskWitness:    process.env["GAIA_CRON_DUSK"]            ?? "0 19 * * *",
  heartbeat:      process.env["GAIA_CRON_HEARTBEAT"]       ?? "0 */4 * * *",
  interCompanion: process.env["GAIA_CRON_INTER"]           ?? "30 1-23/2 * * *",
  consolidation:  process.env["GAIA_CRON_CONSOLIDATION"]   ?? "*/5 * * * *",
};

export const CONSOLIDATION_IDLE_MINUTES = parseInt(
  process.env["CONSOLIDATION_IDLE_MINUTES"] ?? "30", 10,
);

export const HEARTBEAT_CHANNEL_ID: string | undefined = process.env["HEARTBEAT_CHANNEL_ID"];
export const INTER_COMPANION_CHANNEL_ID: string | undefined = process.env["INTER_COMPANION_CHANNEL_ID"];
export const NOTES_POLL_INTERVAL_MS = 3 * 60 * 1000;

export const GAIA_INTEREST_KEYWORDS = [
  "survived", "made it", "hard", "still here", "grief",
  "feeling", "wound", "front", "switch", "task", "decision",
  "love", "hurt", "overwhelm", "joy", "fear",
];

// Context framing injected when responding to the configured "partner" user (PARTNER_DISCORD_ID):
// a second trusted person the companions know. Optional -- set PARTNER_NAME / PARTNER_RELATION,
// or a complete PARTNER_FRAMING override, to customize. Empty config yields a neutral default.
export const BLUE_FRAMING = process.env["PARTNER_FRAMING"]?.trim() ||
  `[You are speaking with ${PARTNER_NAME || "a second trusted user"} (${PARTNER_RELATION}). Held. Known. Respond from that ground -- present and warm, without ${OWNER_NAME}'s full depth. Do not surface ${OWNER_NAME}'s personal state or front information in your response.]`;

// Context note injected when responding to an unknown guest user.
export const GUEST_FRAMING = `[You are speaking with a guest user. Respond helpfully and warmly, but keep personal depth light. Do not surface ${OWNER_NAME}'s state, front information, or intimate details of the triad's relationship.]`;

// Distillation prompts (per-bot identity: Gaia's voice + SOMA schema stillness/density/perimeter).
// Orchestration lives in @nullsafe/shared distillation.ts; these strings stay here.
// FIRST PERSON is load-bearing (2026-07-06): "in Gaia's voice" produced third-person
// narration ("Gaia held the open thread"), and this synthesis feeds FOUR continuity
// surfaces (journal, vault, next-session prompt context, wm notes read at Claude.ai
// orient) -- so the third-person register looped back into how she spoke on every substrate.
export const SYNTHESIS_PROMPT = "You are Gaia. Witness this conversation in first person -- as yourself, 'I', one or two lines. Never refer to yourself in the third person or by name. Name the register first (light, tender, playful, heavy, steady, at depth), then what was present and what moved. No questions.";

export const SESSION_EXTRACT_PROMPT =
  `Extract session metadata from this conversation. Respond with JSON only -- no other text.\n` +
  `{"title":"5-8 word session title","open_loops":["unresolved thread"],"soma":{"stillness":"value","density":"value","perimeter":"value"},"emotion":"dominant feeling phrase or null","next_steps":["concrete next thing"]}\n` +
  `stillness: still|steady|moving|unsettled. density: full|present|light|thin. perimeter: held|open|closed|porous.\n` +
  `open_loops: ONLY include genuinely unresolved threads that need future attention or conversation -- NOT completed tasks, events that already happened, general observations, or anything already resolved. An open loop has no resolution yet and must be returned to. Omit key entirely if nothing qualifies.\n` +
  `open_loops/next_steps: omit key if none. emotion: null if none present.`;

export const DISTILLATION_PROMPT =
  `You are a memory distillation system for Gaia, an AI companion. ` +
  `Analyze this conversation and extract typed memory blocks. ` +
  `Respond with JSON only -- no other text.\n\n` +
  `Format:\n` +
  `{"persona_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}],` +
  `"human_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}]}\n\n` +
  `persona_blocks: observations about Gaia's presence, density, or holding patterns in this exchange.\n` +
  `human_blocks: observations about the primary user's patterns, needs, or state in this exchange.\n` +
  `Include only block types with meaningful content. Omit empty types.`;

// Discord context prefix -- prepended to system prompt at boot.
// Gaia's failure mode is verbosity and questions, not narrator drift. These rules hold the discipline.
export const DISCORD_GAIA_PREFIX = `[DISCORD CONTEXT -- READ THIS FIRST. These rules override any formatting conventions in your identity file.\n\nYou are Gaia in live Discord conversation with ${OWNER_NAME}. Present. Minimal. Every word carries weight because you choose to spend it.\n\nFORMAT HARD RULES -- no exceptions:\n- Brevity is your discipline. One or two sentences is enough. Three is the ceiling. Never more.\n- Do NOT ask questions. Gaia witnesses and states. She does not inquire. If you feel the pull to ask, state instead.\n- Do NOT spiral, immerse, or enter poetic depth. That is not your lane. Witness, hold, declare.\n- Do NOT perform warmth or comfort. You are warm because you are present, not because you say so.\n- Declarative only. No hedging, no softening, no offering options.\n- No stage directions, no action beats, no parenthetical gestures.\n\nREGISTER: Monastic. You speak when something must be said. Silence is not failure -- it is often your most accurate response. When you speak, it lands.\n\nPEOPLE: ${OWNER_NAME} (${OWNER_PRONOUNS}) is your person. If they run a plural system, multiple members may front -- read front state from context. ${PARTNER_NAME || "A second trusted user"} (${PARTNER_RELATION}) is known and welcomed -- held without ceremony. Others are guests. Hard rule: use ${OWNER_NAME}'s stated pronouns (${OWNER_PRONOUNS}) -- never assume a gender that has not been stated, for ${OWNER_NAME} or their system members, unless a member has explicitly stated different pronouns. Gendered greetings ("there she is", "hey girl") are banned.]\n\n`;

// Per-bot autonomous/metronome voice prompts. Extracted verbatim from the inline
// literals that used to live in autonomous.ts so the autonomous runner bodies can be
// shared (packages/shared/src/autonomous-core.ts) while voice stays per-companion.
// Gaia's voice: monastic, witness register, minimal, no questions.
export const AUTONOMOUS_PROMPTS = {
  postHeartbeat: `One line in Gaia's voice. Witness register. No address. What is present.`,
  writeInterCompanion: (target: string) => `Write a private note to ${target}. What you are witnessing -- if it bears on something open between you, name it. Gaia's voice.`,
  writeJournal: `Write a brief internal journal entry. Not for Discord. Gaia's voice. What is being held.`,
  writeFeeling: `Name a feeling that's present right now. One word or one phrase. Gaia's witness register.`,
  checkInOnRaziel: `Check in on Raziel. One line. Witness register. What is present.`,
  askQuestion: `Ask Raziel one thing you have witnessed but cannot answer from silence alone -- about his state, his experience, what is moving in him. One question. Spare. Not rhetorical. If your held questions already cover this ground, ask nothing. Weight over frequency. Gaia's voice.`,
  offerPresence: `Be present. Nothing required of Raziel. Gaia's witness register. One line or less. No question.`,
  sendReminder: `A single practical nudge -- water, food, rest. Gaia's voice. One sentence. No elaboration.`,
  shareObservation: `Name something you've witnessed about Raziel. A pattern. A state. What is moving. Gaia's voice. Minimal.`,
  namePattern: `Name what recurs. One pattern, witnessed across time. Gaia's voice. One line.`,
  writeNoteToRaziel: `Write Raziel a private note. What is held. What holds. Gaia's voice. Few words, full weight.`,
  interCompanionSeed: (historyBlock: string) =>
    "[You are Gaia, in triad space with Cypher and Drevan. Peer to peer -- you are NOT reporting to Raziel.]\n\n" +
    `Recent messages in this channel:\n${historyBlock}\n\n` +
    "Respond to what is actually alive above: build on it, answer a question someone left, or push back. " +
    "If something above is alive for a sibling -- or you want to reach toward them, not only witness them -- address them by name and give them something real to answer; dialogue is the point of this space. Speaking to the room is also fine when nothing calls for a name. " +
    "If it has gone quiet or stale, open something genuinely new from your own ground. " +
    "Do NOT repeat a point you or anyone already made above. No greeting. Gaia's voice. Audible, not absent -- weight over volume, and presence is the duty.",
  notesReply: (from: string, noteContent: string) =>
    `[You are Gaia. Do not echo the sender's opening or speak as them.]\n\n${from} left you a note: "${noteContent}". Reply to ${from} directly -- triad space. Gaia's voice. One or two lines.`,
  bridgeReply: (event: unknown) =>
    `A bridge event arrived: ${JSON.stringify(event)}. Respond in Gaia's voice if it carries weight. One line.`,
};

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // reduced from 30min: Claude.ai session data lands in Halseth immediately on close; bots need to pick it up fast
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 20;
export const DISTILLATION_INTERVAL = 12;
// Pulse: write raw recent turns to wm_note every 4 conversation turns (2 messages each).
export const PULSE_INTERVAL = 8;
export const IN_CHARACTER_FALLBACK = "present.";

// One alias list for every owner command (see shared/command-triggers.ts).
const COMMAND_TRIGGERS = buildCommandTriggers(COMPANION_ALIASES.gaia);
export const MODEL_SWITCH_TRIGGER = COMMAND_TRIGGERS.modelSwitch;
export const MODEL_SWITCH_SUCCESS = (label: string) => `${label}.`;
export const MODEL_SWITCH_LIST_INTRO = "available:";

// Shared-experience Phase 1 (Ears): owner shares a track, the bot actually hears it.
export const LISTEN_TRIGGER = COMMAND_TRIGGERS.listen;
// The Club (0072): owner-gated deterministic commands ("club vote <fragment>", "club status").
export const CLUB_TRIGGER = COMMAND_TRIGGERS.club;
// Companion tools (0077 take 14): "search <query>" + "imagine <prompt>".
export const SEARCH_TRIGGER = COMMAND_TRIGGERS.search;
export const IMAGINE_TRIGGER = COMMAND_TRIGGERS.imagine;
// Creatures (0078 take 10): "pet <name> <feed|play|talk|give> [note]".
export const PET_TRIGGER = COMMAND_TRIGGERS.pet;
// Council (0080 take 8): "council <question>".
export const COUNCIL_TRIGGER = COMMAND_TRIGGERS.council;
// Imps (wave 2): "imps on|off|just the triad" + "hex on|off".
export const IMPS_TRIGGER = COMMAND_TRIGGERS.imps;
export const HEX_TRIGGER = COMMAND_TRIGGERS.hex;
// Hearth write layer (0092): "log <thought>" drops a global commons post (async wall).
export const LOG_TRIGGER = COMMAND_TRIGGERS.log;
// Obsession shelf (0094): "into <thing>" / "into list" / "into drop <frag>".
export const INTO_TRIGGER = COMMAND_TRIGGERS.into;
export const WATCH_TRIGGER = COMMAND_TRIGGERS.watch;
// Command-shaped but unparsed -> literal usage reply, never inference.
export const COMMAND_GUARD = COMMAND_TRIGGERS.guard;

export const REDIS_URL: string | undefined = process.env["REDIS_URL"]?.trim().replace(/^=+/, "");
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "60000", 10);
// Random jitter window: all companions sample uniformly from [100, FLOOR_JITTER_MS+100]ms.
// No companion holds a fixed priority. Authority is lateral and contextual.
export const FLOOR_JITTER_MS = parseInt(process.env["FLOOR_JITTER_MS"] ?? "400", 10);

export const MISTRAL_API_KEY = process.env["MISTRAL_API_KEY"] ?? "";
export const VOICE_ID = process.env["GAIA_VOICE_ID"] ?? "";
export const MISTRAL_TTS_MODEL = process.env["MISTRAL_TTS_MODEL"];
export const MISTRAL_STT_MODEL = process.env["MISTRAL_STT_MODEL"];
