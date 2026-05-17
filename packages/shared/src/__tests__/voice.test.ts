import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { VoiceClient, VoiceRealtimeSession } from "../voice.js";

const mockFetch = jest.fn();

const client = new VoiceClient({
  mistralApiKey: "test-key",
  voiceId: "voice-cypher-001",
  ttsModel: "voxtral-v1",
  sttModel: "voxtral-mini-transcribe-2507",
  fetch: mockFetch as unknown as typeof globalThis.fetch,
});

beforeEach(() => mockFetch.mockReset());

describe("VoiceClient.synthesize", () => {
  it("calls Mistral TTS endpoint with correct body and returns Buffer", async () => {
    const fakeAudio = Buffer.from("fake-audio-data");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
    } as any);

    const result = await client.synthesize("hello Raziel");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mistral.ai/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "voxtral-v1", input: "hello Raziel", voice: "voice-cypher-001" }),
      }),
    );
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it("throws on non-ok TTS response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 } as any);
    await expect(client.synthesize("hello")).rejects.toThrow("TTS failed: 429");
  });
});

describe("VoiceClient.transcribe", () => {
  it("calls Mistral offline STT with multipart form and returns text", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "what is the plan" }),
    } as any);

    const result = await client.transcribe(Buffer.from("fake-ogg"), "voice.ogg");
    expect(result).toBe("what is the plan");

    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(call[1].method).toBe("POST");
    const body = call[1].body as FormData;
    expect(body.get("model")).toBe("voxtral-mini-transcribe-2507");
  });

  it("throws on non-ok STT response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as any);
    await expect(client.transcribe(Buffer.from("x"), "voice.ogg")).rejects.toThrow("STT failed: 503");
  });
});

describe("VoiceClient.isHealthy", () => {
  it("returns true when Mistral API responds ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as any);
    expect(await client.isHealthy()).toBe(true);
  });

  it("returns false when Mistral API is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await client.isHealthy()).toBe(false);
  });
});

describe("VoiceClient.createRealtimeSession", () => {
  it("returns a session object with a run method", () => {
    const session = client.createRealtimeSession();
    expect(session).toBeTruthy();
    expect(typeof session.run).toBe("function");
    expect(typeof session.onTranscript).toBe("function");
  });
});

describe("VoiceRealtimeSession", () => {
  it("accumulates transcript deltas and returns final string", async () => {
    const session = new VoiceRealtimeSession("test-key", {
      _mockTranscriptEvents: [
        { type: "transcript.text.delta", text: "hello " },
        { type: "transcript.text.delta", text: "world" },
        { type: "transcript.done" },
      ],
    });

    const deltas: string[] = [];
    session.onTranscript((t) => deltas.push(t));

    async function* emptyPCM(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(0);
    }

    const result = await session.run(emptyPCM());
    expect(result).toBe("hello world");
    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("returns empty string if no speech", async () => {
    const session = new VoiceRealtimeSession("test-key", {
      _mockTranscriptEvents: [{ type: "transcript.done" }],
    });

    async function* emptyPCM(): AsyncIterable<Uint8Array> {}

    const result = await session.run(emptyPCM());
    expect(result).toBe("");
  });
});
