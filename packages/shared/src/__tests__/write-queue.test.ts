import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { WriteQueue } from "../write-queue.js";

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

  it("buffer overflow evicts the oldest unsaved write and logs it as data loss (error)", async () => {
    const wq = new WriteQueue("cypher");
    for (let i = 0; i < 101; i++) {
      await wq.enqueue(`w${i}`, async () => { throw new Error("down"); });
    }
    expect(wq.pending).toBe(100); // still bounded
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("w0")); // oldest was dropped → logged
  });

  it("the log line is attributable to the bot (includes the queue name)", async () => {
    const wq = new WriteQueue("gaia");
    await wq.enqueue("handoff:9", async () => { throw new Error("x"); });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gaia"));
  });
});
