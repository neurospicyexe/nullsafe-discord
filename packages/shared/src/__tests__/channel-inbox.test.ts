import { ChannelInbox, type InboxItem } from "../channel-inbox.js";

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  channelId: "chan-1",
  authorIsHuman: true,
  content: `msg ${id}`,
  ...over,
});

/** A controllable turn: resolves when release() is called. Records supersede state. */
function makeTurn() {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const state = { started: false, supersededAtEnd: false as boolean };
  const run = async (isSuperseded: () => boolean) => {
    state.started = true;
    await gate;
    state.supersededAtEnd = isSuperseded();
  };
  return { run, release, state };
}

const tick = () => new Promise<void>(r => setImmediate(r));

describe("ChannelInbox", () => {
  test("turns in the same channel run strictly one at a time, in order", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const order: string[] = [];
    const t1 = makeTurn();
    const t2 = makeTurn();

    inbox.enqueue(item("1"), async (s) => { order.push("1-start"); await t1.run(s); order.push("1-end"); });
    inbox.enqueue(item("2"), async (s) => { order.push("2-start"); await t2.run(s); order.push("2-end"); });
    await tick();

    expect(order).toEqual(["1-start"]); // 2 must not start while 1 runs
    t1.release(); await tick();
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
    t2.release(); await tick();
    expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
  });

  test("different channels drain independently", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const started: string[] = [];
    const t1 = makeTurn();
    inbox.enqueue(item("a", { channelId: "chan-A" }), async (s) => { started.push("a"); await t1.run(s); });
    inbox.enqueue(item("b", { channelId: "chan-B" }), async () => { started.push("b"); });
    await tick();
    expect(started).toContain("b"); // B not blocked by A's in-flight turn
    t1.release(); await tick();
  });

  test("a queued human message supersedes the running turn (live probe mid-run)", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const t1 = makeTurn();
    inbox.enqueue(item("1"), t1.run);
    await tick();
    expect(t1.state.started).toBe(true);

    inbox.enqueue(item("2"), async () => {}); // arrives mid-inference
    t1.release(); await tick();
    expect(t1.state.supersededAtEnd).toBe(true);
  });

  test("a queued companion-bot message does NOT supersede", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const t1 = makeTurn();
    inbox.enqueue(item("1"), t1.run);
    await tick();
    inbox.enqueue(item("2", { authorIsHuman: false }), async () => {});
    t1.release(); await tick();
    expect(t1.state.supersededAtEnd).toBe(false);
  });

  test("a queued command-shaped message does NOT supersede", async () => {
    const guard = /^cy\b[,:]?\s*(?:model|listen|log)\b/i;
    const inbox = new ChannelInbox({ log: () => {}, isCommandShaped: c => guard.test(c) });
    const t1 = makeTurn();
    inbox.enqueue(item("1"), t1.run);
    await tick();
    inbox.enqueue(item("2", { content: "cy: log a thought" }), async () => {});
    t1.release(); await tick();
    expect(t1.state.supersededAtEnd).toBe(false);
  });

  test("a throwing turn does not wedge the channel queue", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const ran: string[] = [];
    inbox.enqueue(item("1"), async () => { throw new Error("boom"); });
    inbox.enqueue(item("2"), async () => { ran.push("2"); });
    await tick();
    expect(ran).toEqual(["2"]);
  });

  test("queue overflow drops the oldest waiting turn", async () => {
    const inbox = new ChannelInbox({ log: () => {}, maxQueue: 2 });
    const ran: string[] = [];
    const t1 = makeTurn();
    inbox.enqueue(item("1"), t1.run); // running
    await tick();
    inbox.enqueue(item("2"), async () => { ran.push("2"); });
    inbox.enqueue(item("3"), async () => { ran.push("3"); });
    inbox.enqueue(item("4"), async () => { ran.push("4"); }); // over cap -> drops 2
    t1.release(); await tick();
    expect(ran).toEqual(["3", "4"]);
  });

  test("work enqueued after the queue empties restarts the worker", async () => {
    const inbox = new ChannelInbox({ log: () => {} });
    const ran: string[] = [];
    inbox.enqueue(item("1"), async () => { ran.push("1"); });
    await tick();
    expect(ran).toEqual(["1"]);
    inbox.enqueue(item("2"), async () => { ran.push("2"); });
    await tick();
    expect(ran).toEqual(["1", "2"]);
  });
});
