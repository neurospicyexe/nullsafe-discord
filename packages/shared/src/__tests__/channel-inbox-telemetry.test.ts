import { ChannelInbox, type InboxItem, type TurnContext } from "../channel-inbox.js";

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, channelId: "chan-1", authorIsHuman: true, content: `msg ${id}`, authorKey: "raz", side: "raziel", ...over,
});
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r)); };

function clock() {
  let t = 1_000_000;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>(resolve => { waiters.push({ at: t + ms, resolve }); }),
    async advance(ms: number) {
      t += ms;
      for (const w of waiters.splice(0)) { if (w.at <= t) w.resolve(); else waiters.push(w); }
      await flush();
    },
  };
}

describe("TurnContext telemetry fields (P6)", () => {
  it("settleWaitedMs is the real hold, queueWaitedMs the arrival-to-start time minus it", async () => {
    const c = clock();
    const ctxs: Record<string, TurnContext> = {};
    const inbox = new ChannelInbox({ settleMs: 4000, now: c.now, sleep: c.sleep, log: () => {} });
    inbox.enqueue(item("a"), async (_s, ctx) => { ctxs["a"] = ctx; });
    await c.advance(1000);
    inbox.enqueue(item("b"), async (_s, ctx) => { ctxs["b"] = ctx; });
    await c.advance(4000);
    expect(ctxs["a"]!.settleWaitedMs).toBe(5000);
    expect(ctxs["a"]!.queueWaitedMs).toBe(0);
    expect(ctxs["b"]!.settleWaitedMs).toBe(0);
    expect(ctxs["b"]!.catchUp).toBe(false);
  });

  it("a turn that queued behind a running one waits in queue_ms and is flagged catchUp", async () => {
    const c = clock();
    const ctxs: Record<string, TurnContext> = {};
    let release: () => void = () => {};
    const inbox = new ChannelInbox({ settleMs: 0, now: c.now, sleep: c.sleep, log: () => {} });
    inbox.enqueue(item("a"), async (_s, ctx) => { ctxs["a"] = ctx; await new Promise<void>(r => { release = r; }); });
    await flush();
    inbox.enqueue(item("b"), async (_s, ctx) => { ctxs["b"] = ctx; });
    await c.advance(7000);
    release();
    await flush();
    expect(ctxs["a"]!.catchUp).toBe(false);
    expect(ctxs["b"]!.catchUp).toBe(true);
    expect(ctxs["b"]!.queueWaitedMs).toBe(7000);
    expect(ctxs["b"]!.settleWaitedMs).toBe(0);
  });

  it("an overflow-dropped turn is reported through onDrop", async () => {
    const dropped: string[] = [];
    let release: () => void = () => {};
    const inbox = new ChannelInbox({ settleMs: 0, maxQueue: 2, log: () => {}, onDrop: (it) => dropped.push(it.id) });
    inbox.enqueue(item("a"), async () => { await new Promise<void>(r => { release = r; }); });
    await flush();
    inbox.enqueue(item("b"), async () => {});
    inbox.enqueue(item("c"), async () => {});
    inbox.enqueue(item("d"), async () => {});
    release(); await flush();
    expect(dropped).toEqual(["b"]);
  });
});
