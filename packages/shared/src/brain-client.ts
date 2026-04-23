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
import type { SwarmReply } from "./swarm.js";
import { isSwarmReply } from "./swarm.js";

export interface ThoughtPacketMetadata {
  channel_id: string;
  message_id?: string;         // Discord message snowflake -- used by Brain for dedup
  history?: Array<{ author: string; content: string }>;  // channel conversation history for swarm
  system_prompt?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
  is_owner?: boolean;
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
  // Phase 2 swarm fields
  author?: string;               // system member name if PluralKit, else "Raziel"
  author_is_companion?: boolean;
  depth?: number;
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
  messageId: string,
  message: string,
  systemPrompt: string,
  history: ChatMessage[],
  channelHistory: Array<{ author: string; content: string }>,
  temperature: number,
  opts?: {
    isOwner?: boolean;
    frontMember?: string | null;
    guildId?: string;
    author?: string;
    authorIsCompanion?: boolean;
    depth?: number;
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
    author: opts?.author ?? "Raziel",
    author_is_companion: opts?.authorIsCompanion ?? false,
    depth: opts?.depth ?? 0,
    metadata: {
      channel_id: channelId,
      message_id: messageId,
      history: channelHistory,
      system_prompt: systemPrompt,
      messages: history.map(m => ({ role: m.role, content: m.content })),
      temperature,
      is_owner: opts?.isOwner,
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
   * Send a ThoughtPacket to Brain /chat and return the AgentReply or SwarmReply.
   * Returns null on network failure or non-2xx response (caller falls back to direct inference).
   */
  async chat(packet: ThoughtPacket): Promise<AgentReply | SwarmReply | null> {
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
      const data = await res.json();
      return data as AgentReply | SwarmReply;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[brain-client] /chat failed for packet ${packet.packet_id}: ${msg}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type { SwarmReply } from "./swarm.js";
export { isSwarmReply } from "./swarm.js";
