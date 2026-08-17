// Envelope-decline retry fix (2026-07-05).
//
// librarian.ask() resolves on HTTP 200 even when the envelope carries an application-level
// decline ({ error } / witness-only / ack:false), so WriteQueue.fireAndForget saw success and
// never retried witness/companion-note/live-thread writes. These tests pin the fix: ask-based
// WRITE wrappers throw on decline envelopes so the queue buffers and retries; READ paths keep
// resolving unchanged.

import { jest } from "@jest/globals";
import { LibrarianClient, assertWriteAck } from "../librarian.js";
import { WriteQueue } from "../write-queue.js";

type FetchFn = typeof globalThis.fetch;

/** Build a LibrarianClient whose /librarian/mcp always answers 200 with the given envelope. */
function clientWithEnvelope(envelope: unknown): LibrarianClient {
  const fetchMock = jest.fn(async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(envelope) }] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ) as unknown as FetchFn;
  return new LibrarianClient({
    url: "https://halseth.test",
    secret: "s",
    companionId: "cypher",
    fetch: fetchMock,
  });
}

describe("assertWriteAck", () => {
  it("passes through an acked envelope", () => {
    const res = { ack: true, id: "abc" };
    expect(assertWriteAck(res, "test")).toBe(res);
  });

  it("passes through an id-only envelope (legacy executors)", () => {
    expect(() => assertWriteAck({ id: "abc" }, "test")).not.toThrow();
  });

  it("throws on { error } envelopes with reason detail", () => {
    expect(() => assertWriteAck({ error: "state_update_failed", reason: "no fields" }, "soma"))
      .toThrow(/soma.*state_update_failed.*no fields/);
  });

  it("throws on witness-only declines (executor rejected the payload shape)", () => {
    expect(() => assertWriteAck({ response_key: "witness", witness: "live_thread_add requires { name }" }, "thread"))
      .toThrow(/thread.*live_thread_add requires/);
  });

  it("throws on ack:false (execLiveThreadClose returns ack: r.ok)", () => {
    expect(() => assertWriteAck({ ack: false, id: "t1" }, "close")).toThrow(/ack=false/);
  });

  it("throws on misroute envelopes (read result returned for a write verb)", () => {
    // The 07-04 class: 'journal: ...' routed to get_tasks and returned a task summary.
    expect(() => assertWriteAck({ data: [{ title: "some task" }], meta: { operation: "get_tasks" } }, "journal"))
      .toThrow(/no ack/);
  });

  it("throws on null/empty responses", () => {
    expect(() => assertWriteAck(null as unknown as Record<string, unknown>, "x")).toThrow(/empty/);
  });
});

describe("LibrarianClient write wrappers throw on decline envelopes", () => {
  it("addCompanionNote resolves on { ack, id }", async () => {
    const c = clientWithEnvelope({ ack: true, id: "n1" });
    await expect(c.addCompanionNote("note")).resolves.toMatchObject({ ack: true });
  });

  it("addCompanionNote throws on { error }", async () => {
    const c = clientWithEnvelope({ error: "companion_note_add_failed", reason: "no note_text" });
    await expect(c.addCompanionNote("note")).rejects.toThrow(/companion_note_add_failed/);
  });

  it("witnessLog throws on witness-only decline", async () => {
    const c = clientWithEnvelope({ response_key: "witness", witness: "I don't know how to handle that yet." });
    await expect(c.witnessLog("entry", "ch")).rejects.toThrow(/witness log/);
  });

  it("synthesizeSession throws on misroute (read envelope)", async () => {
    const c = clientWithEnvelope({ data: { sessions: [] }, meta: { operation: "session_list" } });
    await expect(c.synthesizeSession("summary", "ch")).rejects.toThrow(/no ack/);
  });

  it("addLiveThread throws on { error }", async () => {
    const c = clientWithEnvelope({ error: "live_thread_add_failed" });
    await expect(c.addLiveThread({ name: "t" })).rejects.toThrow(/live_thread_add_failed/);
  });

  it("closeLiveThread throws on ack:false", async () => {
    const c = clientWithEnvelope({ ack: false, id: "t1" });
    await expect(c.closeLiveThread("t1")).rejects.toThrow(/ack=false/);
  });

  it("updatePromptContext throws on { error }", async () => {
    const c = clientWithEnvelope({ error: "state_update_failed", reason: "no fields provided" });
    await expect(c.updatePromptContext("ctx")).rejects.toThrow(/state_update_failed/);
  });

  it("writeHandoff stays non-throwing but does not mask the decline path", async () => {
    // Contract: consolidation/distillation call writeHandoff outside the queue; it logs instead.
    const c = clientWithEnvelope({ error: "handoff_failed" });
    await expect(c.writeHandoff({ title: "t", summary: "s" })).resolves.toBeUndefined();
  });

  it("READ paths are unchanged: getState resolves on a read envelope", async () => {
    const c = clientWithEnvelope({ data: { current_mood: "steady" }, meta: { operation: "state_read" } });
    await expect(c.getState()).resolves.toMatchObject({ data: { current_mood: "steady" } });
  });

  it("raw ask() is unchanged: resolves on { error } (callers opt in via assertWriteAck)", async () => {
    const c = clientWithEnvelope({ error: "whatever" });
    await expect(c.ask("anything")).resolves.toMatchObject({ error: "whatever" });
  });
});

describe("WriteQueue integration: declines are loud, never silent -- and never retried", () => {
  // 2026-08-16 supersedes the 07-05 buffering half: a decline is DETERMINISTIC, so buffering it
  // bought 10 minutes of retries that replayed the identical reject and an age-out line that
  // blamed time (the cypher/gaia somaUpdate class). The guarantee that stays is the 07-05 one:
  // a decline must never look like success -- it now logs DATA LOSS immediately with the reason.
  it("fireAndForget drops an envelope decline immediately and loudly (no buffer)", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const c = clientWithEnvelope({ error: "companion_note_add_failed" });
    const wq = new WriteQueue("test");
    wq.fireAndForget("writeback:test", async () => {
      await c.addCompanionNote("content");
    });
    // fireAndForget catches async; give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(wq.pending).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DATA LOSS: writeback:test"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("companion_note_add_failed"));
    errorSpy.mockRestore();
  });

  it("a transport failure (not a decline) still buffers for retry", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const wq = new WriteQueue("test");
    wq.fireAndForget("writeback:test", async () => { throw new Error("fetch failed"); });
    await new Promise((r) => setTimeout(r, 10));
    expect(wq.pending).toBe(1);
    warnSpy.mockRestore();
  });

  it("fireAndForget does NOT buffer on an acked write", async () => {
    const c = clientWithEnvelope({ ack: true, id: "n1" });
    const wq = new WriteQueue("test");
    wq.fireAndForget("writeback:test", async () => {
      await c.addCompanionNote("content");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(wq.pending).toBe(0);
  });
});
