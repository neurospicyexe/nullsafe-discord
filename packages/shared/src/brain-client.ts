/**
 * BrainClient -- HTTP relay client for Phoenix Brain (/chat endpoint).
 *
 * When INFERENCE_MODE=brain, bots send ThoughtPackets here instead of calling
 * DeepSeek directly. Brain handles inference and returns AgentReply.
 *
 * The bot assembles system_prompt + message history and passes them in metadata
 * so Brain uses the exact same context the bot would have used. Brain = inference
 * layer only in relay mode; all Halseth I/O (STM, session, etc.) stays bot-side
 * unless Brain's HALSETH_URL is also set.
 */

import type { CompanionId, ChatMessage } from "./types.js";
import { randomUUID } from "crypto";

export interface ThoughtPacketMetadata {
  channel_id: string;
  system_prompt?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
  is_raziel?: boolean;
  front_member?: string | null;
  guild_id?: string;
}

export interface ThoughtPacket {
  packet_id: string;
  timestamp: string;
  source: "discord";
  user_id: string;
  thread_id: string;
  agent_id: CompanionId;
  message: string;
  metadata: ThoughtPacketMetadata;
}

export interface AgentReply {
  packet_id: string;
  agent_id: string;
  status: "ok" | "queued" | "error" | "brain_offline";
  reply_text: string;
  trace?: Record<string, unknown>;
}

export function buildThoughtPacket(
  agentId: CompanionId,
  userId: string,
  channelId: string,
  message: string,
  systemPrompt: string,
  history: ChatMessage[],
  temperature: number,
  opts?: {
    isRaziel?: boolean;
    frontMember?: string | null;
    guildId?: string;
  },
): ThoughtPacket {
  return {
    packet_id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: "discord",
    user_id: userId,
    thread_id: channelId,
    agent_id: agentId,
    message,
    metadata: {
      channel_id: channelId,
      system_prompt: systemPrompt,
      // History without the current message (Brain appends it internally).
      messages: history.map(m => ({ role: m.role, content: m.content })),
      temperature,
      is_raziel: opts?.isRaziel,
      front_member: opts?.frontMember,
      guild_id: opts?.guildId,
    },
  };
}

export class BrainClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(brainUrl: string, timeoutMs = 30_000) {
    this.url = brainUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send a ThoughtPacket to Brain /chat and return the AgentReply.
   * Returns null on network failure or non-2xx response (caller falls back to direct inference).
   */
  async chat(packet: ThoughtPacket): Promise<AgentReply | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packet),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[brain-client] /chat returned ${res.status} for packet ${packet.packet_id}`);
        return null;
      }
      return (await res.json()) as AgentReply;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[brain-client] /chat failed for packet ${packet.packet_id}: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
