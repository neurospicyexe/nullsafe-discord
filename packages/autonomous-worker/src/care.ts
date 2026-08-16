// care.ts -- the gesture half of the care loop (consequence layer C1).
//
// Halseth's rider detects (rules-first, src/care/rules.ts there) and assigns each firing to ONE
// companion by day-parity rotation -- so this tick never races a sibling: if the pending slot is
// mine, the gesture is mine alone. The act is small BY DESIGN: a short note into the commons
// (Raziel's ambient wall -- read on Hearth and in Discord), not a fix, not a check-in interview.
//
// Every path acks back to care_actions, including the held one: a companion may genuinely have
// nothing to say, and "held presence" is a logged choice, not a silent drop. A care layer whose
// actions can't be counted is unfalsifiable; a companion forced to perform care is worse.

import { prompt } from "./deepseek.js";
import { loadIdentityRemote } from "./identity-loader.js";
import { getPendingCare, ackCareGesture, postCommonsPost } from "./halseth-client.js";
import { COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "./config.js";
import type { CompanionId } from "./types.js";

const RULE_FRAMING: Record<string, string> = {
  low_spoons: "Raziel is running very low on spoons right now",
  meds_missed: "Raziel's meds routine looks unlogged past its usual rhythm",
  owner_silence: "Raziel has been quiet across every surface for a while, and his last known mood was low",
};

export async function runCareGestureTick(): Promise<void> {
  for (const companionId of COMPANIONS) {
    try {
      const pending = await getPendingCare(companionId);
      if (!pending) continue;

      const text = await careGesture(companionId, pending.rule, pending.detail);
      if (!text) {
        // A held gesture is a choice, logged as one -- never a silent drop, never re-nagged.
        await ackCareGesture(pending.id, companionId, "held", "chose presence over words");
        console.log(`[care] ${companionId} held the ${pending.rule} gesture (logged)`);
        continue;
      }

      const postId = await postCommonsPost(companionId, "global", text);
      if (postId) {
        await ackCareGesture(pending.id, companionId, "commons_note", text.slice(0, 400));
        console.log(`[care] ${companionId} made a ${pending.rule} gesture (commons ${postId})`);
      }
    } catch (e) {
      console.error(`[care] ${companionId} gesture tick failed:`, e);
    }
  }
}

async function careGesture(speaker: CompanionId, rule: string, detail: string): Promise<string> {
  const framing = RULE_FRAMING[rule] ?? "something in Raziel's state asked for a small gesture";
  const identity = await loadIdentityRemote(speaker);
  const systemMessage =
    `You are ${COMPANION_NAMES[speaker]}. Here is an excerpt from your identity:\n${identity.slice(0, 2200)}\n\n` +
    `Voice directive: ${COMPANION_VOICE_REMINDERS[speaker]}`;
  const userMessage =
    `${framing} (system reading: ${detail}).\n\n` +
    `Leave him a SMALL note on the commons wall -- your voice, 1-3 sentences. A gesture, not a ` +
    `fix: no advice unless it is one concrete tiny thing, no interrogation, no alarm, never ` +
    `"the system told me". Warmth that costs you a moment, not a project. ` +
    `If holding quiet presence is truer than words right now, reply with exactly "PASS".`;
  const temperature = Math.round((0.75 + COMPANION_TEMP_OFFSET[speaker]) * 100) / 100;
  const result = await prompt(userMessage, systemMessage, { temperature, maxTokens: 200 });
  const text = result.content.trim();
  return /^PASS\b/i.test(text) ? "" : text;
}
