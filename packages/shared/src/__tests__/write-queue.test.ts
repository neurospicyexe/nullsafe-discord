import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { MAX_BUFFER, WriteQueue, onWriteError, isPermanentWriteError } from "../write-queue.js";
import { assertWriteAck } from "../librarian.js";

describe("onWriteError — fire-and-forget writes outside the queue must not be silent", () => {
  it("returns a handler that logs the failure with both the companion tag and the label", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    onWriteError("cypher", "inter-companion note")(new Error("halseth down"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("inter-companion note"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cypher"));
    warnSpy.mockRestore();
  });
});

// Continuity writes (handoff, SOMA, wm_note) go through WriteQueue.fireAndForget. Before this,
// a failed write was buffered silently and a buffer-overflow/age-out dropped it with NO signal —
// so a broken write path looked identical to a healthy one. These tests pin that every failure
// and every dropped (lost) write is logged. The logging IS the feature.

describe("WriteQueue observability — failures and data loss must be loud", () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("enqueue: a failed write is buffered AND logged with its label", async () => {
    const wq = new WriteQueue("cypher");
    await wq.enqueue("handoff:123", async () => { throw new Error("halseth down"); });
    expect(wq.pending).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("handoff:123"));
  });

  it("enqueue: a successful write neither buffers nor logs", async () => {
    const wq = new WriteQueue("cypher");
    await wq.enqueue("ok:1", async () => { /* succeeds */ });
    expect(wq.pending).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fireAndForget: a failed write is buffered AND logged with its label", async () => {
    const wq = new WriteQueue("cypher");
    wq.fireAndForget("soma:123", async () => { throw new Error("boom"); });
    await new Promise((r) => setImmediate(r)); // let the rejection settle
    expect(wq.pending).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("soma:123"));
  });

  // 2026-08-16: cypher/gaia somaUpdate declines ("no valid fields provided") were buffered and
  // retried for 10 minutes -- a deterministic executor reject replays identically, so the retries
  // could never succeed, and the age-out line blamed time instead of the payload. Six weeks of
  // recurring DATA LOSS lines. A decline is now dropped immediately, loudly, with the REAL reason.
  it("a deterministic librarian decline is dropped immediately with the real reason -- never buffered", async () => {
    const wq = new WriteQueue("cypher");
    await wq.enqueue("somaUpdate:123", async () => {
      assertWriteAck({ error: "state_update_failed", reason: "no valid fields provided" }, "soma update");
    });
    expect(wq.pending).toBe(0); // not buffered -- retrying replays the reject
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DATA LOSS: somaUpdate:123"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no valid fields provided"));
  });

  it("transport failures stay retryable -- only assertWriteAck reject shapes are permanent", () => {
    expect(isPermanentWriteError(new Error("librarian soma update declined: state_update_failed -- no valid fields provided"))).toBe(true);
    expect(isPermanentWriteError(new Error("librarian handoff: write not applied (ack=false)"))).toBe(true);
    expect(isPermanentWriteError(new Error("librarian note: no ack (silent reject/misroute) -- witness text"))).toBe(true);
    expect(isPermanentWriteError(new Error("fetch failed"))).toBe(false);
    expect(isPermanentWriteError(new Error("HTTP 502"))).toBe(false);
    expect(isPermanentWriteError(new Error("librarian soma update: empty response"))).toBe(false);
  });

  it("buffer overflow evicts the oldest unsaved write and logs it as data loss (error)", async () => {
    const wq = new WriteQueue("cypher");
    for (let i = 0; i < MAX_BUFFER + 1; i++) {
      await wq.enqueue(`w${i}`, async () => { throw new Error("down"); });
    }
    expect(wq.pending).toBe(MAX_BUFFER); // still bounded
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("w0")); // oldest was dropped → logged
  });

  it("the log line is attributable to the bot (includes the queue name)", async () => {
    const wq = new WriteQueue("gaia");
    await wq.enqueue("handoff:9", async () => { throw new Error("x"); });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gaia"));
  });
});
