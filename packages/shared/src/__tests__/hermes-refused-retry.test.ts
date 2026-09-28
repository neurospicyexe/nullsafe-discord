import { jest, describe, it, expect, afterEach } from "@jest/globals";
import { createAdapter, fetchRetryingRefused, isConnectionRefused, HERMES_REFUSED_BACKOFF_MS } from "../inference.js";

// B28 (2026-09-28): a Hermes gateway restart closes its port for the 4-6s the new process takes to
// listen, and each call in that hole came back as the in-character fallback (48 ECONNREFUSED hits
// since August). The adapter now retries a REFUSED connect only, since nothing reached the gateway.

function refused(): Error {
  // Shape undici produces: TypeError("fetch failed") with the syscall error on `cause`.
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8643"), { code: "ECONNREFUSED" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

const okResponse = (content: string) =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) as any;

function hermes(fetchFn: any) {
  return createAdapter(
    "deepseek", "deepseek-chat", { hermes: "hermes-token" },
    { hermes: "http://127.0.0.1:8643/v1", forceHermes: true },
    fetchFn,
  );
}

const noSleep = jest.fn(async (_ms: number, _signal: AbortSignal) => {});

afterEach(() => { jest.restoreAllMocks(); noSleep.mockClear(); });

describe("isConnectionRefused", () => {
  it("matches the code on cause (undici) and on the error itself", () => {
    expect(isConnectionRefused(refused())).toBe(true);
    expect(isConnectionRefused(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
  });
  it("does not match other failures", () => {
    expect(isConnectionRefused(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(isConnectionRefused(new DOMException("timed out", "TimeoutError"))).toBe(false);
    expect(isConnectionRefused(new Error("fetch failed"))).toBe(false);
    expect(isConnectionRefused(null)).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});

describe("fetchRetryingRefused", () => {
  it("backs off 1, 2, 4, 4, 4s (about 15s total)", () => {
    expect([...HERMES_REFUSED_BACKOFF_MS]).toEqual([1000, 2000, 4000, 4000, 4000]);
    expect(HERMES_REFUSED_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(15_000);
  });

  it("refused twice then success: returns the response after 3 calls, sleeping 1s then 2s", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(okResponse("back"));
    const res = await fetchRetryingRefused(fetchFn, "u", { signal: new AbortController().signal }, HERMES_REFUSED_BACKOFF_MS, noSleep);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(await (res as any).json()).toEqual({ choices: [{ message: { content: "back" } }] });
    expect(noSleep.mock.calls.map(c => c[0])).toEqual([1000, 2000]);
    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines).toEqual(["[hermes] refused, retry 1", "[hermes] refused, retry 2"]);
  });

  it("gives up after the fifth retry and rethrows the refusal (6 attempts total)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>().mockRejectedValue(refused());
    await expect(
      fetchRetryingRefused(fetchFn, "u", { signal: new AbortController().signal }, HERMES_REFUSED_BACKOFF_MS, noSleep),
    ).rejects.toThrow("fetch failed");
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(noSleep).toHaveBeenCalledTimes(5);
  });

  it("a timeout is NOT retried", async () => {
    const fetchFn = jest.fn<any>().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(
      fetchRetryingRefused(fetchFn, "u", { signal: new AbortController().signal }, HERMES_REFUSED_BACKOFF_MS, noSleep),
    ).rejects.toThrow(/timeout/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("other network errors (reset) are NOT retried", async () => {
    const fetchFn = jest.fn<any>().mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
    );
    await expect(
      fetchRetryingRefused(fetchFn, "u", { signal: new AbortController().signal }, HERMES_REFUSED_BACKOFF_MS, noSleep),
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("the overall ceiling spans the backoffs: a 150ms deadline ends a 1s backoff early", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>().mockRejectedValue(refused());
    const started = Date.now();
    // Default (real, abortable) sleep: the deadline must interrupt it, not wait it out.
    await expect(fetchRetryingRefused(fetchFn, "u", { signal: AbortSignal.timeout(150) })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(900);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry once the signal has already aborted", async () => {
    const ctl = new AbortController();
    const fetchFn = jest.fn<any>().mockImplementation(async () => { ctl.abort(); throw refused(); });
    await expect(
      fetchRetryingRefused(fetchFn, "u", { signal: ctl.signal }, HERMES_REFUSED_BACKOFF_MS, noSleep),
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });
});

describe("HermesAdapter refused-connection retry (real timers, wired through createAdapter)", () => {
  it("refused twice then success returns the content after 3 fetch calls", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce(okResponse("gateway is back"));
    const out = await hermes(fetchFn).generate("system", [{ role: "user", content: "hi" }]);
    expect(out).toBe("gateway is back");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("a timeout is not retried: one call, null (the fallback path)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const out = await hermes(fetchFn).generate("system", [{ role: "user", content: "hi" }]);
    expect(out).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("an HTTP error is not retried", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) } as any);
    const out = await hermes(fetchFn).generate("system", [{ role: "user", content: "hi" }]);
    expect(out).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("an abort mid-backoff stops retrying at once", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = jest.fn<any>().mockRejectedValue(refused());
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 200); // lands inside the first 1s backoff
    const out = await hermes(fetchFn).generate("system", [{ role: "user", content: "hi" }], 0.7, 1024, "s", "k", ctl.signal);
    expect(out).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(900);
    // Give any stray backoff timer a chance to fire; it must not issue another fetch.
    await new Promise(r => setTimeout(r, 1_200));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("[hermes] refused, retry")).length).toBe(1);
  }, 10_000);
});
