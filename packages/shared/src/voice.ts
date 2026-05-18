const MISTRAL_BASE = "https://api.mistral.ai";

export interface VoiceClientConfig {
  mistralApiKey: string;
  voiceId: string;
  ttsModel?: string;
  sttModel?: string;
  /** Injectable fetch for testing; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export class VoiceClient {
  private apiKey: string;
  private voiceId: string;
  private ttsModel: string;
  private sttModel: string;
  private _fetch: typeof globalThis.fetch;

  constructor(config: VoiceClientConfig) {
    this.apiKey = config.mistralApiKey;
    this.voiceId = config.voiceId;
    this.ttsModel = config.ttsModel ?? "voxtral-v1";
    this.sttModel = config.sttModel ?? "voxtral-mini-transcribe-2507";
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  async synthesize(text: string): Promise<Buffer> {
    const res = await this._fetch(`${MISTRAL_BASE}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.ttsModel, input: text, voice: this.voiceId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TTS failed: ${res.status} ${body}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)]), filename);
    form.append("model", this.sttModel);
    const res = await this._fetch(`${MISTRAL_BASE}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`STT failed: ${res.status}`);
    const data = (await res.json()) as { text: string };
    return data.text;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this._fetch(`${MISTRAL_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  createRealtimeSession(): VoiceRealtimeSession {
    return new VoiceRealtimeSession(this.apiKey);
  }
}

export const REALTIME_STT_MODEL = "voxtral-mini-transcribe-realtime-2602";

interface RealtimeSessionOptions {
  _mockTranscriptEvents?: Array<{ type: string; text?: string }>;
}

export class VoiceRealtimeSession {
  private apiKey: string;
  private transcriptCallback: ((text: string) => void) | null = null;
  private mockEvents?: Array<{ type: string; text?: string }>;

  constructor(apiKey: string, opts?: RealtimeSessionOptions) {
    this.apiKey = apiKey;
    this.mockEvents = opts?._mockTranscriptEvents;
    if (!this.mockEvents && !apiKey) {
      throw new Error("VoiceRealtimeSession requires a non-empty apiKey");
    }
  }

  onTranscript(cb: (text: string) => void): void {
    this.transcriptCallback = cb;
  }

  async run(audioStream: AsyncIterable<Uint8Array>): Promise<string> {
    let transcript = "";

    if (this.mockEvents) {
      for (const event of this.mockEvents) {
        if (event.type === "transcript.text.delta" && event.text) {
          transcript += event.text;
          this.transcriptCallback?.(event.text);
        }
      }
      return transcript;
    }

    // Production path: stream to Voxtral realtime WebSocket via Mistral SDK.
    // The exact TypeScript method name should be verified at:
    // https://docs.mistral.ai/studio-api/audio/speech_to_text/realtime_transcription
    const { Mistral: MistralClient } = await import("@mistralai/mistralai");
    const mistral = new MistralClient({ apiKey: this.apiKey });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realtimeClient = (mistral.audio as any).realtime;
    if (!realtimeClient?.transcribeStream) {
      throw new Error("Mistral SDK does not expose audio.realtime.transcribeStream -- verify SDK version");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream: AsyncIterable<any> = await realtimeClient.transcribeStream({
      audioStream,
      model: REALTIME_STT_MODEL,
      audioFormat: { encoding: "pcm_s16le", sampleRate: 16000 },
    });

    try {
      for await (const event of stream) {
        const text: string | undefined = event.text ?? event.delta?.text;
        if (text) {
          transcript += text;
          this.transcriptCallback?.(text);
        }
      }
    } catch (err) {
      throw new Error(`Voxtral realtime transcription failed: ${(err as Error).message}`);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (stream as any)[Symbol.asyncIterator] !== "undefined") {
        try { await (stream as any).return?.(); } catch { /* ignore cleanup errors */ }
      }
    }

    return transcript;
  }
}

import { type Message } from "discord.js";

export const VOICE_KEYWORDS = [
  "say", "speak", "tell me out loud", "voice this",
  "voice message", "voice note", "voice reply",
  "send voice", "send a voice", "send me voice", "send me a voice",
  "in voice", "as voice", "voice please",
];
export const JOIN_KEYWORDS = ["join", "come in", "join me", "get in here"];
export const LEAVE_KEYWORDS = ["leave", "get out", "disconnect"];

// Sticky voice window: once a user voices in a channel (or asks for voice),
// keep replies in voice for STICKY_VOICE_MS so the texture of the conversation
// holds. Reset only on explicit "stop", "text only", or natural decay.
export const STICKY_VOICE_MS = 10 * 60 * 1000; // 10 minutes
const stickyVoiceUntil = new Map<string, number>();

export function markVoiceUsed(channelId: string): void {
  stickyVoiceUntil.set(channelId, Date.now() + STICKY_VOICE_MS);
}

export function isVoiceSticky(channelId: string): boolean {
  const until = stickyVoiceUntil.get(channelId);
  if (!until) return false;
  if (Date.now() > until) {
    stickyVoiceUntil.delete(channelId);
    return false;
  }
  return true;
}

export function clearVoiceSticky(channelId: string): void {
  stickyVoiceUntil.delete(channelId);
}

const STOP_VOICE_KEYWORDS = ["text only", "stop voice", "no voice", "back to text"];

export function shouldVoice(
  content: string,
  voiceInput: boolean,
  channelEntry?: { voice?: boolean },
  channelId?: string,
): boolean {
  const lower = content.toLowerCase();
  // Explicit opt-out wins over everything.
  if (STOP_VOICE_KEYWORDS.some((k) => lower.includes(k))) {
    if (channelId) clearVoiceSticky(channelId);
    return false;
  }
  if (channelEntry?.voice) return true;
  if (voiceInput) return true;
  if (VOICE_KEYWORDS.some((k) => lower.includes(k))) return true;
  if (channelId && isVoiceSticky(channelId)) return true;
  return false;
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
