import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  VisionCache, VisionPrefetch, describeImagesCached, resolveSeenImages,
  type VisionRedis,
} from "../vision-cache.js";
import type { ImageLike } from "../vision.js";
import { createHash } from "node:crypto";

// -- fakes ------------------------------------------------------------------------------------

function fakeRedis(clock: { t: number }) {
  const store = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return undefined;
    if (e.exp <= clock.t) { store.delete(k); return undefined; }
    return e;
  };
  const r = {
    store,
    broken: false,
    async get(k: string) { if (r.broken) throw new Error("redis down"); return live(k)?.v ?? null; },
    async set(k: string, v: string, ...args: Array<string | number>) {
      if (r.broken) throw new Error("redis down");
      const nx = args.includes("NX");
      if (nx && live(k)) return null;
      let exp = Number.POSITIVE_INFINITY;
      const px = args.indexOf("PX"); const ex = args.indexOf("EX");
      if (px >= 0) exp = clock.t + Number(args[px + 1]);
      if (ex >= 0) exp = clock.t + Number(args[ex + 1]) * 1000;
      store.set(k, { v, exp });
      return "OK";
    },
    async del(k: string) { if (r.broken) throw new Error("redis down"); store.delete(k); return 1; },
  };
  return r satisfies VisionRedis & { store: Map<string, unknown>; broken: boolean };
}

/** fetch stub: image URLs return bytes keyed by url; DeepInfra returns a counted description. */
function fakeNet(opts: { bytesFor?: (url: string) => number; vlDelayMs?: number; vlFail?: () => boolean } = {}) {
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
      if (opts.vlFail?.()) return { ok: false, status: 500 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "a calm harbor at dusk" }, finish_reason: "stop" }] }) } as unknown as Response;
    }
    stats.downloads++;
    const n = opts.bytesFor ? opts.bytesFor(u) : 7;
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new Uint8Array(32).fill(n).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, stats, hold, release: () => release() };
}

const img = (id: string, url = `https://cdn.discordapp.com/attachments/1/${id}/pic.png?hm=sig${id}`): ImageLike =>
  ({ id, url, name: "pic.png", contentType: "image/png" });

const mk = (companionId: string, redis: VisionRedis | null, net: { fetchFn: typeof fetch }, clock = { t: 1_000_000 }) =>
  new VisionCache({ companionId, redis, apiKey: () => "k", fetchFn: net.fetchFn, pollMs: 5, now: () => clock.t, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });

beforeEach(() => {
  delete process.env["VISION_CACHE"];
  delete process.env["VISION_CACHE_TTL_S"];
  delete process.env["VISION_NEG_TTL_S"];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("VisionCache", () => {
  it("(a) two concurrent calls in one process make one VL request", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet({ vlDelayMs: 20 });
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const [x, y] = await Promise.all([c.describe(img("1")), c.describe(img("1"))]);
    expect(x).toBe("a calm harbor at dusk");
    expect(y).toBe(x);
    expect(net.stats.vl).toBe(1);
    expect(net.stats.downloads).toBe(1);
  });

  it("hit: a later call on the same attachment makes no download and no VL request", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const c = mk("drevan", fakeRedis(clock), net, clock);
    await c.describe(img("1"));
    await c.describe(img("1"));
    expect(net.stats).toEqual({ vl: 1, downloads: 1 });
  });

  it("2026-10-18 shape: describe once, the turn is superseded, the retry reuses it (zero new requests)", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet({ vlDelayMs: 30 });
    const redis = fakeRedis(clock);
    const c = mk("drevan", redis, net, clock);
    const pf = new VisionPrefetch();
    pf.start("M1", [img("9")], c); // arrival
    // Turn 1 reaches the vision step already superseded: no wait, no new VL call.
    const t1 = await resolveSeenImages({ messageId: "M1", picked: [img("9")], cache: c, prefetch: pf, budgetMs: 20_000, isSuperseded: () => true });
    expect(t1[0]!.description).toBeNull();
    // Turn 2 (retry, a different message carrying the same attachment) waits on the SAME describe.
    const t2 = await resolveSeenImages({ messageId: "M2", picked: [img("9")], cache: c, prefetch: pf, budgetMs: 20_000, isSuperseded: () => false });
    expect(t2[0]!.description).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
  });

  it("(c) three bots (three caches, one Redis) racing make one VL request", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet({ vlDelayMs: 25 });
    const redis = fakeRedis(clock);
    const bots = ["cypher", "drevan", "gaia"].map((n) => mk(n, redis, net, clock));
    const out = await Promise.all(bots.map((b) => b.describe(img("5"))));
    expect(out).toEqual(["a calm harbor at dusk", "a calm harbor at dusk", "a calm harbor at dusk"]);
    expect(net.stats.vl).toBe(1);
  });

  it("(d) two attachment ids with identical bytes (a PluralKit re-upload) make one VL request", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const redis = fakeRedis(clock);
    const a = mk("drevan", redis, net, clock);
    const b = mk("cypher", redis, net, clock);
    await a.describe(img("100", "https://cdn/orig.png"));
    const second = await b.describe(img("200", "https://cdn/reupload.png"));
    expect(second).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
  });

  it("(e) negative cache: a failure is not retried inside the negative TTL, one fresh attempt after it", async () => {
    const clock = { t: 1_000_000 };
    let fail = true;
    const net = fakeNet({ vlFail: () => fail });
    const redis = fakeRedis(clock);
    const bot = (n: string) => mk(n, redis, net, clock);
    expect(await bot("drevan").describe(img("7"))).toBeNull();
    expect(net.stats.vl).toBe(1);
    // A fresh process (empty L0) inside the window: the Redis negative key answers.
    expect(await bot("drevan").describe(img("7"))).toBeNull();
    expect(net.stats.vl).toBe(1);
    clock.t += 121_000;
    fail = false;
    expect(await bot("drevan").describe(img("7"))).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(2);
  });

  it("(f) the lock owner dies: a waiter takes over, once", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const redis = fakeRedis(clock);
    const sha = createHash("sha256").update(Buffer.alloc(32, 7)).digest("hex");
    await redis.set(`ns:vision:lock:${sha}`, "dead-bot", "PX", 90_000, "NX");
    const w1 = mk("cypher", redis, net, clock);
    const w2 = mk("gaia", redis, net, clock);
    const both = Promise.all([w1.describe(img("3")), w2.describe(img("3"))]);
    setTimeout(() => redis.store.delete(`ns:vision:lock:${sha}`), 30); // the lock vanishes, no result
    const out = await both;
    expect(out).toEqual(["a calm harbor at dusk", "a calm harbor at dusk"]);
    expect(net.stats.vl).toBe(1);
  });

  it("(g) Redis throwing falls back to a direct call and still returns", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const redis = fakeRedis(clock);
    redis.broken = true;
    const c = mk("drevan", redis, net, clock);
    expect(await c.describe(img("4"))).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
  });

  it("no Redis configured: still one VL call per process via L0", async () => {
    const net = fakeNet({ vlDelayMs: 10 });
    const c = mk("drevan", null, net);
    await Promise.all([c.describe(img("8")), c.describe(img("8"))]);
    expect(net.stats.vl).toBe(1);
  });

  it("VISION_CACHE=off is the old behavior: every call describes", async () => {
    process.env["VISION_CACHE"] = "off";
    const net = fakeNet();
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    await c.describe(img("1")); await c.describe(img("1"));
    expect(net.stats.vl).toBe(2);
  });

  it("logs ids and counts, never the CDN url or the description text", async () => {
    const net = fakeNet();
    const logs: string[] = [];
    (console.log as jest.Mock).mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    await c.describe(img("11"));
    await c.describe(img("11"));
    const joined = logs.join("\n");
    expect(joined).toMatch(/\[vision-cache\] drevan miss ms=\d+/);
    expect(joined).toMatch(/\[vision-cache\] drevan hit ms=\d+/);
    expect(joined).not.toMatch(/hm=|cdn\.discordapp|harbor/);
  });

  it("the model id is part of the cache keys (a VISION_MODEL change never serves old text)", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    const redis = fakeRedis(clock);
    const mkModel = (m: string) => new VisionCache({ companionId: "d", redis, apiKey: () => "k", model: () => m, fetchFn: net.fetchFn, pollMs: 5, now: () => clock.t });
    await mkModel("m1").describe(img("1"));
    await mkModel("m2").describe(img("1"));
    expect(net.stats.vl).toBe(2);
  });
});

describe("resolveSeenImages (P2)", () => {
  it("budget timeout -> not seen; the detached describe still lands in the cache for the next turn", async () => {
    const clock = { t: 1_000_000 };
    const net = fakeNet();
    net.hold();
    const c = mk("drevan", fakeRedis(clock), net, clock);
    const pf = new VisionPrefetch();
    const t0 = Date.now();
    const out = await resolveSeenImages({
      messageId: "M1", picked: [img("20")], cache: c, prefetch: pf, budgetMs: 60, isSuperseded: () => false,
      now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), superseedCheckMs: 20,
    });
    expect(out).toEqual([{ name: "pic.png", description: null }]);
    expect(Date.now() - t0).toBeLessThan(400);
    net.release();
    await pf.get("M1");
    expect(await c.peek(img("20"))).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
    // The next turn finds it with no new VL call.
    const next = await resolveSeenImages({ messageId: "M2", picked: [img("20")], cache: c, prefetch: pf, budgetMs: 60, isSuperseded: () => false });
    expect(next[0]!.description).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
  });

  it("a superseded turn never waits and never starts a VL call", async () => {
    const net = fakeNet({ vlDelayMs: 5_000 });
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    const t0 = Date.now();
    const out = await resolveSeenImages({ messageId: "M1", picked: [img("30")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 20_000, isSuperseded: () => true });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(out[0]!.description).toBeNull();
    expect(net.stats.vl).toBe(0);
  });

  it("a superseded turn uses whatever the cache already holds", async () => {
    const net = fakeNet();
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    await c.describe(img("31"));
    const out = await resolveSeenImages({ messageId: "M1", picked: [img("31")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 20_000, isSuperseded: () => true });
    expect(out[0]!.description).toBe("a calm harbor at dusk");
  });

  it("a turn superseded mid-wait stops waiting", async () => {
    const net = fakeNet();
    net.hold();
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    let sup = false;
    setTimeout(() => { sup = true; }, 40);
    const t0 = Date.now();
    const out = await resolveSeenImages({
      messageId: "M1", picked: [img("32")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 20_000,
      isSuperseded: () => sup, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), superseedCheckMs: 15,
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out[0]!.description).toBeNull();
    net.release();
  });

  it("budget 0 waits for the whole describe (old behavior)", async () => {
    const net = fakeNet({ vlDelayMs: 80 });
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    const out = await resolveSeenImages({ messageId: "M1", picked: [img("33")], cache: c, prefetch: new VisionPrefetch(), budgetMs: 0, isSuperseded: () => false, superseedCheckMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    expect(out[0]!.description).toBe("a calm harbor at dusk");
  });

  it("a prefetch started at arrival is what the turn awaits (no second describe)", async () => {
    const net = fakeNet({ vlDelayMs: 20 });
    const c = mk("drevan", fakeRedis({ t: 1 }), net);
    const pf = new VisionPrefetch();
    pf.start("M1", [img("34")], c);
    const out = await resolveSeenImages({ messageId: "M1", picked: [img("34")], cache: c, prefetch: pf, budgetMs: 5_000, isSuperseded: () => false });
    expect(out[0]!.description).toBe("a calm harbor at dusk");
    expect(net.stats.vl).toBe(1);
  });

  it("describeImagesCached keeps arrival order and safe names", async () => {
    const net = fakeNet({ bytesFor: (u) => (u.includes("/a/") ? 1 : 2) });
    const c = mk("drevan", null, net);
    const out = await describeImagesCached([img("1", "https://cdn/a/x.png"), { ...img("2", "https://cdn/b/y.png"), name: "y.png" }], c);
    expect(out.map((o) => o.name)).toEqual(["pic.png", "y.png"]);
    expect(net.stats.vl).toBe(2);
  });
});
