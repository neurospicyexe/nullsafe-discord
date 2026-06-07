// Discord enforces a hard 2000-character limit on a single message's `content`
// field. A send with longer content fails with DiscordAPIError[50035] "Invalid
// Form Body" -- the message is silently dropped and the companion appears to go
// mute (this is what made Drevan stop responding mid-conversation: his immersive
// prose regularly exceeds 2000 chars). The fix is to split long content into
// <=2000-char chunks and send them sequentially, never to quiet the companion.
//
// Used by both the live message handler (bot-message-handler.ts) and the
// autonomous/triad send path (bots/*/src/autonomous.ts).

import type { Message, MessageCreateOptions, TextChannel } from "discord.js";

export const DISCORD_MAX_MESSAGE = 2000;

/**
 * Split `content` into chunks each <= `max` characters.
 *
 * Breaks on the coarsest boundary that keeps chunks under the limit: paragraphs
 * (\n\n) first, then lines (\n), then sentences (". "), then spaces, and only
 * hard-cuts mid-token when a single run still exceeds `max`. Never returns empty
 * chunks; returns [] for empty/whitespace-only input.
 */
export function splitForDiscord(content: string, max = DISCORD_MAX_MESSAGE): string[] {
  if (max <= 0) throw new Error("splitForDiscord: max must be positive");
  const text = content ?? "";
  if (text.trim().length === 0) return [];
  if (text.length <= max) return [text];
  return packGreedy(text, max, ["\n\n", "\n", ". ", " ", ""]).filter(c => c.trim().length > 0);
}

function hardChars(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

// Greedily pack `text` into <=max chunks, splitting on `separators[0]` and
// recursing into finer separators for any single part that overflows on its own.
function packGreedy(text: string, max: number, separators: string[]): string[] {
  if (text.length <= max) return [text];
  const sep = separators[0] ?? "";
  const rest = separators.slice(1);
  const parts = sep === "" ? hardChars(text, max) : text.split(sep);
  const joiner = sep;

  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current === "" ? part : current + joiner + part;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current !== "") { chunks.push(current); current = ""; }
    if (part.length <= max) {
      current = part;
    } else {
      // Single part still too big -- recurse into the next-finer separator.
      const sub = packGreedy(part, max, rest.length ? rest : [""]);
      for (let i = 0; i < sub.length - 1; i++) chunks.push(sub[i]);
      current = sub[sub.length - 1] ?? "";
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

export type SendLongPayload =
  | string
  | { content?: string; files?: MessageCreateOptions["files"] };

/**
 * Send `payload` to `channel`, splitting content longer than Discord's 2000-char
 * limit into multiple sequential messages. Any attached files ride on the LAST
 * chunk so they appear after the full text.
 *
 * Returns ALL Messages sent, in order. Callers that track sent message ids (e.g.
 * the reply-to-me detector) must register every id, not just the last -- a user
 * may reply to any chunk of a multi-part message.
 */
export async function sendLong(
  channel: TextChannel,
  payload: SendLongPayload,
): Promise<Message[]> {
  const content = typeof payload === "string" ? payload : (payload.content ?? "");
  const files = typeof payload === "string" ? undefined : payload.files;
  const chunks = splitForDiscord(content);

  // Files but no text: send the attachment on its own.
  if (chunks.length === 0) {
    return [files ? await channel.send({ files }) : await channel.send(content)];
  }

  const sent: Message[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    sent.push(
      isLast && files
        ? await channel.send({ content: chunks[i], files })
        : await channel.send(chunks[i]),
    );
  }
  return sent;
}
