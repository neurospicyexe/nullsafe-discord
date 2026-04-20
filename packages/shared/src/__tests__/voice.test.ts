import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { VoiceClient } from "../voice.js";

const mockFetch = jest.fn();

const client = new VoiceClient({
  url: "http://localhost:5001",
  voiceId: "am_echo",
  speed: 1.0,
  fetch: mockFetch as unknown as typeof globalThis.fetch,
});

beforeEach(() => mockFetch.mockReset());

describe("VoiceClient.synthesize", () => {
  it("returns a Buffer on success", async () => {
    const fakeOgg = Buffer.from("OggS\x00fake");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () =>
        fakeOgg.buffer.slice(fakeOgg.byteOffset, fakeOgg.byteOffset + fakeOgg.byteLength),
    } as any);

    const result = await client.synthesize("hello");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:5001/tts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello", voice_id: "am_echo", speed: 1.0 }),
      }),
    );
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as any);
    await expect(client.synthesize("hello")).rejects.toThrow("TTS failed: 503");
  });
});

describe("VoiceClient.transcribe", () => {
  it("returns transcript text on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "hello world", language: "en" }),
    } as any);

    const result = await client.transcribe(Buffer.from("fake-audio"), "voice.ogg");
    expect(result).toBe("hello world");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as any);
    await expect(client.transcribe(Buffer.from("x"), "voice.ogg")).rejects.toThrow("STT failed: 503");
  });
});

describe("VoiceClient.isHealthy", () => {
  it("returns true when sidecar responds ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as any);
    expect(await client.isHealthy()).toBe(true);
  });

  it("returns false when sidecar is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await client.isHealthy()).toBe(false);
  });
});
