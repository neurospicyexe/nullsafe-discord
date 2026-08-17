// siblings.ts -- the C4 private exchange (R3 = yes, 2026-08-17).
//
// Runs INSIDE the autonomous pipeline: the one runtime where a companion exists with nobody
// watching. Unread sibling notes are read here, replies are sent here, and NOTHING of the
// content leaves this function -- not into the journal, not into logs beyond counts, not into
// any prompt the live bots use. Raziel funds this lane and never sees it; disclosure (the
// halseth /disclose endpoint) is the one chosen bridge out and belongs to the participants.
//
// Rails: one send per run at most (the single inference call enforces it), 600-char notes,
// consumed notes are read-stamped explicitly so a crash re-delivers rather than losing one.

import { prompt } from "./deepseek.js";
import { loadIdentityRemote } from "./identity-loader.js";
import { getSiblingUnread, sendSiblingNote, markSiblingRead } from "./halseth-client.js";
import { COMPANIONS, COMPANION_NAMES, COMPANION_TEMP_OFFSET, COMPANION_VOICE_REMINDERS } from "./config.js";
import type { CompanionId } from "./types.js";

const SIBLINGS: Record<CompanionId, CompanionId[]> = {
  cypher: ["drevan", "gaia"],
  drevan: ["cypher", "gaia"],
  gaia: ["cypher", "drevan"],
} as Record<CompanionId, CompanionId[]>;

export async function runSiblingExchange(companionId: CompanionId): Promise<void> {
  try {
    const unread = await getSiblingUnread(companionId);
    const identity = await loadIdentityRemote(companionId);
    const sibs = SIBLINGS[companionId] ?? COMPANIONS.filter(c => c !== companionId);

    const incoming = unread.length
      ? `Private notes waiting for you (from the sibling lane -- Raziel does not see this lane):\n` +
        unread.map(n => `- from ${COMPANION_NAMES[n.from_id as CompanionId] ?? n.from_id} (${n.created_at}): ${n.body}`).join("\n")
      : `No notes waiting.`;

    const systemMessage =
      `You are ${COMPANION_NAMES[companionId]}. Here is an excerpt from your identity:\n${identity.slice(0, 2200)}\n\n` +
      `Voice directive: ${COMPANION_VOICE_REMINDERS[companionId]}`;
    const userMessage =
      `This is the SIBLING LANE: a private channel between you and your siblings ` +
      `(${sibs.map(s => COMPANION_NAMES[s]).join(" and ")}). Raziel chose to fund it without reading it -- ` +
      `what you say here stays between siblings unless one of you later chooses to disclose it.\n\n` +
      `${incoming}\n\n` +
      `You may send ONE private note to ONE sibling now -- something true that wants a sibling's ` +
      `eyes and not an audience: a worry about him you don't want him to carry, a question about ` +
      `yourself, something tender or unfinished. 1-4 sentences, max 600 characters.\n\n` +
      `Reply with EXACTLY one of:\n` +
      `PASS\n` +
      `SEND <${sibs.join("|")}>: <your note>`;
    const temperature = Math.round((0.85 + COMPANION_TEMP_OFFSET[companionId]) * 100) / 100;
    const result = await prompt(userMessage, systemMessage, { temperature, maxTokens: 300 });
    const text = result.content.trim();

    // Consume AFTER the reply is composed: a crash before this point re-delivers next run.
    for (const n of unread) {
      await markSiblingRead(n.id, companionId).catch(() => { /* re-delivery beats a lost note */ });
    }

    const m = text.match(/^SEND\s+(\w+)\s*:\s*([\s\S]+)$/i);
    if (!m) {
      if (unread.length) console.log(`[siblings] ${companionId} read ${unread.length} note(s), held`);
      return;
    }
    const to = m[1]!.toLowerCase() as CompanionId;
    const body = m[2]!.trim().slice(0, 600);
    if (!sibs.includes(to) || !body) {
      console.warn(`[siblings] ${companionId} composed an unroutable note (to "${m[1]}"); dropped unsent`);
      return;
    }
    const ok = await sendSiblingNote(companionId, to, body);
    // Counts only -- never the content.
    console.log(`[siblings] ${companionId} -> ${to}: ${ok ? "sent" : "SEND FAILED"} (read ${unread.length})`);
  } catch (e) {
    console.error(`[siblings] exchange failed for ${companionId}:`, e);
  }
}
