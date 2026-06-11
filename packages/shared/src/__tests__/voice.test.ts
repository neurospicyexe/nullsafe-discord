import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  VoiceClient, VoiceRealtimeSession,
  shouldVoice, matchesVoiceKeyword, markVoiceUsed, clearVoiceSticky,
} from "../voice.js";

const mockFetch = jest.fn();

const client = new VoiceClient({
  mistralApiKey: "test-key",
  voiceId: "voice-cypher-001",
  ttsModel: "voxtral-mini-tts-2603",
  sttModel: "voxtral-mini-transcribe-2507",
  fetch: mockFetch as unknown as typeof globalThis.fetch,
});

beforeEach(() => mockFetch.mockReset());

describe("VoiceClient.synthesize", () => {
  it("calls Mistral TTS endpoint with correct body and returns decoded Buffer", async () => {
    const fakeAudio = Buffer.from("fake-audio-data");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ audio_data: fakeAudio.toString("base64") }),
    } as any);

    const result = await client.synthesize("hello Raziel");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mistral.ai/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "voxtral-mini-tts-2603", input: "hello Raziel", voice_id: "voice-cypher-001", response_format: "mp3" }),
      }),
    );
    expect(result).toEqual(fakeAudio);
  });

  it("throws on non-ok TTS response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" } as any);
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

describe("matchesVoiceKeyword", () => {
  it("matches explicit voice requests on word boundaries", () => {
    expect(matchesVoiceKeyword("can you speak this one")).toBe(true);
    expect(matchesVoiceKeyword("say it out loud")).toBe(true);
    expect(matchesVoiceKeyword("send me a voice note")).toBe(true);
    expect(matchesVoiceKeyword("reply in voice please")).toBe(true);
  });

  it("does not fire on incidental substrings (the old bare-'say' bug)", () => {
    expect(matchesVoiceKeyword("they say it's fine")).toBe(true); // "say it" is a real phrase match
    expect(matchesVoiceKeyword("I'd say we ship it")).toBe(false);
    expect(matchesVoiceKeyword("she says hello")).toBe(false);
    expect(matchesVoiceKeyword("writing an essay tonight")).toBe(false);
    expect(matchesVoiceKeyword("speaking of which")).toBe(false);
    expect(matchesVoiceKeyword("the speaker was loud")).toBe(false);
  });
});

describe("shouldVoice", () => {
  const CH = "test-channel-shouldvoice";
  beforeEach(() => clearVoiceSticky(CH));

  it("always voices in a voice:true channel", () => {
    expect(shouldVoice("plain text message", false, { voice: true }, CH)).toBe(true);
  });

  it("voices when the inbound message was voice", () => {
    expect(shouldVoice("transcribed words", true, undefined, CH)).toBe(true);
  });

  it("stays text for plain messages with no triggers", () => {
    expect(shouldVoice("just a normal message", false, undefined, CH)).toBe(false);
  });

  it("honors the sticky window and explicit opt-out", () => {
    markVoiceUsed(CH);
    expect(shouldVoice("follow-up text", false, undefined, CH)).toBe(true);
    expect(shouldVoice("ok text only now", false, undefined, CH)).toBe(false);
    // opt-out cleared the sticky window
    expect(shouldVoice("another message", false, undefined, CH)).toBe(false);
  });

  it("opt-out wins for this message even in a voice channel", () => {
    expect(shouldVoice("stop voice for a sec", false, { voice: true }, CH)).toBe(false);
  });
});
