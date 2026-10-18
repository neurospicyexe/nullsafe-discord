// P3 + P4 (Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md, Raziel's rulings 2 + 3 revised):
// side-aware supersede, no mid-inference drop by default (finish, post, then ONE catch-up turn),
// settle + burst gather by human side, and a hold cap. Fake clock + fake sleep; no real timers.

import {
  ChannelInbox, burstSettleMaxMs, burstSettleScope, resolveInboxSide, supersedeBOn, supersedeSideAwareOn,
  type InboxItem, type TurnContext, type ChannelInboxOpts,
} from "../channel-inbox.js";

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, channelId: "chan-1", authorIsHuman: true, content: `msg ${id}`, authorKey: "raz", side: null, ...over,
});

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

function build(opts: Partial<ChannelInboxOpts> = {}) {
  const c = clock();
  const inbox = new ChannelInbox({ settleMs: 4000, now: c.now, sleep: c.sleep, log: () => {}, ...opts });
  return { c, inbox };
}

describe("env knobs", () => {
  it("SUPERSEDE_SIDE_AWARE defaults on; off/0/false/no turn it off", () => {
    expect(supersedeSideAwareOn({})).toBe(true);
    expect(supersedeSideAwareOn({ SUPERSEDE_SIDE_AWARE: " OFF " })).toBe(false);
    expect(supersedeSideAwareOn({ SUPERSEDE_SIDE_AWARE: "no" })).toBe(false);
    expect(supersedeSideAwareOn({ SUPERSEDE_SIDE_AWARE: "on" })).toBe(true);
  });
  it("SUPERSEDE_B defaults OFF; only on/1/true/yes opens it", () => {
    expect(supersedeBOn({})).toBe(false);
    expect(supersedeBOn({ SUPERSEDE_B: "on" })).toBe(true);
    expect(supersedeBOn({ SUPERSEDE_B: " TRUE " })).toBe(true);
    expect(supersedeBOn({ SUPERSEDE_B: "off" })).toBe(false);
    expect(supersedeBOn({ SUPERSEDE_B: "banana" })).toBe(false);
  });
  it("BURST_SETTLE_SCOPE defaults side; speaker is the old behavior; junk is side", () => {
    expect(burstSettleScope({})).toBe("side");
    expect(burstSettleScope({ BURST_SETTLE_SCOPE: "speaker" })).toBe("speaker");
    expect(burstSettleScope({ BURST_SETTLE_SCOPE: " Speaker " })).toBe("speaker");
    expect(burstSettleScope({ BURST_SETTLE_SCOPE: "zzz" })).toBe("side");
  });
  it("BURST_SETTLE_MAX_MS defaults 20000; 0 or negative = no cap; junk = default", () => {
    expect(burstSettleMaxMs({})).toBe(20000);
    expect(burstSettleMaxMs({ BURST_SETTLE_MAX_MS: "9000" })).toBe(9000);
    expect(burstSettleMaxMs({ BURST_SETTLE_MAX_MS: "0" })).toBe(0);
    expect(burstSettleMaxMs({ BURST_SETTLE_MAX_MS: "-1" })).toBe(0);
    expect(burstSettleMaxMs({ BURST_SETTLE_MAX_MS: "x" })).toBe(20000);
  });
});

describe("resolveInboxSide", () => {
  const roster = {
    identify: (name: string | null | undefined) =>
      name === "Magpie" ? { isOwner: true } : name === "Sora" || name === "Megan" ? { isOwner: false } : null,
  };
  const ids = { ownerDiscordId: "owner-1", blueDiscordId: "blue-1" };
  it("raw author ids", () => {
    expect(resolveInboxSide({ authorId: "owner-1", isWebhook: false, username: "Crash" }, ids, roster)).toBe("raziel");
    expect(resolveInboxSide({ authorId: "blue-1", isWebhook: false, username: "blue" }, ids, roster)).toBe("blue");
  });
  it("a webhook post resolves through the PK roster (all of Blue's members are Blue)", () => {
    expect(resolveInboxSide({ authorId: "wh", isWebhook: true, username: "Magpie" }, ids, roster)).toBe("raziel");
    expect(resolveInboxSide({ authorId: "wh", isWebhook: true, username: "Sora" }, ids, roster)).toBe("blue");
    expect(resolveInboxSide({ authorId: "wh", isWebhook: true, username: "Megan" }, ids, roster)).toBe("blue");
  });
  it("unknown stays null (behaves like today)", () => {
    expect(resolveInboxSide({ authorId: "wh", isWebhook: true, username: "Stranger" }, ids, roster)).toBeNull();
    expect(resolveInboxSide({ authorId: "x", isWebhook: false, username: "guest" }, ids, roster)).toBeNull();
    expect(resolveInboxSide({ authorId: "wh", isWebhook: true, username: "Sora" }, ids, null)).toBeNull();
  });
});

describe("side-aware supersede", () => {
  it("(a) a Raziel message during a Blue reply does not cancel it: the Blue reply posts", async () => {
    const { c, inbox } = build();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const posted: string[] = [];
    inbox.enqueue(item("b1", { side: "blue", authorKey: "w:Sora" }), async (s) => {
      await gate;
      if (s("post")) return;            // the handler's check B
      posted.push("b1");
    });
    await c.advance(4000);              // settled, inferring
    inbox.enqueue(item("r1", { side: "raziel" }), async (s) => { if (!s("pre")) posted.push("r1"); });
    release(); await flush();
    await c.advance(4000);
    expect(posted).toEqual(["b1", "r1"]);
  });

  it("a Raziel message does not supersede a Blue turn that has not started (check A), and vice versa", async () => {
    const { c, inbox } = build();
    const seen: Array<{ id: string; sup: boolean }> = [];
    inbox.enqueue(item("b1", { side: "blue" }), async (s) => { seen.push({ id: "b1", sup: s("pre") }); });
    await c.advance(1000);
    inbox.enqueue(item("r1", { side: "raziel" }), async (s) => { seen.push({ id: "r1", sup: s("pre") }); });
    await c.advance(4000);
    await c.advance(4000);
    expect(seen).toEqual([{ id: "b1", sup: false }, { id: "r1", sup: false }]);
  });

  it("a same-side message supersedes; an unknown side supersedes like today", async () => {
    const { c, inbox } = build();
    const seen: Array<{ id: string; sup: boolean }> = [];
    inbox.enqueue(item("b1", { side: "blue" }), async (s) => { seen.push({ id: "b1", sup: s("pre") }); });
    inbox.enqueue(item("b2", { side: "blue" }), async (s) => { seen.push({ id: "b2", sup: s("pre") }); });
    inbox.enqueue(item("u1", { side: null }), async (s) => { seen.push({ id: "u1", sup: s("pre") }); });
    await c.advance(4000);
    await c.advance(4000);
    expect(seen.map(x => x.id)).toEqual(["b1", "b2", "u1"]);
    expect(seen[0]!.sup).toBe(true);
    expect(seen[1]!.sup).toBe(true);   // u1 (unknown side) supersedes b2
    expect(seen[2]!.sup).toBe(false);
  });

  it("supersedeSideAware=false: any human supersedes (the old rule)", async () => {
    const { c, inbox } = build({ supersedeSideAware: false });
    const seen: boolean[] = [];
    inbox.enqueue(item("b1", { side: "blue" }), async (s) => { seen.push(s("pre")); });
    inbox.enqueue(item("r1", { side: "raziel" }), async (s) => { seen.push(s("pre")); });
    await c.advance(4000);
    await c.advance(4000);
    expect(seen).toEqual([true, false]);
  });

  it("check B is off by default: a same-side message mid-inference does not flip the post probe", async () => {
    const { c, inbox } = build();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const probes: Array<[boolean, boolean]> = [];
    inbox.enqueue(item("1", { side: "blue" }), async (s) => {
      await gate;
      probes.push([s("pre"), s("post")]);
    });
    await c.advance(4000);
    inbox.enqueue(item("2", { side: "blue" }), async () => {});
    release(); await flush();
    expect(probes).toEqual([[true, false]]);    // pre sees the newer message; post does not drop
  });

  it("supersedeB=true restores the old drop: the post probe flips", async () => {
    const { c, inbox } = build({ supersedeB: true });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const probes: boolean[] = [];
    inbox.enqueue(item("1", { side: "blue" }), async (s) => { await gate; probes.push(s("post")); });
    await c.advance(4000);
    inbox.enqueue(item("2", { side: "blue" }), async () => {});
    release(); await flush();
    expect(probes).toEqual([true]);
  });

  it("(c) the in-flight reply posts, then ONE catch-up turn answers the 2 messages that arrived during it, once", async () => {
    const { c, inbox } = build();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const posted: string[] = [];
    const absorbed: string[] = [];
    const ctxs: Record<string, TurnContext> = {};
    // A turn shaped like the handler: absorb when superseded pre-inference, else infer, then check B.
    const turn = (id: string, slow = false) => async (s: (p?: "pre" | "post") => boolean, ctx: TurnContext) => {
      ctxs[id] = ctx;
      if (s("pre")) { absorbed.push(id); return; }
      if (slow) await gate;
      if (s("post")) { absorbed.push(`${id}:dropped`); return; }
      posted.push(id);
    };
    inbox.enqueue(item("m1", { side: "blue", authorKey: "w:Sora" }), turn("m1", true));
    await c.advance(4000);                                   // m1 settled and inferring
    await c.advance(2000);
    inbox.enqueue(item("m2", { side: "blue", authorKey: "w:Sora" }), turn("m2"));
    await c.advance(1000);
    inbox.enqueue(item("m3", { side: "blue", authorKey: "w:Megan" }), turn("m3"));
    release(); await flush();
    expect(posted).toEqual(["m1"]);                          // the in-flight reply finished and posted
    await c.advance(4000);
    expect(posted).toEqual(["m1", "m3"]);                    // one catch-up turn for both
    expect(absorbed).toEqual(["m2"]);                        // m2 absorbed (its STM append happens in absorb)
    expect(ctxs["m3"]!.burst.map(b => b.id)).toEqual(["m2"]);   // covers both, in order; m1 is NOT re-answered
    await c.advance(30000);
    expect(posted).toEqual(["m1", "m3"]);                    // exactly once
  });
});

describe("settle + burst gather by side", () => {
  it("(b) Sora then Megan within settle = one gathered burst (side scope)", async () => {
    const { c, inbox } = build();
    const seen: Array<{ id: string; sup: boolean; burst: string[] }> = [];
    const add = (id: string, key: string) => inbox.enqueue(item(id, { side: "blue", authorKey: key }), async (s, ctx) => {
      seen.push({ id, sup: s("pre"), burst: ctx.burst.map(b => b.id) });
    });
    add("1", "wh:Sora");
    await c.advance(1500);
    add("2", "wh:Megan");
    await c.advance(4000);
    expect(seen).toEqual([
      { id: "1", sup: true, burst: [] },
      { id: "2", sup: false, burst: ["1"] },
    ]);
  });

  it("scope=speaker keeps the old behavior: Megan's turn does not carry Sora's message", async () => {
    const { c, inbox } = build({ settleScope: "speaker" });
    const seen: Array<{ id: string; burst: string[] }> = [];
    const add = (id: string, key: string) => inbox.enqueue(item(id, { side: "blue", authorKey: key }), async (_s, ctx) => {
      seen.push({ id, burst: ctx.burst.map(b => b.id) });
    });
    add("1", "wh:Sora");
    await c.advance(1500);
    add("2", "wh:Megan");
    await c.advance(4000);
    expect(seen).toEqual([{ id: "1", burst: [] }, { id: "2", burst: [] }]);
  });

  it("interleaved Blue + Raziel = two turns; neither supersedes the other and each settles on its own clock", async () => {
    const { c, inbox } = build();
    const seen: Array<{ id: string; sup: boolean; burst: string[]; at: number }> = [];
    const add = (id: string, side: "raziel" | "blue", key: string) => inbox.enqueue(item(id, { side, authorKey: key }), async (s, ctx) => {
      seen.push({ id, sup: s("pre"), burst: ctx.burst.map(b => b.id), at: c.now() });
    });
    add("b1", "blue", "wh:Sora");
    await c.advance(1000);
    add("r1", "raziel", "wh:Magpie");
    await c.advance(1000);
    add("b2", "blue", "wh:Megan");
    await c.advance(10000);
    expect(seen.map(x => x.id).sort()).toEqual(["b1", "b2", "r1"]);
    const by = Object.fromEntries(seen.map(x => [x.id, x]));
    expect(by["b1"]!.sup).toBe(true);                 // superseded by b2 (same side)
    expect(by["r1"]!.sup).toBe(false);                // never cancelled by Blue
    expect(by["b2"]!.sup).toBe(false);
    expect(by["b2"]!.burst).toEqual(["b1"]);
    expect(by["r1"]!.burst).toEqual([]);              // Blue's message is not folded into Raziel's burst
  });

  it("a cross-side message does not extend the settle clock", async () => {
    const { c, inbox } = build();
    const started: string[] = [];
    inbox.enqueue(item("b1", { side: "blue" }), async () => { started.push("b1"); });
    await c.advance(3000);
    inbox.enqueue(item("r1", { side: "raziel" }), async () => { started.push("r1"); });
    await c.advance(1000);                            // b1 settled 4000ms after ITS arrival
    expect(started).toEqual(["b1"]);
  });

  it("(d) a stream of messages <4s apart releases at BURST_SETTLE_MAX_MS, and settleMs stays the configured value", async () => {
    const { c, inbox } = build({ settleMaxMs: 20000 });
    const runs: Array<{ id: string; at: number; settleMs: number; burst: number }> = [];
    const t0 = c.now();
    const add = (id: string) => inbox.enqueue(item(id, { side: "blue", authorKey: `wh:m${id}` }), async (_s, ctx) => {
      runs.push({ id, at: c.now() - t0, settleMs: ctx.settleMs, burst: ctx.burst.length });
    });
    for (let i = 0; i < 9; i++) { add(String(i)); await c.advance(3000); }   // t = 0..24000, never quiet for 4s
    expect(runs.length).toBeGreaterThan(0);
    // The head (message 0) was held until 20000ms after its arrival, not until the stream ended.
    expect(runs[0]!.id).toBe("0");
    // released at the cap (the fake clock steps in 3000s, so the first observation is at 21000), well
    // before the stream's own end at 24000+4000
    expect(runs[0]!.at).toBeGreaterThanOrEqual(20000);
    expect(runs[0]!.at).toBeLessThan(24000);
    expect(runs[0]!.settleMs).toBe(4000);
    await c.advance(40000);
    // Everything was eventually answered; nobody starved.
    expect(new Set(runs.map(r => r.id)).size).toBe(9);
  });

  it("with the cap disabled (0) the stream holds until it goes quiet", async () => {
    const { c, inbox } = build({ settleMaxMs: 0 });
    const runs: string[] = [];
    for (let i = 0; i < 9; i++) {
      inbox.enqueue(item(String(i), { side: "blue" }), async () => { runs.push(String(i)); });
      await c.advance(3000);
    }
    expect(runs).toEqual([]);
    await c.advance(4000);
    expect(runs.length).toBe(9);
  });
});
