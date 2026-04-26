export interface VoiceClientConfig {
  url: string;
  voiceId: string;
  speed?: number;
  /** Injectable fetch for testing; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export class VoiceClient {
  private url: string;
  private voiceId: string;
  private speed: number;
  private _fetch: typeof globalThis.fetch;

  constructor(config: VoiceClientConfig) {
    this.url = config.url;
    this.voiceId = config.voiceId;
    this.speed = config.speed ?? 1.0;
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  async synthesize(text: string): Promise<Buffer> {
    const res = await this._fetch(`${this.url}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: this.voiceId, speed: this.speed }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)]), filename);
    const res = await this._fetch(`${this.url}/stt`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`STT failed: ${res.status}`);
    const data = (await res.json()) as { text: string; language: string };
    return data.text;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this._fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

import { type Message } from "discord.js";

export const VOICE_KEYWORDS = ["say", "speak", "tell me out loud", "voice this"];
export const JOIN_KEYWORDS = ["join", "come in", "join me", "get in here"];
export const LEAVE_KEYWORDS = ["leave", "get out", "disconnect"];

export function shouldVoice(
  content: string,
  voiceInput: boolean,
  channelEntry?: { voice?: boolean },
): boolean {
  if (channelEntry?.voice) return true;
  if (voiceInput) return true;
  const lower = content.toLowerCase();
  return VOICE_KEYWORDS.some((k) => lower.includes(k));
}

export function isInvitation(message: Message, botUserId: string): boolean {
  return (
    message.mentions.users.has(botUserId) &&
    JOIN_KEYWORDS.some((k) => message.content.toLowerCase().includes(k)) &&
    message.member?.voice?.channel != null
  );
}

export function isLeaveRequest(message: Message, botUserId: string): boolean {
  return (
    message.mentions.users.has(botUserId) &&
    LEAVE_KEYWORDS.some((k) => message.content.toLowerCase().includes(k))
  );
}
