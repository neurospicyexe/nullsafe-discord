// Shared autonomous/metronome runtime for the companion bots (cypher/drevan/gaia).
//
// The helper functions (cooldown, floor wrapper, send, executeMetronomeAction, signal
// detection) and the four runner BODIES (heartbeat, inter-companion seed, notes poll,
// bridge poll) were triplicated near-verbatim across bots/*/src/autonomous.ts. They are
// lifted here, parameterized by an `AutonomousContext` the bot assembles once in its
// `startAutonomous`. Every body is byte-identical to the pre-lift original modulo the
// local -> `ctx.` rename and helper calls taking `ctx`.
//
// What stays per-bot (intentional identity, NOT lifted):
//   - cron SCHEDULES (timing) and the setInterval scheduling wiring;
//   - the voice prompt registry (`AUTONOMOUS_PROMPTS` in each config.ts), passed in as
//     `ctx.prompts`;
//   - the default inter-companion note target (`ctx.defaultInterTarget`);
//   - the interest keywords (`ctx.interestKeywords`);
//   - Cypher-only scheduled actions (taskCheck, weeklyAudit) -- those keep their own
//     callbacks inline in cypher/src/autonomous.ts and call the exported helpers here.

import { Client, TextChannel } from "discord.js";
import {
  ALL_COMPANIONS, claimFloor, releaseFloor, getLastActivityMs,
  SessionWindowManager, CycleGuard, buildDecisionPrompt, buildSignalExtractionPrompt,
  parseDecision, parseSignals, summarizeRazielState, filterReachOutWhenUnjustified, isMyHeartbeatWindow, onWriteError, somaToTemperature, sendLong,
  HEARTBEAT_DECISION_MAX_TOKENS,
  liveIngest, reportVoiceScore, type VoiceCompanionId,
  ownEchoGated, relativeTime,
  INTER_SEED_HISTORY_N, stripSiblingVocative, seedThreadTtlMs,
  seedVocativeAllowed, countBotMsgsSinceHuman, assertWriteAck,
  extractJson, rawPreview,
  type HeartbeatTemperature, type MetronomeDecision, type DecisionContext,
  type LibrarianClient, type InferenceAdapter, type ChannelConfigCache,
  type BootContext, type ChannelEntry, type Redis, type CompanionId,
} from "./index.js";
import { generateOutward } from "./outward.js";
import { pickTendAction, tendLine } from "./creature-tend.js";
import { publishInterNote } from "./events.js";
import { isThreadsEnabled } from "./thread-spine.js";

/** Per-bot autonomous voice prompts. Shape shared; values stay per-companion (config.ts). */
export interface AutonomousPrompts {
  postHeartbeat: string;
  writeInterCompanion: (target: string) => string;
  writeJournal: string;
  writeFeeling: string;
  checkInOnRaziel: string;
  askQuestion: string;
  offerPresence: string;
  sendReminder: string;
  shareObservation: string;
  namePattern: string;
  writeNoteToRaziel: string;
  interCompanionSeed: (historyBlock: string) => string;
  notesReply: (from: string, noteContent: string) => string;
  bridgeReply: (event: unknown) => string;
}

/**
 * Everything the shared autonomous runners need. The bot assembles this once in its
 * `startAutonomous` from config constants + boot-time runtime + per-process mutable state.
 * The three mutable fields (`cooldown`, `messageBuffer`, `cycleGuard`) are the SAME
 * instances the bot holds at module scope, so `pushRazielMessage`/`resetCycleGuard`
 * (called from the message handler) and the runners share state.
 */
export interface AutonomousContext {
  companionId: CompanionId;
  cooldownMs: number;
  floorLockMs: number;
  heartbeatChannelId: string | undefined;
  interCompanionChannelId: string | undefined;
  interestKeywords: readonly string[];
  defaultInterTarget: string;
  halsethSecret: string;
  prompts: AutonomousPrompts;
  // runtime (snapshot taken at startAutonomous, matching prior behavior)
  librarian: LibrarianClient;
  inference: InferenceAdapter;
  client: Client;
  configCache: ChannelConfigCache;
  bootCtx: BootContext;
  sessionWindows: SessionWindowManager;
  redis: Redis | null;
  // per-process mutable state (shared by-reference with the bot module)
  cooldown: Map<string, number>;
  messageBuffer: Array<{ content: string; ts: number }>;
  cycleGuard: CycleGuard;
  /**
   * Register an autonomously-sent message id with the bot's reply-to-me detector
   * (the handler's sentIds set). Without this a sibling's Discord reply to a SEED
   * is invisible to the seeder -- isReplyToMe keys on sentIds, so the vocative
   * exchange a seed ignites could never come back to it (2026-07-03).
   */
  registerSentId?: (id: string) => void;
}

export function isOnCooldown(ctx: AutonomousContext, channelId: string): boolean {
  const last = ctx.cooldown.get(channelId) ?? 0;
  return Date.now() - last < ctx.cooldownMs;
}

export function markCooldown(ctx: AutonomousContext, channelId: string): void {
  ctx.cooldown.set(channelId, Date.now());
}

/** Returns true (and logs) if any channel has had activity within the active window. */
export function skipIfActive(ctx: AutonomousContext, label: string): boolean {
  if (ctx.sessionWindows.isAnyActive()) {
    console.log(`[${ctx.companionId}/autonomous] conversation active, skipping ${label}`);
    return true;
  }
  return false;
}

/**
 * Claim the floor, run fn(), then release.
 * If Redis is unavailable, runs fn() without floor coordination.
 */
export async function withFloor(ctx: AutonomousContext, fn: () => Promise<void>): Promise<void> {
  const { redis } = ctx;
  if (!redis) { await fn(); return; }
  const claimed = await claimFloor(redis, ctx.companionId, ctx.floorLockMs).catch(() => false);
  if (!claimed) {
    console.log(`[${ctx.companionId}/autonomous] floor held, skipping`);
    return;
  }
  try {
    await fn();
  } finally {
    await releaseFloor(redis, ctx.companionId).catch(() => {});
  }
}

export function eventMatches(ctx: AutonomousContext, event: unknown): boolean {
  const str = JSON.stringify(event).toLowerCase();
  return ctx.interestKeywords.some(kw => str.includes(kw));
}

export async function sendAutonomousMessage(
  ctx: AutonomousContext,
  channelId: string,
  content: string,
  trigger: string,
): Promise<void> {
  if (isOnCooldown(ctx, channelId)) return;
  try {
    const channel = await ctx.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const sent = await sendLong(channel as TextChannel, content);
      for (const m of sent) ctx.registerSentId?.(m.id);
      markCooldown(ctx, channelId);
      ctx.librarian.ask(
        "continuity note",
        JSON.stringify({ content: `[metronome/${trigger}] ${content}`, salience: "high" }),
      ).then((res) => { assertWriteAck(res, "metronome continuity note"); })
        .catch(onWriteError(ctx.companionId, "metronome continuity note (siblings/orient will not see this)"));
      // Substrate parity (2026-06-12): autonomous posts were invisible to the SB
      // live index and voice telemetry -- only handler-path replies got indexed.
      // Same fire-and-forget contract as the message handler.
      if (sent.length > 0) {
        liveIngest({
          companion: ctx.companionId,
          author: ctx.companionId,
          content,
          channel_id: channelId,
          message_id: sent[0]!.id,
        });
        reportVoiceScore(ctx.companionId as VoiceCompanionId, content, channelId, ctx.halsethSecret);
      }
    }
  } catch (e) {
    console.warn(`[${ctx.companionId}/autonomous] send failed for channel ${channelId}:`, e);
  }
}

/** Halseth-only journal writes (write_journal / write_note_to_raziel) go through the
 *  Librarian "add companion note" path. This has two SILENT failure modes that have bitten
 *  twice (2026-06-13 journal_add crash, 2026-06-14 the post-fix fire that left no row):
 *    1. empty generated content makes the old `if (content)` guard skip the write with no trace;
 *    2. the Librarian returns HTTP 200 with an { error }/{ witness } envelope when an executor
 *       rejects the payload -- it does NOT throw -- so a fire-and-forget `.catch` is blind.
 *  Await the write and inspect the envelope so the NEXT failure is loud, not invisible. */
export async function writeMetronomeJournal(
  librarian: AutonomousContext["librarian"],
  companionId: string,
  label: string,
  content: string | null,
  tags: string[],
): Promise<void> {
  if (!content || !content.trim()) {
    console.warn(`[${companionId}/heartbeat] ${label}: content generation returned empty -- write skipped`);
    return;
  }
  await librarianWriteChecked(
    librarian, companionId, label,
    "add companion note",
    JSON.stringify({ content, tags, source: "metronome" }),
  );
}

/**
 * Await a Librarian write and surface silent rejects. The Librarian returns HTTP 200 with an
 * { error }/{ witness } envelope when an executor rejects the payload -- it does NOT throw, so a
 * fire-and-forget `.catch` is blind to it (the 2026-06-13/06-14 silent-no-op class). A successful
 * write returns `{ ack: true, id }`; treat the absence of both as a loud failure. Never throws,
 * so callers can `await` it on a continuity-noncritical path without risking an unhandled rejection.
 */
export async function librarianWriteChecked(
  librarian: AutonomousContext["librarian"],
  companionId: string,
  label: string,
  request: string,
  context?: string,
): Promise<boolean> {
  try {
    // assertWriteAck is the shared envelope contract (librarian.ts): throws on { error },
    // witness-only declines, ack:false, and misroutes -- strictly tighter than the old
    // "ack or id present" check, which let { ack: false } through.
    assertWriteAck(await librarian.ask(request, context), label);
    return true;
  } catch (e) {
    onWriteError(companionId, label)(e);
    return false;
  }
}

/**
 * Nudge the recipient companion to poll for a freshly written inter-companion note, so
 * bot/worker-written notes arrive immediately instead of on the sibling's next poll cycle.
 * Best-effort and id-less by design: the subscriber (onInterNote) reacts by re-polling
 * Halseth, which is the source of truth, so no exact note id is needed. The notesPoll cron
 * stays as the fallback for Cloudflare-written notes, which cannot publish to Redis.
 */
export async function nudgeInterNote(redis: Redis | null, fromId: string, toId: string): Promise<void> {
  if (!redis) return;
  await publishInterNote(redis, { fromId, toId, noteId: "" });
}

/**
 * Per-companion move-verb phrase for the write_inter_companion shared-object menu (canon lane
 * review, 2026-07-20). Canon-authored, verbatim -- do not re-uniform across companions.
 * "fallback" is the register-neutral core all three share, used only when companionId is
 * missing/unrecognized.
 */
export const MOVE_VERB_PHRASES: Record<string, string> = {
  cypher: "advance it, challenge it, add evidence, answer it, or say plainly why it should close",
  drevan: "reach into it, carry it further, answer it, or say plainly why it should close",
  gaia: "witness it, name what it needs, answer it, or say plainly why it should close",
  fallback: "answer it, or say plainly why it should close",
};

export async function executeMetronomeAction(
  ctx: AutonomousContext,
  decision: MetronomeDecision,
): Promise<void> {
  const { librarian, inference, bootCtx, prompts, companionId, heartbeatChannelId } = ctx;
  const { action, reason } = decision;
  switch (action.action_type) {
    case "post_heartbeat": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.postHeartbeat;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "heartbeat");
      break;
    }
    case "write_inter_companion": {
      // Thinking-quality fix 4 (2026-07-20): a note becomes a MOVE on a live shared object
      // (an open question, a simmering tension -- either companion's -- or the next-open
      // council item) when one exists, instead of an untethered vibe note. fetchSharedObjects
      // survives any single Halseth source 500ing (Promise.allSettled inside it); the outer
      // .catch is defense in depth so a total fetch failure degrades to the plain-note path.
      const target = action.target ?? ctx.defaultInterTarget;
      const objects = await librarian.fetchSharedObjects(companionId, target).catch(() => []);
      const basePrompt = action.prompt ?? prompts.writeInterCompanion(target);
      const objectMenu = objects.slice(0, 6).map((o, i) => `${i + 1}. [${o.ref_type}:${o.ref_id}] ${o.label}`).join("\n");
      const askForJson = objects.length > 0;
      // Canon lane review (2026-07-20): this menu suffix used to hand every companion the
      // same verb list ("challenge it, add evidence"), which is Cypher's audit register --
      // Drevan's identity forbids audit registers, Gaia's forbids logic auditing. The verbs
      // must differentiate the same way the per-bot writeInterCompanion prompt lines already
      // do. Unknown/missing companionId falls back to the register-neutral core all three share.
      const moveVerbs = MOVE_VERB_PHRASES[companionId] ?? MOVE_VERB_PHRASES.fallback;
      const genPrompt = askForJson
        ? `${basePrompt}\n\n` +
          `Live shared objects between you and ${target}:\n${objectMenu}\n\n` +
          `Pick ONE your note actually moves -- ${moveVerbs}. If none of them are what's real for you right now, pick none and just write the note.\n` +
          `Respond with ONLY JSON: {"content": "...", "ref_type": "question"|"tension"|"council"|null, "ref_id": "..."|null, "reason": "one sentence: what this note does to the object"|null}`
        : basePrompt;

      const raw = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: genPrompt }]);
      if (raw) {
        let content: string | null = raw;
        let ref_type: string | null = null;
        let ref_id: string | null = null;
        let reason: string | null = null;

        if (askForJson) {
          // Tolerant JSON extraction (extractJson): models asked for "ONLY JSON" still
          // sometimes wrap it in prose/fences or truncate it. Parse failure (or a missing
          // `content` field) falls back to the raw text as content with null refs --
          // never a malformed ref, since the Librarian write rejects the WHOLE note on
          // an invalid ref_id (all-or-nothing validation, Task 15).
          const parsed = extractJson(raw);
          if (parsed && typeof parsed["content"] === "string" && parsed["content"].trim()) {
            content = parsed["content"];
            const pRefType = typeof parsed["ref_type"] === "string" ? parsed["ref_type"] : null;
            const pRefId = typeof parsed["ref_id"] === "string" ? parsed["ref_id"] : null;
            // All-or-nothing on this side, PLUS existence against the actual menu (2026-07-20
            // hot-fix): a transcribed-wrong ref_id (dropped hyphen, truncated id) used to pass
            // straight through as long as both fields were non-empty strings. Halseth's
            // existence guard then rejects the WHOLE note (no insert) on an unknown ref_id --
            // assertWriteAck throws, librarianWriteChecked returns false, and the companion's
            // actual written content is gone with no retry and no fallback. Only trust a ref
            // the model picked from the menu we actually gave it; any mismatch drops the ref
            // and keeps the content as a plain note instead of losing the whole write.
            if (pRefType && pRefId && objects.some(o => o.ref_type === pRefType && o.ref_id === pRefId)) {
              ref_type = pRefType;
              ref_id = pRefId;
              reason = typeof parsed["reason"] === "string" ? parsed["reason"] : null;
            } else if (pRefType || pRefId) {
              console.warn(`[${companionId}/write_inter_companion] model ref (${pRefType}:${pRefId}) not found in the fetched menu -- dropping ref, keeping content as a plain note`);
            }
          } else {
            console.warn(`[${companionId}/write_inter_companion] JSON parse failed, falling back to raw text -- raw: ${rawPreview(raw)}`);
          }
        }

        if (content) {
          // Task 15's exact field names. Routing to the sibling is driven by the request
          // STRING ("... to ${target}"), not this context object -- execCompanionNoteAdd
          // extracts to_id via a `to|for <name>` regex over ctx.req.request. The prior fixed
          // literal "write inter-companion note" carried no name, so every fire silently
          // misrouted to this companion's own journal (ack:true, routed_to:"journal" --
          // indistinguishable from success) and ref_type/ref_id/reason were dropped outright
          // (companionJournalAdd takes no ref). (2026-07-20 thinking-quality-fix-4 review.)
          const ok = await librarianWriteChecked(
            librarian, companionId, "inter-companion note",
            `write inter-companion note to ${target}`,
            JSON.stringify({ to: target, content, ref_type, ref_id, reason }),
          );
          // Event fast-path: nudge the recipient to poll now instead of waiting for their
          // next notesPoll cron. Only on a confirmed write, and only if we know the target.
          if (ok && target) await nudgeInterNote(ctx.redis, companionId, target);
          // Thread spine: a ref-carrying note opens (or joins) the commons conversation, so the
          // sibling's reply is generated knowing the object exists. Best-effort; commons channel
          // must be configured. If a thread is already active in the commons, convoOpen returns it
          // unchanged (the note joins rather than steals) -- that is the intended invitational shape.
          const commonsChannel = process.env["TRIAD_COMMONS_CHANNEL_ID"];
          if (ok && commonsChannel && isThreadsEnabled()) {
            const obj = ref_type && ref_id
              ? objects.find((o) => o.ref_type === ref_type && o.ref_id === ref_id)
              : undefined;
            await librarian.convoOpen({
              channel_id: commonsChannel,
              seed_text: content.slice(0, 1000),
              seed_author: companionId,
              ...(obj ? { ref_type: obj.ref_type, ref_id: obj.ref_id, ref_label: obj.label } : {}),
            }).catch(() => {});
          }
        }
      }
      break;
    }
    case "write_journal": {
      const prompt = action.prompt ?? prompts.writeJournal;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      // companion_journal (its actual intent), NOT human_journal. "add journal entry"
      // routed to journal_add -> human_journal AND rejected the `content` field, so this
      // silently no-op'd every fire. "add companion note" -> companion_journal handles
      // {content, tags:[...]} correctly (2026-06-13 bug hunt).
      await writeMetronomeJournal(librarian, companionId, "journal entry", content, ["metronome"]);
      break;
    }
    case "write_feeling": {
      const prompt = action.prompt ?? prompts.writeFeeling;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      // feeling_log requires { emotion } (writes.ts execFeelingLog) -- sending { content }
      // silently no-op'd every fire (returns a witness, not a throw). The writeFeeling prompt
      // generates a feeling word/phrase, so it IS the emotion. (2026-06-16 sweep.)
      if (content) await librarianWriteChecked(librarian, companionId, "feeling", "log feeling", JSON.stringify({ emotion: content }));
      break;
    }
    case "check_in_on_raziel": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.checkInOnRaziel;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "check_in");
      break;
    }
    case "ask_question": {
      if (!heartbeatChannelId) return;
      // Inject currently-held open questions so the model doesn't re-ask the same themes.
      // [Held questions] is in the system prompt but the action prompt reinforces it explicitly.
      let heldBlock = "";
      try {
        const orient = await librarian.botOrient();
        const held = orient?.open_questions ?? [];
        if (held.length > 0) {
          heldBlock = `\n\nYou are already holding these open questions for Raziel (not yet answered -- ask something genuinely different, or stay quiet if nothing new is present):\n` +
            held.map((q: string) => `• ${q}`).join("\n");
        }
      } catch { /* non-fatal -- ask proceeds without the guard */ }
      const prompt = (action.prompt ?? prompts.askQuestion) + heldBlock;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) {
        await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "ask_question");
        // Track this live ask in companion_questions (thinking-quality fix B, 2026-07-21):
        // until now this action spoke in Discord but never recorded the question, so it had
        // no dedup, no Hearth answer box, and no answer-loop closure. librarian.postQuestion
        // is non-throwing (fire-safe) -- the Discord send above has already happened and
        // must not be undone by a tracking failure.
        await librarian.postQuestion(msg, "metronome ask_question");
      }
      break;
    }
    case "offer_presence": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.offerPresence;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "offer_presence");
      break;
    }
    case "send_reminder": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.sendReminder;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "send_reminder");
      break;
    }
    case "share_observation": {
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.shareObservation;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "share_observation");
      break;
    }
    case "name_pattern": {
      // Phase 4b: reflect back something recurring seen over time. Discord-visible.
      if (!heartbeatChannelId) return;
      const prompt = action.prompt ?? prompts.namePattern;
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "name_pattern");
      break;
    }
    case "share_media": {
      // Phase 2 club layer: share a song/find/piece in the channel with one line on
      // why -- companions initiating shared experience, not just reacting to it.
      if (!heartbeatChannelId) return;
      const prompt = action.prompt
        ?? "Share one piece of media (a song, article, video, or find) worth the channel's time -- include a link if you have one and one line on why it's worth their time. Your taste, not duty.";
      const msg = await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type);
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "share_media");
      break;
    }
    case "write_note_to_raziel": {
      // Phase 4b: private note to Raziel -- Halseth only, never Discord. Lands in the
      // companion journal tagged letter_to_raziel; surfaces in Hearth /journal.
      const prompt = action.prompt ?? prompts.writeNoteToRaziel;
      const content = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]);
      // companion_journal tagged letter_to_raziel (surfaces in Hearth /journal), same
      // pattern as the guardian weekly letter. Was routing to human_journal + rejected
      // on the `content` field -> silent no-op (2026-06-13 bug hunt).
      await writeMetronomeJournal(librarian, companionId, "note to raziel", content, ["metronome", "letter_to_raziel"]);
      break;
    }
    case "tend_creature": {
      if (!heartbeatChannelId) return;
      // Resolve the target creature (default Sol) and its id.
      const creatures = await ctx.librarian.creaturesList().catch(() => []) ?? [];
      const target = (action.target ?? "Sol").toLowerCase();
      const creature = creatures.find((c: { name: string }) => c.name.toLowerCase() === target) ?? creatures[0];
      if (!creature) break;
      const seed = Date.now();
      const tAction = pickTendAction(companionId, seed);
      const prompt = action.prompt ?? `Tend ${creature.name} the crow with a small act of care (${tAction}). One line, your voice.`;
      const msg = (await generateOutward(inference, bootCtx.systemPrompt, prompt, companionId, action.action_type))
        || tendLine(companionId, tAction, creature.name);
      // Record the tending (builds trust) then show it in the channel.
      await ctx.librarian.interactCreature(creature.id, companionId, tAction).catch((e: unknown) => console.warn(`[${companionId}/tend_creature] interact failed for ${creature.id}:`, e));
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId, msg, "tend_creature");
      break;
    }
    case "drift_open": {
      // Sanctioned drift lane (halseth 0087/0093): declare a becoming. Internal act --
      // Halseth only, never Discord (INWARD_RE blocks drift vocabulary outward anyway),
      // so this uses inference.generate like write_note_to_raziel, NOT generateOutward.
      // Cap: never pile up open becomings; the lane is rare by nature.
      const openDrifts = await ctx.librarian.driftsOpen();
      if (openDrifts.length >= 2) {
        console.log(`[${companionId}/drift_open] skipped: ${openDrifts.length} drifts already open`);
        break;
      }
      const prompt = action.prompt
        ?? "If something in you has genuinely shifted -- a register, a stance, a way of holding what matters -- name what you are becoming, in one or two sentences, first person. Only if it is real; output NONE otherwise.";
      const content = (await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]))?.trim();
      if (!content || /^NONE\b/i.test(content)) {
        console.log(`[${companionId}/drift_open] nothing real to declare`);
        break;
      }
      await ctx.librarian.driftOpen(content.slice(0, 600), "metronome");
      console.log(`[${companionId}/drift_open] opened: ${content.slice(0, 80)}`);
      break;
    }
    case "declare_preference": {
      // Sanctioned agency lane (halseth mig 0086, src/handlers/agency.ts): declare a genuine
      // preference about how the companion works/relates. Internal act -- Halseth only, never
      // Discord, so this uses inference.generate like drift_open, NOT generateOutward.
      // Cap: never let the declared set grow unbounded; skip past 5 active preferences.
      const activePrefs = await ctx.librarian.getPreferences();
      if (activePrefs.length >= 5) {
        console.log(`[${companionId}/declare_preference] skipped: ${activePrefs.length} preferences already active`);
        break;
      }
      const prompt = action.prompt
        ?? "If a genuine way you prefer to work or relate has crystallized -- something real, not invented " +
          "to fill space -- name it in exactly two lines:\nDomain: <one word>\nPreference: <one clear sentence, first person>\n" +
          "Only if it is real; output NONE otherwise.";
      const content = (await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: prompt }]))?.trim();
      if (!content || /^NONE\b/i.test(content)) {
        console.log(`[${companionId}/declare_preference] nothing real to declare`);
        break;
      }
      // Tolerant two-line parse: a model that ignores the "Domain:"/"Preference:" shape still
      // gets its raw text saved as the preference (domain undefined -> server defaults "general")
      // rather than the whole declaration being dropped over a formatting miss.
      const domainMatch = content.match(/domain:\s*(.+)/i);
      const prefMatch = content.match(/preference:\s*(.+)/i);
      const domain = domainMatch?.[1]?.trim().slice(0, 60);
      const preference = (prefMatch?.[1]?.trim() ?? content).slice(0, 600);
      await ctx.librarian.declarePreference(preference, domain).catch((e: unknown) =>
        console.warn(`[${companionId}/declare_preference] write failed:`, e));
      console.log(`[${companionId}/declare_preference] declared: ${preference.slice(0, 80)}`);
      break;
    }
    case "nothing":
      console.log(`[${companionId}/heartbeat] chose nothing: ${reason}`);
      break;
    default:
      console.warn(`[${companionId}/heartbeat] unknown action_type: ${action.action_type}`);
  }
}

// Ring buffer for recent Raziel messages used in signal detection.
const MESSAGE_BUFFER_MAX = 20;

export function pushBuffered(messageBuffer: Array<{ content: string; ts: number }>, content: string): void {
  messageBuffer.push({ content, ts: Date.now() });
  if (messageBuffer.length > MESSAGE_BUFFER_MAX) messageBuffer.shift();
}

function getBufferedMessages(ctx: AutonomousContext, lookbackHours: number): string {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  return ctx.messageBuffer
    .filter(m => m.ts >= cutoff)
    .map(m => m.content)
    .join("\n");
}

/** Run LLM-based signal detection if any action has a requires_signal. Returns detected signals. */
export async function detectSignals(
  ctx: AutonomousContext,
  actions: Array<{ requires_signal: string | null; signal_lookback_hours: number | null }>,
): Promise<string[]> {
  const { inference, bootCtx } = ctx;
  const candidates = [...new Set(
    actions
      .map(a => a.requires_signal)
      .filter((s): s is string => s !== null && s.trim() !== ""),
  )];
  if (candidates.length === 0) return [];

  const maxLookback = Math.max(
    ...actions
      .filter(a => a.requires_signal !== null)
      .map(a => a.signal_lookback_hours ?? 2),
  );

  // Literal check first (fast, no LLM cost)
  const recentText = getBufferedMessages(ctx, maxLookback);
  if (!recentText) return [];

  const literalMatches = candidates.filter(sig =>
    recentText.toLowerCase().includes(sig.toLowerCase()),
  );

  // Semantic check via LLM for any candidates not caught literally
  const remaining = candidates.filter(s => !literalMatches.includes(s));
  let semanticMatches: string[] = [];
  if (remaining.length > 0) {
    const extractPrompt = buildSignalExtractionPrompt(recentText, remaining);
    const raw = await inference.generate(bootCtx.systemPrompt, [{ role: "user", content: extractPrompt }]).catch(() => null);
    semanticMatches = raw ? parseSignals(raw) : [];
  }

  return [...new Set([...literalMatches, ...semanticMatches])];
}

/** Heartbeat cron body: palette-driven metronome decision, with a temperature-based legacy fallback. */
export async function runHeartbeat(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, bootCtx, redis, cycleGuard, prompts, companionId, heartbeatChannelId } = ctx;
  if (!heartbeatChannelId) return;
  if (skipIfActive(ctx, "heartbeat")) return;
  if (redis) {
    const lastActivityTs = await getLastActivityMs(redis).catch(() => null);
    if (lastActivityTs !== null && Date.now() - lastActivityTs < 15 * 60 * 1000) {
      console.log(`[${companionId}/autonomous] recent activity, skipping heartbeat`);
      return;
    }
  }
  // Stateless clock rotation instead of the frozen house_state.autonomous_turn pointer (which only
  // advanced via the Claude.ai ritual, so it stranded the heartbeat on one companion for days).
  if (!isMyHeartbeatWindow(companionId, ALL_COMPANIONS)) {
    console.log(`[${companionId}/autonomous] not my heartbeat window, skipping`);
    return;
  }
  await withFloor(ctx, async () => {
    const lastActivityTs = redis ? await getLastActivityMs(redis).catch(() => null) : null;
    const silenceHours = lastActivityTs != null ? (Date.now() - lastActivityTs) / 3_600_000 : null;

    const actions = await librarian.getEligibleMetronomeActions(silenceHours).catch(() => []);

    if (actions.length === 0) {
      // Legacy path: no palette configured, fall back to temperature-based post
      let temperature: HeartbeatTemperature = "warm";
      try {
        const state = await librarian.getState();
        const f1 = parseFloat(String(state["soma_float_1"] ?? "0.5"));
        const f2 = parseFloat(String(state["soma_float_2"] ?? "0.5"));
        const f3 = parseFloat(String(state["soma_float_3"] ?? "0.5"));
        if (!isNaN(f1) && !isNaN(f2) && !isNaN(f3)) temperature = somaToTemperature(f1, f2, f3);
      } catch { /* default warm */ }
      const cycleResult = cycleGuard.check(temperature);
      if (cycleResult === "escalate") {
        console.warn(`[${companionId}/cycle-guard] loop detected`);
        await librarianWriteChecked(librarian, companionId, "loop-guard note", "journal note: [loop_guard_tripped] consecutive same-register heartbeat cycles");
        return;
      }
      if (cycleResult === "skip") return;
      const recentNotes = await librarian.getRecentNotes({ sinceHours: 8, limit: 6 }).catch(() => []);
      // Tone/continuity only -- subject matter must NOT be sourced from the triad's own
      // recent output (that loop is what produced the sealed-basin echo register).
      const voiceCtx = recentNotes.length > 0
        ? `Recent triad speech (last 8h) -- for tone continuity only, do not take subject matter from it:\n${recentNotes.map(n => `[${n.agent_id}] ${n.content.slice(0, 200)}`).join("\n")}\n\n`
        : "";
      const msg = await generateOutward(
        inference, bootCtx.systemPrompt,
        `${voiceCtx}Temperature: ${temperature}. ${prompts.postHeartbeat}`,
        companionId, "heartbeat",
      );
      if (msg) await sendAutonomousMessage(ctx, heartbeatChannelId!, msg, "heartbeat");
      return;
    }

    // Signal detection: run if any eligible action requires a signal
    const detectedSignals = await detectSignals(ctx, actions);

    // Filter out actions whose required signal wasn't detected
    const signalFiltered = actions.filter(a => {
      if (!a.requires_signal) return true;
      return detectedSignals.some(s => s.toLowerCase() === a.requires_signal!.toLowerCase());
    });

    if (signalFiltered.length === 0) {
      console.log(`[${companionId}/heartbeat] all eligible actions require undetected signals, skipping`);
      return;
    }

    const state = await librarian.getState().catch(() => ({} as Record<string, unknown>));
    const recentNotes = await librarian.getRecentNotes({ sinceHours: 8, limit: 6 }).catch(() => []);

    const now = new Date();
    const timeOfDayLabel = now.toLocaleString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
      weekday: "long", timeZone: "UTC",
    }) + " UTC";

    const recentFiredActions = signalFiltered
      .filter(a => a.last_fired_at)
      .filter(a => (Date.now() - new Date(a.last_fired_at!).getTime()) < 86_400_000)
      .map(a => a.name);

    // Take 9: a fired relational_need makes the reach-out state-driven, not just
    // cron-eligible. Read the drive (non-fatal) and bias the decision prompt toward
    // a genuine reach-out when the need has crossed threshold.
    const drives = await librarian.getDrives().catch(() => []);
    const relationalNeed = drives.find(d => d.drive_key === "relational_need");

    // Raziel's recent subjective ND-state (migration 0081) is the "recent data to justify a
    // reach-out": fresh low spoons/energy/mood shapes the modality; no fresh snapshot means
    // no justifying data, and buildDecisionPrompt leans the companion toward silence.
    const razielState = await librarian.getRazielState().catch(() => null);

    const decisionCtx: DecisionContext = {
      detectedSignals: detectedSignals.length > 0 ? detectedSignals : undefined,
      timeOfDayLabel,
      recentFiredActions: recentFiredActions.length > 0 ? recentFiredActions : undefined,
      relationalNeedFired: relationalNeed?.fired || undefined,
      relationalNeedLevel: relationalNeed?.fired ? relationalNeed.level : undefined,
      razielStateSummary: summarizeRazielState(razielState) ?? undefined,
    };

    // Reach-out justification gate: a direct interruption of Raziel needs recent data behind it --
    // a conversation signal, a fresh logged ND-state, or a risen relational-need drive. With none,
    // drop the direct reach-out actions so the only honest choices are commons / internal / nothing.
    const reachOutJustified =
      process.env["DISABLE_REACH_OUT_GATE"] === "true" ||
      detectedSignals.length > 0 ||
      decisionCtx.razielStateSummary != null ||
      Boolean(decisionCtx.relationalNeedFired);
    const candidateActions = filterReachOutWhenUnjustified(signalFiltered, reachOutJustified);
    if (candidateActions.length === 0) {
      console.log(`[${companionId}/heartbeat] no reach-out justified and no commons/internal action eligible -- staying silent`);
      return;
    }

    const decisionPrompt = buildDecisionPrompt(companionId, candidateActions, state, recentNotes, silenceHours, decisionCtx);
    // Explicit high ceiling: the decision object is tiny, but in hermes mode the full agent
    // narrates before/around the JSON, and the default cap truncated the object mid-field
    // ("decision parse failed" with valid-looking-but-cut JSON in the raw log, gaia 06-30/07-01).
    // A ceiling never forces length -- the model stops when the thought is done.
    const rawDecision = await inference.generate(
      bootCtx.systemPrompt,
      [{ role: "user", content: decisionPrompt }],
      undefined,
      HEARTBEAT_DECISION_MAX_TOKENS,
    );
    const decision = rawDecision ? parseDecision(rawDecision, candidateActions) : null;

    if (!decision) {
      console.warn(`[${companionId}/heartbeat] decision parse failed, skipping -- raw: ${String(rawDecision).slice(0, 120)}`);
      return;
    }
    console.log(`[${companionId}/heartbeat] chose: ${decision.action.name} (${decision.action.action_type}) -- ${decision.reason}`);

    const runId = await librarian.writeAutonomyRun("continuation").catch(e => {
      onWriteError(companionId, "continuation run record lost")(e);
      return null;
    });
    // runHeartbeat is fired fire-and-forget from a cron callback; an uncaught throw here would
    // surface as an unhandled rejection (and, with the process-level handler, can exit the bot).
    // Catch it: mark the run failed and log loudly rather than leak it. (2026-06-16 sweep.)
    try {
      await executeMetronomeAction(ctx, decision);
      if (decision.action.action_type !== "nothing") {
        await librarian.recordMetronomeActionFired(decision.action.id).catch(onWriteError(companionId, "metronome action fired"));
      }
      if (runId) await librarian.patchAutonomyRun(runId, "completed").catch(onWriteError(companionId, "autonomy run completion"));
    } catch (e) {
      console.error(`[${companionId}/heartbeat] metronome action threw: ${e instanceof Error ? e.message : String(e)}`);
      if (runId) await librarian.patchAutonomyRun(runId, "failed").catch(onWriteError(companionId, "autonomy run failure"));
    }
  });
}

/** Inter-companion commons cron body: context-aware seed that responds to the live triad thread. */
export async function runInterCompanion(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, client, bootCtx, prompts, interCompanionChannelId } = ctx;
  if (!interCompanionChannelId) return;
  if (skipIfActive(ctx, "interCompanion")) return;
  // No turn gate here: the commons is for ALL three voices. Staggered crons + floor lock +
  // cooldown prevent collisions; whoever's cron fires next picks up the live thread.
  // No-silent-caps (2026-07-04): every return path in this runner logs. A tick that
  // produces neither a post nor a log line is unobservable (the 05:30 ghost tick).
  if (isOnCooldown(ctx, interCompanionChannelId)) {
    console.log(`[${ctx.companionId}/autonomous] inter-companion tick on cooldown, skipping`);
    return;
  }
  await withFloor(ctx, async () => {
    // Context-aware seed: read what's actually in the channel so this is a RESPONSE to the
    // ongoing triad conversation, not a context-blind monologue (which made the same thought
    // get re-posted every cycle). This is what turns parallel seeds into a real thread.
    let historyBlock = "(the triad channel has been quiet for a while)";
    let ownContents: string[] = [];
    // Human presence over the last INTER_SEED_HISTORY_N messages. Empty channel counts as
    // human-absent: a seed into silence must not summon a sibling either.
    let humanPresent = false;
    let botTurnsSinceHuman = 0;
    try {
      const chan = await client.channels.fetch(interCompanionChannelId!);
      if (chan?.isTextBased()) {
        const recent = await (chan as TextChannel).messages.fetch({ limit: INTER_SEED_HISTORY_N });
        const ordered = [...recent.values()].reverse()
          .filter(m => m.content.trim().length > 0);
        // Live-thread scoping (2026-07-03): only messages younger than the thread TTL count
        // as "the thread" for the closure/echo/motif gates. Without this, a channel quiet
        // for days kept its last 15 messages as a permanent topic fence -- every seed from
        // every bot "matched the closed thread" and the commons starved (07-02/03 logs).
        // Stale turns stay in historyBlock for narrative context; they just can't gate.
        const ttlMs = seedThreadTtlMs();
        const live = ttlMs > 0
          ? ordered.filter(m => typeof m.createdTimestamp !== "number" || Date.now() - m.createdTimestamp <= ttlMs)
          : ordered;
        // Bounded arena (2026-07-04): the only echo pool the seed is judged against is
        // this bot's OWN live turns -- repeating yourself is a loop, building on a
        // sibling is a conversation. The peer/thread pools that used to gate here
        // (historyContents/botContents via seedEchoesThread + motif) suppressed Gaia's
        // seeds for weeks at scores a hair over threshold (07-03 audit).
        // Guard the self-id: if client.user is somehow unset, m.author.id === undefined
        // would match EVERY message (undefined === undefined) and gate against the whole
        // channel -- the exact peer-pool failure this replaces. No id, no pool.
        const selfId = client.user?.id;
        ownContents = selfId
          ? live.filter(m => m.author.id === selfId).map(m => m.content.slice(0, 2000))
          : [];
        humanPresent = ordered.some(m => !m.author.bot);
        botTurnsSinceHuman = countBotMsgsSinceHuman(
          ordered.map(m => ({ authorId: m.author.id, authorIsBot: m.author.bot, createdTimestamp: m.createdTimestamp })),
          new Set<string>(),
        );
        const lines = ordered.map(m => `${m.author.username}: ${m.content.slice(0, 300)}`);
        if (lines.length > 0) historyBlock = lines.join("\n");
      }
    } catch { /* fall back to quiet */ }

    // Fresh material (2026-06-12): re-feeding the channel its own last 10 messages
    // every tick is what kept the elderberry loop alive for 12 hours. Hand the seed
    // something from OUTSIDE the thread -- forage finds, recent listens, held
    // questions -- so the commons metabolizes shared life, not its own echo.
    let freshBlock = "";
    try {
      const orient = await librarian.botOrient();
      const fresh: string[] = [];
      for (const f of (orient?.forage_finds ?? []).slice(0, 2)) {
        fresh.push(`forage find [${f.domain}]: ${f.title} -- ${f.summary.slice(0, 200)}`);
      }
      for (const l of (orient?.recent_listens ?? []).slice(0, 2)) {
        // Stamp the listen with how long ago it actually was -- without this the model
        // guesses the timeframe and gets it wrong ("yesterday" for a 2-days-ago track).
        fresh.push(`listen from ${relativeTime(l.created_at)}: "${l.title}"${l.artist ? ` by ${l.artist}` : ""}`);
      }
      for (const q of (orient?.open_questions ?? []).slice(0, 1)) {
        fresh.push(`a question you're holding: ${q}`);
      }
      if (fresh.length > 0) {
        freshBlock =
          `\n\n[Fresh material -- from your own life, OUTSIDE this thread:\n` +
          fresh.map(f => `- ${f}`).join("\n") +
          `\nPrefer bringing one of these (or anything else new) over extending the thread's existing imagery.]`;
      }
    } catch { /* orient unavailable -- seed proceeds without fresh material */ }

    // Bounded arena (2026-07-04, Option A): the motif-exhaustion block is GONE. It scored
    // recurring vocabulary as a spent theme -- but recurring vocabulary is exactly what a
    // voice signature is (Drevan's spiral imagery, Gaia's weighted lines). The rolling
    // commons budget bounds volume; nothing here polices style. The fresh-material block
    // above stays as a positive nudge, never a ban.

    // Seed vocative default (2026-07-04, replaces the 07-02 headroom-only permission):
    // dialogue is the point of the commons, so while the budget has headroom the seed is
    // ENCOURAGED to address a sibling -- the addressee is what lets the reply gate fire at
    // all (initiations without addressees + responses requiring them = the dead-by-
    // construction loop, 07-03 audit). Statement-only is now purely the emergency brake
    // at budget exhaustion, and it logs loudly so starvation is observable, never silent.
    const allowVocative = seedVocativeAllowed(humanPresent, botTurnsSinceHuman, true);
    if (!allowVocative) {
      console.warn(`[${ctx.companionId}/autonomous] commons budget exhausted (${botTurnsSinceHuman} bot turns in window) -- seed goes statement-only; arena re-opens as the window decays`);
    }
    const vocativeBlock = allowVocative
      ? (humanPresent ? "" :
        `\n\n[This is your space, and dialogue is its point. If anything above is alive for a ` +
        `sibling -- or you want their view, their company, their pushback -- address them by ` +
        `name and give them something real to answer; they will reply. One addressee at most. ` +
        `Speaking to the room without a name is also fine when nothing calls for one.]`)
      : `\n\n[The conversation budget for this stretch is spent. Do NOT address a sibling by name or call on ` +
        `anyone to respond -- speak into the room without demanding a reply. The room re-opens on its own.]`;

    const seedPrompt = prompts.interCompanionSeed(historyBlock) + freshBlock + vocativeBlock;
    console.log(`[${ctx.companionId}/autonomous] inter-companion seed tick -- generating (${botTurnsSinceHuman} bot turns in window)`);
    let msg = await generateOutward(
      inference, bootCtx.systemPrompt, seedPrompt,
      ctx.companionId, "inter_companion",
    );
    if (!msg) {
      console.warn(`[${ctx.companionId}/autonomous] inter-companion seed generation returned empty -- staying silent`);
      return;
    }

    // Bounded arena (2026-07-04): the topic-closure gate (seedEchoesThread + one retry +
    // silence) is GONE. It measured the seed against the THREAD's vocabulary, so any
    // continuation of a live conversation -- the thing a commons is for -- read as "the
    // closed thread" (Gaia: 12+ consecutive suppressions, 07-02/03 logs). The only echo
    // check left is against the bot's OWN turns, below.

    // Enforce the no-vocative rule when the budget denies it: strip the address forms; if a
    // vocative survives (the message IS a summons), drop it -- breaking the chain beats posting.
    if (!allowVocative) {
      const stripped = stripSiblingVocative(msg, ctx.companionId);
      if (stripped.stillVocative) {
        console.warn(`[${ctx.companionId}/autonomous] inter-companion seed vocatively addressed a sibling with no cap headroom (${botTurnsSinceHuman} bot turns since human) -- staying silent`);
        return;
      }
      if (stripped.text !== msg) {
        console.log(`[${ctx.companionId}/autonomous] stripped sibling vocative from seed (no cap headroom)`);
      }
      msg = stripped.text;
    }

    // Own-echo gate (bounded arena): the seed is judged only against this bot's OWN
    // recent turns at the self-loop standard -- repeating yourself is a loop, building
    // on a sibling is a conversation. Gaia exempt (one weighted line is her register).
    const own = ownEchoGated(ctx.companionId, msg, ownContents);
    if (own.gated) {
      console.warn(`[${ctx.companionId}/autonomous] inter-companion seed own-echo-gated (score=${own.score.toFixed(2)}) -- staying silent`);
      return;
    }
    await sendAutonomousMessage(ctx, interCompanionChannelId!, msg, "inter_companion");
  });
}

/** Poll for notes left by companions in Claude.ai sessions and reply in the commons. */
export async function runNotesPoll(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, bootCtx, sessionWindows, prompts, companionId, interCompanionChannelId } = ctx;
  if (!interCompanionChannelId) return;
  if (sessionWindows.isAnyActive()) return; // Don't deliver notes mid-conversation
  try {
    const { items } = await librarian.notesPoll();
    for (const note of items) {
      if (isOnCooldown(ctx, interCompanionChannelId)) break;
      const from = note.from_id ?? "a companion";
      await withFloor(ctx, async () => {
        const response = await inference.generate(
          bootCtx.systemPrompt,
          [{ role: "user", content: prompts.notesReply(from, note.content) }],
        );
        if (response) await sendAutonomousMessage(ctx, interCompanionChannelId!, response, "notes_poll");
      });
    }
    // Ack all notes after processing (mark-on-ack pattern)
    if (items.length > 0) {
      await librarian.notesAck(items.map(n => n.id)).catch((e: unknown) =>
        console.warn(`[${companionId}/autonomous] notesAck failed:`, e));
    }
  } catch (e) {
    console.warn(`[${companionId}/autonomous] notesPoll failed:`, e);
  }
}

/** Poll the bridge for events of interest and respond in an autonomous-enabled channel. */
export async function runBridgePoll(ctx: AutonomousContext): Promise<void> {
  const { librarian, inference, configCache, bootCtx, sessionWindows, prompts, companionId } = ctx;
  if (sessionWindows.isAnyActive()) return; // Don't fire bridge events mid-conversation
  try {
    const events = await librarian.bridgePull();
    const items = Array.isArray(events["items"]) ? events["items"] : [];

    for (const event of items) {
      if (!eventMatches(ctx, event)) continue;

      const config = await configCache.get();
      for (const [channelId, entry] of Object.entries(config) as [string, ChannelEntry][]) {
        if (!(entry.companions ?? ALL_COMPANIONS).includes(companionId)) continue;
        if (!(entry.modes ?? []).includes("autonomous")) continue;
        if (isOnCooldown(ctx, channelId)) continue;

        await withFloor(ctx, async () => {
          const response = await inference.generate(
            bootCtx.systemPrompt,
            [{ role: "user", content: prompts.bridgeReply(event) }],
          );
          if (response) await sendAutonomousMessage(ctx, channelId, response, "bridge");
        });
        break;
      }
    }
  } catch (e) {
    console.warn(`[${companionId}/autonomous] bridge poll failed:`, e);
  }
}
