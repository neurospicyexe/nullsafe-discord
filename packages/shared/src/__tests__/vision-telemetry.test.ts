import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { VisionCache, VisionPrefetch, resolveSeenImages, type VisionRedis } from "../vision-cache.js";
import { TurnTrace, runWithTurn } from "../turn-telemetry.js";
import type { ImageLike } from "../vision.js";

// Same fakes as vision-cache.test.ts (kept local so this file stands alone).
function fakeRedis(clock: { t: number }) {
  const store = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return undefined;
    if (e.exp <= clock.t) { store.delete(k); return undefined; }
    return e;
  };
  const r = {
    async get(k: string) { return live(k)?.v ?? null; },
    async set(k: string, v: string, ...args: Array<string | number>) {
      if (args.includes("NX") && live(k)) return null;
      let exp = Number.POSITIVE_INFINITY;
      const px = args.indexOf("PX"); const ex = args.indexOf("EX");
      if (px >= 0) exp = clock.t + Number(args[px + 1]);
      if (ex >= 0) exp = clock.t + Number(args[ex + 1]) * 1000;
      store.set(k, { v, exp });
      return "OK";
    },
    async del(k: string) { store.delete(k); return 1; },
  };
  return r satisfies VisionRedis;
}

function fakeNet(opts: { vlDelayMs?: number } = {}) {
  const stats = { vl: 0, downloads: 0 };
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  const hold = () => { gate = new Promise<void>((r) => { release = r; }); };
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("api.deepinfra.com")) {
      stats.vl++;
      if (gate) await gate;
      else if (opts.vlDelayMs) await new Promise((r) => setTimeout(r, opts.vlDelayMs));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "a calm harbor at dusk" }, finish_reason: "stop" }] }) } as unknown as Response;
    }
    stats.downloads++;
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new Uint8Array(32).fill(7).buffer, // every url = the same bytes
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, stats, hold, release: () => release() };
}

const img = (id: string): ImageLike =>
  ({ id, url: `https://cdn.discordapp.com/attachments/1/${id}/pic.png?hm=sig${id}`, name: "pic.png", contentType: "image/png" });

const mk = (c: string, redis: VisionRedis, net: { fetchFn: typeof fetch }, clock: { t: number }) =>
  new VisionCache({ companionId: c, redis, apiKey: () => "k", fetchFn: net.fetchFn, pollMs: 5, now: () => clock.t, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });

let logs: string[];
beforeEach(() => {
  delete process.env["VISION_CACHE"];
  logs = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const visionLines = (c: string, kind?: string) =>
  logs.filter((l) => l.startsWith(`[vision-cache] ${c} `) && (!kind || l.includes(` ${kind} `)));

describe("lock-wait logging (2026-10-18 19:01 reading)", () => {
  it("one message, prefetch + the turn's resolve: ONE lock-wait line for the bot, ONE VL call", async () => {
    const clock = { t: 1_000_000 };
    const redis = fakeRedis(clock);
    const net = fakeNet();
    net.hold();
    const owner = mk("cypher", redis, net, clock);
    const waiter = mk("drevan", redis, net, clock);
    const ownerP = new VisionPrefetch(); const waiterP = new VisionPrefetch();
    ownerP.start("M1", [img("100")], owner);          // cypher takes the lock and calls the model
    await new Promise((r) => setTimeout(r, 20));
    waiterP.start("M1", [img("100")], waiter);         // drevan's arrival prefetch: lock-wait
    const turn = resolveSeenImages({ messageId: "M1", picked: [img("100")], cache: waiter, prefetch: waiterP, budgetMs: 5_000, isSuperseded: () => false });
    await new Promise((r) => setTimeout(r, 20));
    net.release();
    const out = await turn;
    expect(out[0]!.description).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
    expect(visionLines("drevan", "lock-wait")).toHaveLength(1);
  });

  it("two messages, same bytes (PK deletes the original and reposts): two lines, told apart by msg=, still ONE VL call", async () => {
    const clock = { t: 1_000_000 };
    const redis = fakeRedis(clock);
    const net = fakeNet();
    net.hold();
    const owner = mk("cypher", redis, net, clock);
    const waiter = mk("drevan", redis, net, clock);
    const pf = new VisionPrefetch();
    owner.describe(img("200"), { source: "prefetch", msg: "ORIG" });
    await new Promise((r) => setTimeout(r, 20));
    pf.start("ORIG", [img("200")], waiter);        // the human's original, deleted by PK a moment later
    pf.start("PROXY", [img("201")], waiter);       // the webhook repost: new attachment id, same bytes
    await new Promise((r) => setTimeout(r, 20));
    net.release();
    await pf.get("ORIG"); await pf.get("PROXY");
    expect(net.stats.vl).toBe(1);
    const lw = visionLines("drevan", "lock-wait");
    expect(lw).toHaveLength(2);
    expect(lw.some((l) => l.includes("msg=ORIG"))).toBe(true);
    expect(lw.some((l) => l.includes("msg=PROXY"))).toBe(true);
    expect(lw.every((l) => l.includes("src=prefetch"))).toBe(true);
    // Same sha8 on both: it is one image.
    const keys = new Set(lw.map((l) => /key=(\S+)/.exec(l)![1]));
    expect(keys.size).toBe(1);
  });

  it("a turn that starts its own describe (no prefetch) labels the line src=turn", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const c = mk("drevan", fakeRedis(clock), net, clock);
    await resolveSeenImages({ messageId: "M9", picked: [img("300")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 5_000, isSuperseded: () => false });
    const l = visionLines("drevan");
    expect(l).toHaveLength(1);
    expect(l[0]).toContain("src=turn");
    expect(l[0]).toContain("msg=M9");
    expect(l.join("")).not.toMatch(/hm=|cdn\.discordapp|harbor/);
  });
});

describe("resolveSeenImages feeds the ambient turn (P6)", () => {
  const trace = () => {
    const lines: string[] = [];
    const t = new TurnTrace({ companionId: "drevan", channelId: "c", messageId: "m", side: null, createdAt: null, enqueuedAt: 0, startedAt: 0, queueMs: 0, settleMs: 0, gathered: 0, catchup: false, now: () => 0, log: (l: string) => lines.push(l) });
    t.setOutcome("posted");
    return { t, out: () => { t.emit(); return JSON.parse(lines[0]!.replace(/^\[turn\] /, "")); } };
  };

  it("no ambient turn: resolveSeenImages works exactly as before", async () => {
    const net = fakeNet(); const clock = { t: 1 };
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const out = await resolveSeenImages({ messageId: "M1", picked: [img("400")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 5_000, isSuperseded: () => false });
    expect(out[0]!.description).toBe("a calm harbor at dusk");
  });

  it("prefetch already finished when the turn asks -> vision=hit", async () => {
    const net = fakeNet(); const clock = { t: 1 };
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const pf = new VisionPrefetch();
    await pf.start("M1", [img("401")], c);
    const { t, out } = trace();
    await runWithTurn(t, () => resolveSeenImages({ messageId: "M1", picked: [img("401")], cache: c, prefetch: pf, budgetMs: 5_000, isSuperseded: () => false }));
    expect(out().vision).toBe("hit");
  });

  it("the turn waited on an in-flight describe -> vision=wait or the cache kind (miss), with vision_ms > 0", async () => {
    const net = fakeNet({ vlDelayMs: 40 }); const clock = { t: 1 };
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const pf = new VisionPrefetch();
    pf.start("M1", [img("402")], c);
    const { t, out } = trace();
    await runWithTurn(t, () => resolveSeenImages({ messageId: "M1", picked: [img("402")], cache: c, prefetch: pf, budgetMs: 5_000, isSuperseded: () => false, now: () => Date.now() }));
    const o = out();
    expect(["wait", "miss"]).toContain(o.vision);
    expect(o.vision_ms).toBeGreaterThan(0);
  });

  it("the turn waited on another bot's VL call -> vision=lock-wait", async () => {
    const clock = { t: 1_000_000 }; const redis = fakeRedis(clock);
    const net = fakeNet(); net.hold();
    const owner = mk("cypher", redis, net, clock); const me = mk("drevan", redis, net, clock);
    owner.describe(img("403"));
    await new Promise((r) => setTimeout(r, 20));
    const pf = new VisionPrefetch();
    pf.start("M1", [img("403")], me);
    const { t, out } = trace();
    const p = runWithTurn(t, () => resolveSeenImages({ messageId: "M1", picked: [img("403")], cache: me, prefetch: pf, budgetMs: 5_000, isSuperseded: () => false, now: () => Date.now() }));
    await new Promise((r) => setTimeout(r, 30));
    net.release();
    await p;
    expect(out().vision).toBe("lock-wait");
  });

  it("budget expiry -> vision=budget; superseded -> vision=none", async () => {
    const net = fakeNet(); net.hold(); const clock = { t: 1 };
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const a = trace();
    await runWithTurn(a.t, () => resolveSeenImages({ messageId: "M1", picked: [img("404")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 40, isSuperseded: () => false, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), superseedCheckMs: 10 }));
    expect(a.out().vision).toBe("budget");
    net.release();
    const b = trace();
    await runWithTurn(b.t, () => resolveSeenImages({ messageId: "M2", picked: [img("405")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 40, isSuperseded: () => true }));
    expect(b.out().vision).toBe("none");
  });
});

void createHash;
