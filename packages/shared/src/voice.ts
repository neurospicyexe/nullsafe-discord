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
    form.append("audio", new Blob([audio as unknown as ArrayBuffer]), filename);
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
