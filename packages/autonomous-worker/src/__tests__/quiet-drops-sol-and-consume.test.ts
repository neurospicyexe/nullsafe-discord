// 2026-11-05 quiet-drop sweep: items 7 (Sol moment post) and 8 (worker-side forage consume).
import { describe, it, expect, vi, afterEach } from "vitest";
import { postSolMoment } from "../sol-presence.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("postSolMoment", () => {
  it("returns true on 204 with no retry", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "hello", 0)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("retries once after a network error and lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "hello", 0)).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("logs status (never the text) and gives up after one retry on 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "SECRET-MOMENT", 0)).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("status 500");
    expect(logged).toContain("dropped");
    expect(logged).not.toContain("SECRET-MOMENT");
  });
  it("does not retry a 404 (dead webhook)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("x", { status: 404 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "t", 0)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("worker consumeForageFind", () => {
  it("retries a 503 then lands; 404 is final", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { consumeForageFind } = await import("../halseth-client.js");
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await consumeForageFind("f1", "cypher")).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", g);
    expect(await consumeForageFind("f1", "cypher")).toBe(false);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
