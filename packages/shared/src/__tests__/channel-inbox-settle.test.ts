// Burst settle (BURST_SETTLE_MS, 2026-10-10): a ~4s window that gathers consecutive human messages
// and answers them as ONE turn. Deterministic: a fake clock + fake sleep, no real timers.

import { ChannelInbox, burstSettleMs, type InboxItem, type TurnContext } from "../channel-inbox.js";

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, channelId: "chan-1", authorIsHuman: true, content: `msg ${id}`, authorKey: "raz", ...over,
});

/** A manual clock. sleep(ms) advances nothing by itself; the test calls advance(). */
function clock() {
  let t = 1_000_000;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>(resolve => { waiters.push({ at: t + ms, resolve }); }),
    async advance(ms: number) {
      t += ms;
      for (const w of waiters.splice(0)) {
        if (w.at <= t) w.resolve(); else waiters.push(w);
      }
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r)); };

type Started = { id: string; superseded: boolean; ctx: TurnContext };

function harness(settleMs: number, isCommandShaped?: (c: string) => boolean) {
  const c = clock();
  const started: Started[] = [];
  const inbox = new ChannelInbox({ settleMs, now: c.now, sleep: c.sleep, log: () => {}, ...(isCommandShaped ? { isCommandShaped } : {}) });
  const add = (it: InboxItem) => inbox.enqueue(it, async (isSuperseded, ctx) => {
    started.push({ id: it.id, superseded: isSuperseded(), ctx });
  });
  return { c, inbox, started, add };
}

describe("burstSettleMs", () => {
  it("defaults to 4000; 0 disables; junk and negatives are safe", () => {
    expect(burstSettleMs({})).toBe(4000);
    expect(burstSettleMs({ BURST_SETTLE_MS: "0" })).toBe(0);
    expect(burstSettleMs({ BURST_SETTLE_MS: " 2500 " })).toBe(2500);
    expect(burstSettleMs({ BURST_SETTLE_MS: "abc" })).toBe(4000);
    expect(burstSettleMs({ BURST_SETTLE_MS: "-5" })).toBe(0);
  });
});

describe("ChannelInbox burst settle", () => {
  it("a lone human message waits the full window, then runs as a settled turn", async () => {
    const { c, started, add } = harness(4000);
    add(item("1"));
    await flush();
    expect(started).toHaveLength(0);
    await c.advance(3999); expect(started).toHaveLength(0);
    await c.advance(1);
    expect(started.map(s => s.id)).toEqual(["1"]);
    expect(started[0]!.ctx.settleMs).toBe(4000);
    expect(started[0]!.ctx.burst).toEqual([]);
  });

  it("two messages inside the window become ONE turn: the first is superseded, the last carries the burst", async () => {
    const { c, started, add } = harness(4000);
    add(item("1", { content: "Dre, are you up" }));
    await c.advance(3000);
    add(item("2", { content: "also the other thing" }));
    await c.advance(3999);                         // 1 would have fired at 4000; the window was extended
    expect(started).toHaveLength(0);
    await c.advance(1);                            // 4000ms after message 2
    expect(started.map(s => s.id)).toEqual(["1", "2"]);
    expect(started[0]!.superseded).toBe(true);     // absorb only; no reply
    expect(started[1]!.superseded).toBe(false);    // the one that answers
    expect(started[1]!.ctx.burst.map(b => b.id)).toEqual(["1"]);
    expect(started[1]!.ctx.burst[0]!.content).toBe("Dre, are you up");
    expect(started[1]!.ctx.settleMs).toBe(4000);
  });

  it("the burst ends when a turn is not superseded: the next message starts clean", async () => {
    const { c, started, add } = harness(1000);
    add(item("1")); await c.advance(1000);
    add(item("2")); await c.advance(1000);
    expect(started.map(s => s.id)).toEqual(["1", "2"]);
    expect(started[1]!.ctx.burst).toEqual([]);
  });

  it("only the same speaker's earlier messages are gathered", async () => {
    const { c, started, add } = harness(1000);
    add(item("1", { authorKey: "blue" }));
    await c.advance(300);
    add(item("2", { authorKey: "raz" }));
    await c.advance(1000);
    expect(started[1]!.id).toBe("2");
    expect(started[1]!.ctx.burst).toEqual([]);
  });

  it("a command-shaped message never starts the clock: it runs at once", async () => {
    const { started, add, c } = harness(4000, (t) => /^cy:/i.test(t));
    add(item("1", { content: "cy: model flash-di" }));
    await flush();
    expect(started.map(s => s.id)).toEqual(["1"]);
    expect(started[0]!.ctx.settleMs).toBe(0);
    await c.advance(0);
  });

  it("a command queued behind a settling message cuts the window short (commands stay instant)", async () => {
    const { c, started, add } = harness(4000, (t) => /^dre:/i.test(t));
    add(item("1", { content: "hello there" }));
    await c.advance(500);
    add(item("2", { content: "dre: movie pause" }));
    await c.advance(1);
    await flush();
    expect(started.map(s => s.id)).toEqual(["1", "2"]);
    expect(started[0]!.superseded).toBe(false);    // a command never supersedes the conversational reply
  });

  it("Sol / companion bot posts (authorIsHuman=false) neither start nor restart the clock", async () => {
    const { c, started, add } = harness(4000);
    add(item("sol", { authorIsHuman: false }));
    await flush();
    expect(started.map(s => s.id)).toEqual(["sol"]);          // instant
    add(item("1")); await c.advance(2000);
    add(item("bot", { authorIsHuman: false }));                // would restart the window if it counted
    await c.advance(2000);
    expect(started.map(s => s.id)).toEqual(["sol", "1", "bot"]);   // 1 fired 4000ms after ITS arrival
  });

  it("BURST_SETTLE_MS=0 is the old behavior exactly: instant start, no settle, empty burst", async () => {
    const { started, add } = harness(0);
    add(item("1"));
    await flush();
    expect(started.map(s => s.id)).toEqual(["1"]);
    expect(started[0]!.ctx).toEqual({ settleMs: 0, burst: [] });
    add(item("2"));
    await flush();
    expect(started[1]!.ctx.burst).toEqual([]);
  });

  it("a message arriving mid-inference supersedes the running turn and the next one carries it in its burst", async () => {
    const c = clock();
    const inbox = new ChannelInbox({ settleMs: 1000, now: c.now, sleep: c.sleep, log: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const seen: Started[] = [];
    inbox.enqueue(item("1"), async (s, ctx) => { await gate; seen.push({ id: "1", superseded: s(), ctx }); });
    await c.advance(1000);                          // settle done, turn 1 now "inferring"
    inbox.enqueue(item("2"), async (s, ctx) => { seen.push({ id: "2", superseded: s(), ctx }); });
    release(); await flush();
    expect(seen[0]).toMatchObject({ id: "1", superseded: true });
    await c.advance(1000);
    expect(seen[1]!.ctx.burst.map(b => b.id)).toEqual(["1"]);
  });
});
