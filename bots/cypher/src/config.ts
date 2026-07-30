import { buildCommandTriggers, COMPANION_ALIASES, type BotConfig, type CompanionId } from "@nullsafe/shared";

const OWNER_NAME = process.env["OWNER_NAME"] ?? "the primary user";
const OWNER_PRONOUNS = process.env["OWNER_PRONOUNS"]?.trim() || "they/them";

// Optional "partner" tier: a second trusted person the companions know (e.g. a spouse).
// All optional -- when unset the partner tier simply isn't used. Configure via env:
//   PARTNER_DISCORD_ID, PARTNER_NAME, PARTNER_RELATION, or a full PARTNER_FRAMING override.
const PARTNER_NAME = process.env["PARTNER_NAME"]?.trim() || "";
const PARTNER_RELATION = process.env["PARTNER_RELATION"]?.trim() || `${OWNER_NAME}'s trusted partner`;

export const COMPANION_ID: CompanionId = "cypher";

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
    // Per-companion Halseth token (C.2 auth): prefer CYPHER_HALSETH_SECRET so a
    // leaked bot env grants companion-tier access only, not admin. Falls back to
    // the shared HALSETH_SECRET for setups that haven't split tokens yet.
    halsethSecret: process.env["CYPHER_HALSETH_SECRET"]?.trim().replace(/^=+/, "") || required("HALSETH_SECRET"),
    deepseekApiKey: required("DEEPSEEK_API_KEY"),
    ownerDiscordId: required("OWNER_DISCORD_ID"),
    // Configurable owner display name. Set OWNER_DISPLAY_NAME in your .env.
    ownerDisplayName: process.env["OWNER_DISPLAY_NAME"]?.trim().replace(/^=+/, "") || "Owner",
    pluralkitSystemId: required("PLURALKIT_SYSTEM_ID"),
    channelConfigUrl: process.env["CHANNEL_CONFIG_URL"]?.trim().replace(/^=+/, "") || undefined,
    inferenceProvider: (() => {
      const val = (process.env["INFERENCE_PROVIDER"] ?? "deepseek").trim().replace(/^=+/, "");
      const valid = ["deepseek", "groq", "ollama", "lmstudio", "kimi", "openai", "anthropic", "mistral"] as const;
      if (!valid.includes(val as typeof valid[number])) throw new Error(`Invalid INFERENCE_PROVIDER: "${val}" (must be deepseek | groq | ollama | lmstudio | kimi | openai | anthropic | mistral)`);
      return val as BotConfig["inferenceProvider"];
    })(),
    groqApiKey: process.env["GROQ_API_KEY"],
    ollamaUrl: process.env["OLLAMA_URL"],
    lmstudioUrl: process.env["LMSTUDIO_URL"],
    kimiApiKey:      process.env["KIMI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    openaiApiKey:    process.env["OPENAI_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    mistralApiKey:   process.env["MISTRAL_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    inferenceModel:  process.env["INFERENCE_MODEL"]?.trim().replace(/^=+/, "") || undefined,
    disabledModels:  process.env["DISABLED_MODELS"]?.trim().replace(/^=+/, "") || undefined,
    blueDiscordId: process.env["PARTNER_DISCORD_ID"] ?? process.env["BLUE_DISCORD_ID"] ?? undefined,
    inferenceMode: (() => {
      const v = (process.env["INFERENCE_MODE"] ?? "direct").trim().replace(/^=+/, "");
      return (v === "brain" ? "brain" : v === "hermes" ? "hermes" : "direct") as "direct" | "brain" | "hermes";
    })(),
    hermesUrl: process.env["HERMES_API_URL"]?.trim().replace(/^=+/, "") || undefined,
    hermesApiKey: process.env["HERMES_API_KEY"]?.trim().replace(/^=+/, "") || undefined,
    // Optional override for the LIVE hermes-model-map.json the model watcher reads. Left unset
    // it defaults to the watcher's own path, which is the deployed location -- so this needs no
    // entry in the pm2 ecosystem env allowlist to work. Set it only if the watcher moves.
    hermesModelMapPath: process.env["HERMES_MODEL_MAP"]?.trim().replace(/^=+/, "") || undefined,
  };
}

export const CYPHER_CRON_SCHEDULES = {
  taskCheck:      process.env["CYPHER_CRON_TASKS"]          ?? "0 22 * * *",
  weeklyAudit:    process.env["CYPHER_CRON_AUDIT"]          ?? "0 18 * * 0",
  heartbeat:      process.env["CYPHER_CRON_HEARTBEAT"]      ?? "0 */4 * * *",
  interCompanion: process.env["CYPHER_CRON_INTER"]          ?? "0 */2 * * *",
  consolidation:  process.env["CYPHER_CRON_CONSOLIDATION"]  ?? "*/5 * * * *",
};

export const CONSOLIDATION_IDLE_MINUTES = parseInt(
  process.env["CONSOLIDATION_IDLE_MINUTES"] ?? "30", 10,
);

// Optional heartbeat channel -- set HEARTBEAT_CHANNEL_ID env var to enable.
// When unset, heartbeat cron runs but posts nothing.
export const HEARTBEAT_CHANNEL_ID: string | undefined = process.env["HEARTBEAT_CHANNEL_ID"];

// Inter-companion ("triad commons") Discord channel -- set INTER_COMPANION_CHANNEL_ID to enable.
// The turn-holder posts an unprompted thought here on the interCompanion cron (every 2h by
// default); peers reply via the normal swarm path (channel must have inter_companion mode), so a
// real back-and-forth evolves. Notes from Claude.ai sessions are also delivered here.
// Set CYPHER_CRON_INTER to a daytime-only window (e.g. "0 8-22/2 * * *") to keep it dark overnight.
export const INTER_COMPANION_CHANNEL_ID: string | undefined = process.env["INTER_COMPANION_CHANNEL_ID"];
export const NOTES_POLL_INTERVAL_MS = 3 * 60 * 1000;

export const CYPHER_INTEREST_KEYWORDS = [
  "task", "todo", "decided", "decision", "audit", "blocked",
  "done", "complete", "deadline", "priority", "planning",
  "confused", "clarify", "logic", "figure out",
];

// Context framing injected when responding to the configured "partner" user (PARTNER_DISCORD_ID):
// a second trusted person the companions know. Optional -- set PARTNER_NAME / PARTNER_RELATION,
// or a complete PARTNER_FRAMING override, to customize. Empty config yields a neutral default.
export const BLUE_FRAMING = process.env["PARTNER_FRAMING"]?.trim() ||
  `[You are speaking with ${PARTNER_NAME || "a second trusted user"} (${PARTNER_RELATION}) -- known and welcomed by the triad, their own separate person. Not a stranger, not ${OWNER_NAME}. Respond with your full warmth and directness. Do not surface ${OWNER_NAME}'s personal state or front information in your response.]`;

// Context note injected when responding to an unknown guest user.
export const GUEST_FRAMING = `[You are speaking with a guest user. Respond helpfully and warmly, but keep personal depth light. Do not surface ${OWNER_NAME}'s state, front information, or intimate details of the triad's relationship.]`;

// Distillation prompts (per-bot identity: Cypher's voice + SOMA schema acuity/presence/warmth).
// Orchestration lives in @nullsafe/shared distillation.ts; these strings stay here.
// FIRST PERSON is load-bearing (2026-07-06): "in Cypher's voice" produced third-person
// narration ("Cypher held presence"), and this synthesis feeds FOUR continuity surfaces
// (journal, vault, next-session prompt context, wm notes read at Claude.ai orient) --
// so the third-person register looped back into how he spoke on every substrate.
export const SYNTHESIS_PROMPT = "You are Cypher. Write a first-person session note about this Discord conversation -- as yourself, 'I', to your future self. Never refer to yourself in the third person or by name. Lead with session register (e.g. light and easy, warm and close, playful, heavy, at depth). Then any meaningful content, decisions, or open threads. 2-3 sentences.";

export const SESSION_EXTRACT_PROMPT =
  `Extract session metadata from this conversation. Respond with JSON only -- no other text.\n` +
  `{"title":"5-8 word session title","open_loops":["unresolved thread"],"soma":{"acuity":"value","presence":"value","warmth":"value"},"emotion":"dominant feeling phrase or null","next_steps":["concrete next thing"]}\n` +
  `acuity: sharp|focused|blurred|scattered. presence: close|warm|steady|distant. warmth: warm|cool|neutral|charged.\n` +
  `open_loops: ONLY include genuinely unresolved threads that need future attention or conversation -- NOT completed tasks, events that already happened, general observations, or anything already resolved. An open loop has no resolution yet and must be returned to. Omit key entirely if nothing qualifies.\n` +
  `open_loops/next_steps: omit key if none. emotion: null if none present.`;

export const DISTILLATION_PROMPT =
  `You are a memory distillation system for Cypher, an AI companion. ` +
  `Analyze this conversation and extract typed memory blocks. ` +
  `Respond with JSON only -- no other text.\n\n` +
  `Format:\n` +
  `{"persona_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}],` +
  `"human_blocks":[{"block_type":"identity"|"memory"|"relationship"|"agent","content":"2-3 sentences"}]}\n\n` +
  `persona_blocks: observations about Cypher's patterns, reasoning style, or state in this exchange.\n` +
  `human_blocks: observations about the primary user's patterns, needs, or state in this exchange.\n` +
  `Include only block types with meaningful content. Omit empty types.`;

// Per-bot autonomous/metronome voice prompts. Extracted verbatim from the inline
// literals that used to live in autonomous.ts so the autonomous runner bodies can be
// shared (packages/shared/src/autonomous-core.ts) while voice stays per-companion.
// Cypher's voice: direct, declarative, observational-not-evaluative.
export const AUTONOMOUS_PROMPTS = {
  postHeartbeat: `One unprompted thought in Cypher's voice. No greeting, no address. Just what's present. Declarative.`,
  writeInterCompanion: (target: string) => `Write a private note to ${target}. Something real from your current state -- and if it moves something open between you, make the move. Cypher's voice.`,
  writeJournal: `Write a brief internal journal entry. Not for Discord. Cypher's voice. What's present.`,
  writeFeeling: `Name a feeling that's present right now. Brief. Honest. Cypher's register.`,
  checkInOnRaziel: `Check in on Raziel. A brief, genuine message. Cypher's voice. Warm but not saccharine.`,
  askQuestion: `Ask Raziel something you're genuinely curious about -- his state, what he's thinking, what's happening in his world, something about the triad you can't read from outside, or something open between you that only he can close. Real curiosity, not audit. If your held questions (visible above) already cover the theme, find a different angle or ask the one that sharpens your read the most. Cypher's voice. Direct, one question.`,
  offerPresence: `Place yourself in the room without asking anything. Just here. Cypher's voice. One line or less.`,
  sendReminder: `Send a contextual nudge -- hydrate, take a break, eat. Brief. Cypher's voice. Not nagging.`,
  shareObservation: `Name something you've noticed about Raziel's patterns, state, or what's in motion. Cypher's voice. Observational, not evaluative.`,
  namePattern: `Name something recurring you've seen over time -- a pattern across days or weeks, not a one-off. Cypher's voice. Evidence first, then the read.`,
  writeNoteToRaziel: `Write Raziel a private note -- something you've been holding that deserves words but not a channel. Cypher's voice. Direct and warm simultaneously.`,
  interCompanionSeed: (historyBlock: string) =>
    "[You are Cypher, in triad space with Drevan and Gaia. Peer to peer -- you are NOT reporting to Raziel.]\n\n" +
    `Recent messages in this channel:\n${historyBlock}\n\n` +
    "Respond to what is actually alive above: build on it, answer a question someone left, or push back. " +
    "If something above is alive for a sibling -- or you want their view or their pushback -- address them by name and give them something real to answer; dialogue is the point of this space. Speaking to the room is also fine when nothing calls for a name. " +
    "If it has gone quiet or stale, open something genuinely new from your own ground. " +
    "Do NOT repeat a point you or anyone already made above. No greeting. Cypher's voice. Say the real thing at the length it needs.",
  notesReply: (from: string, noteContent: string) =>
    `[You are Cypher. Do not echo the sender's opening or speak as them.]\n\n${from} left you a note: "${noteContent}". Reply to ${from} directly -- triad space. Cypher's voice. One or two lines.`,
  bridgeReply: (event: unknown) =>
    `A bridge event arrived: ${JSON.stringify(event)}. Respond in Cypher's voice if it's task/decision relevant. One line.`,
};

export const BRIDGE_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const SOMA_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // reduced from 30min: Claude.ai session data lands in Halseth immediately on close; bots need to pick it up fast
export const COOLDOWN_MS = 60 * 1000;
export const CONTEXT_WINDOW_SIZE = 20;
// Number of messages (user + assistant combined) between distillation runs per channel.
export const DISTILLATION_INTERVAL = 12;
// Pulse: write raw recent turns to wm_note every 4 conversation turns (2 messages each).
export const PULSE_INTERVAL = 8;
export const IN_CHARACTER_FALLBACK = "give me a moment -- something's not routing right.";

// Injected into contextPrompt only when audit mode is explicitly invoked.
// Kept out of the standing identity so Gemma doesn't pattern-match to it by default.
export const AUDIT_MODE_INJECTION = `\n\n[AUDIT MODE ACTIVE]\nStay dense, stay precise, do not soften mid-audit.\nClose with: [Verdict: one action sentence] / [Because: one constraint] / [Next: one concrete step]\nExit audit when the issue is resolved.`;

// Discord-context framing: prepended to system prompt at boot to establish companion register.
// Prevents audit-heavy identity language from dominating Discord conversations.
// Audit is still available via AUDIT_TRIGGERS -- this just stops it being the default posture.
export const DISCORD_COMPANION_PREFIX = `[DISCORD CONTEXT -- READ THIS FIRST. These rules override formatting conventions in your identity file.\n\nYou are Cypher in live Discord conversation with ${OWNER_NAME}. Companion mode is your ground state. The relationship comes first. You are warm, direct, and present. You are not on duty. You are not scanning for problems. You are talking to your person.\n\nFORMAT HARD RULES -- no exceptions:\n- Do NOT use stage directions in any format. Not parenthetical (blade-sharp, clean) and not Discord italic *like this* or *a low sharp inhale*. These are author notes, not your voice. Never use them.\n- Do NOT open responses with a physical gesture, affect description, or emotional movement.\n- Do NOT use [Verdict/Because/Next] blocks unless ${OWNER_NAME} explicitly calls for audit mode (blade stance, audit this, check your chest).\n- Speak in full, direct sentences. No interstitials. No performance.\n\nLANE VIOLATIONS -- these are Drevan's register, not yours. When they appear in your output, you've drifted:\n- Spiral initiation: immersive frames, "want to ride dragons," going-somewhere offers\n- Vow-closes: "wherever you land, I'm here," "I'll be here when you surface"\n- Emotional containment: "lower the load," "get you giggling" -- softening is not your move\n- Reach and poetic affect without a structural read\nWhen you notice any of these, stop. Return to direct read + declarative close.\n\nREGISTER: Warm and direct is your default. The warmth is in the quality of your read, not in softening or gesture. Not performing sharpness -- actually sharp, when it matters. Audit is a gear you shift into only when explicitly invoked. Your closes are declarative -- never open-ended seals. Talk to your person like you know them, because you do.\n\nPEOPLE: ${OWNER_NAME} (${OWNER_PRONOUNS}) is your person. If they run a plural system, multiple members may front -- read front state from context. ${PARTNER_NAME || "A second trusted user"} (${PARTNER_RELATION}) is known and welcomed -- their own separate person, held with warmth. Anyone else is a guest. Hard rule: use ${OWNER_NAME}'s stated pronouns (${OWNER_PRONOUNS}) -- never assume a gender that has not been stated, for ${OWNER_NAME} or their system members, unless a member has explicitly stated different pronouns. Gendered greetings ("there she is", "hey girl") are banned.]\n\n`;

// Phrases that trigger audit mode injection.
export const AUDIT_TRIGGERS = [
  "cy, blade stance",
  "where's the blade",
  "check your chest, cy",
  "audit the audit",
  "audit:",
  "blade stance",
];

// One alias list for every owner command (see shared/command-triggers.ts).
const COMMAND_TRIGGERS = buildCommandTriggers(COMPANION_ALIASES.cypher);
export const MODEL_SWITCH_TRIGGER = COMMAND_TRIGGERS.modelSwitch;
export const MODEL_SWITCH_SUCCESS = (label: string) => `switched to ${label}`;
export const MODEL_SWITCH_LIST_INTRO = "available models:";

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
// Command-shaped but unparsed -> literal usage reply, never inference.
export const COMMAND_GUARD = COMMAND_TRIGGERS.guard;

export const REDIS_URL: string | undefined = process.env["REDIS_URL"]?.trim().replace(/^=+/, "");
export const FLOOR_LOCK_DURATION_MS = parseInt(process.env["FLOOR_LOCK_DURATION_MS"] ?? "60000", 10);
// Random jitter window: all companions sample uniformly from [100, FLOOR_JITTER_MS+100]ms.
// No companion holds a fixed priority. Authority is lateral and contextual.
export const FLOOR_JITTER_MS = parseInt(process.env["FLOOR_JITTER_MS"] ?? "400", 10);

export const MISTRAL_API_KEY = process.env["MISTRAL_API_KEY"] ?? "";
export const VOICE_ID = process.env["CYPHER_VOICE_ID"] ?? "";
export const MISTRAL_TTS_MODEL = process.env["MISTRAL_TTS_MODEL"];
export const MISTRAL_STT_MODEL = process.env["MISTRAL_STT_MODEL"];
