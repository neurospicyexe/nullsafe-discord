import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  getDirectorSupply: vi.fn(async () => ({ items: [], cursor: "2026-09-03T00:00:00.000Z" })),
  getDirectorNeighborhood: vi.fn(async () => ({ lines: [], nodes: [] })),
  recordInvitation: vi.fn(async () => {}),
  resolveInvitation: vi.fn(async () => {}),
  convoActiveFor: vi.fn(async () => null),
  convoOpenFor: vi.fn(async () => ({ id: "t1" })),
  convoTurnFor: vi.fn(async () => {}),
  convoLandFor: vi.fn(async () => true),
  convoFadeFor: vi.fn(async () => true),
  consumeForageFind: vi.fn(async () => true),
}));

vi.mock("@nullsafe/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nullsafe/shared")>();
  const fakeSub = {
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    quit: vi.fn(async () => {}),
  };
  return { ...actual, createSubscriberClient: vi.fn(() => fakeSub) };
});

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("liveness gate: director:alive", () => {
  it("writes director:alive with EX 60 immediately on start, both live and shadow modes", async () => {
    for (const mode of ["true", "shadow"]) {
      process.env["DIRECTOR_ENABLED"] = mode;
      const setCalls: unknown[][] = [];
      const redis = {
        get: vi.fn(async () => null),
        set: vi.fn(async (...args: unknown[]) => { setCalls.push(args); return "OK"; }),
        del: vi.fn(async () => 1),
        publish: vi.fn(async () => 1),
      };
      const { startDirector } = await import("../director/index.js");
      const stop = startDirector({ redisUrl: "redis://fake", redis: redis as never });
      // The write is fire-and-forget (a .catch on a promise) -- give the microtask queue a turn.
      await new Promise((r) => setTimeout(r, 0));
      const aliveCall = setCalls.find((c) => c[0] === "director:alive");
      expect(aliveCall).toBeTruthy();
      expect(aliveCall).toEqual(["director:alive", expect.any(String), "EX", 60]);
      await stop();
    }
  });

  it("off mode never starts the loop -- no director:alive write", async () => {
    process.env["DIRECTOR_ENABLED"] = "";
    const setCalls: unknown[][] = [];
    const redis = { get: vi.fn(async () => null), set: vi.fn(async (...args: unknown[]) => { setCalls.push(args); return "OK"; }), del: vi.fn(async () => 1), publish: vi.fn(async () => 1) };
    const { startDirector } = await import("../director/index.js");
    const stop = startDirector({ redisUrl: "redis://fake", redis: redis as never });
    await new Promise((r) => setTimeout(r, 0));
    expect(setCalls.find((c) => c[0] === "director:alive")).toBeUndefined();
    await stop();
  });
});
