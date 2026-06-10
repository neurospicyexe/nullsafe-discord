import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";

// liveIngest reads env at module load, so each scenario re-imports with fresh env.
async function loadWithEnv(env: Record<string, string | undefined>) {
  jest.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("../sb-live-ingest.js");
  return {
    mod,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
  (globalThis as Record<string, unknown>)["fetch"] = fetchMock;
});
afterEach(() => {
  (globalThis as Record<string, unknown>)["fetch"] = realFetch;
});

const msg = {
  companion: null,
  author: "Crash",
  content: "a human message long enough to clear the fifty character floor easily",
  channel_id: "123",
  message_id: "456",
};

describe("liveIngest", () => {
  it("no-ops when SB_LIVE_INGEST is not true", async () => {
    const { mod, restore } = await loadWithEnv({ SB_LIVE_INGEST: undefined, SECOND_BRAIN_URL: "http://127.0.0.1:9999" });
    mod.liveIngest(msg);
    expect(fetchMock).not.toHaveBeenCalled();
    restore();
  });

  it("no-ops when SECOND_BRAIN_URL is unset even when enabled", async () => {
    const { mod, restore } = await loadWithEnv({ SB_LIVE_INGEST: "true", SECOND_BRAIN_URL: undefined });
    mod.liveIngest(msg);
    expect(fetchMock).not.toHaveBeenCalled();
    restore();
  });

  it("posts enabled human messages with bearer auth", async () => {
    const { mod, restore } = await loadWithEnv({ SB_LIVE_INGEST: "true", SECOND_BRAIN_URL: "http://127.0.0.1:9999/", SB_INGEST_KEY: "k" });
    mod.liveIngest(msg);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("http://127.0.0.1:9999/ingest/discord");
    expect(init.headers["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(init.body).message_id).toBe("456");
    restore();
  });

  it("skips short human messages but keeps short companion replies", async () => {
    const { mod, restore } = await loadWithEnv({ SB_LIVE_INGEST: "true", SECOND_BRAIN_URL: "http://127.0.0.1:9999", SB_INGEST_KEY: undefined });
    mod.liveIngest({ ...msg, content: "lol" });
    expect(fetchMock).not.toHaveBeenCalled();
    mod.liveIngest({ ...msg, companion: "gaia", author: "gaia", content: "What holds." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    restore();
  });

  it("swallows fetch failures (fire-and-forget)", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error("ECONNREFUSED"); });
    const { mod, restore } = await loadWithEnv({ SB_LIVE_INGEST: "true", SECOND_BRAIN_URL: "http://127.0.0.1:9999" });
    expect(() => mod.liveIngest(msg)).not.toThrow();
    await new Promise(r => setTimeout(r, 10));
    restore();
  });
});
