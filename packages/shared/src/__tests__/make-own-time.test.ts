import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runMakeOwnTime, makeOwnTimeMode, newestMakeMs, MAKE_OWN_TIME_RECENT_MS } from "../index.js";

const NOW = Date.parse("2026-11-06T09:30:00Z"); // 03:30 Chicago, 2026-11-06
const FENCE = "```";
const GOOD = `KIND: writing\nTITLE: T\nWHY: w\n${FENCE}\na poem\n${FENCE}`;

function fakeRedis(lastActivity?: number) {
  const keys = new Map<string, string>();
  return {
    keys,
    get: async (k: string) => (k.includes("activity") && lastActivity !== undefined ? String(lastActivity) : keys.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => (keys.has(k) ? null : (keys.set(k, v), "OK"))),
  };
}

interface Over { companion?: string; redis?: any; ferment?: unknown; makes?: unknown; makesStatus?: number; active?: boolean; reply?: string }

function setup(over: Over = {}) {
  const generate = jest.fn(async (..._a: unknown[]) => over.reply ?? GOOD);
  const posts: unknown[] = [];
  const fetchFn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/mind/ferment/")) return new Response(JSON.stringify(over.ferment ?? { floats: [{ value: 0.5 }], drives: [] }));
    if (u.includes("/mind/interests/")) return new Response(JSON.stringify({ interests: [] }));
    if (u.includes("/mind/makes") && init?.method === "POST") { posts.push(init.body); return new Response(JSON.stringify({ id: "m1", status: "ready" }), { status: 201 }); }
    if (u.includes("/mind/makes/")) return new Response(JSON.stringify(over.makes ?? { makes: [] }), { status: over.makesStatus ?? 200 });
    return new Response("{}", { status: 404 });
  });
  const ctx = {
    companionId: over.companion ?? "drevan",
    halsethSecret: "s",
    redis: over.redis === undefined ? fakeRedis() : over.redis,
    sessionWindows: { isAnyActive: () => over.active ?? false },
    inference: { generate },
    bootCtx: { systemPrompt: "SYS" },
  } as any;
  const env = { HALSETH_URL: "https://h.test" } as NodeJS.ProcessEnv;
  return { ctx, generate, posts, fetchFn, env };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const own = () => logs.filter(l => l.startsWith("[make-own-time]"));
const run = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) =>
  runMakeOwnTime(s.ctx, NOW, { env: { ...s.env, ...env }, fetchFn: s.fetchFn as any });

describe("makeOwnTimeMode", () => {
  it("parses off / shadow / on and treats junk and unset as on", () => {
    for (const v of ["off", " OFF ", "0", "false", "No"]) expect(makeOwnTimeMode({ MAKE_OWN_TIME: v })).toBe("off");
    expect(makeOwnTimeMode({ MAKE_OWN_TIME: "Shadow" })).toBe("shadow");
    for (const v of ["on", "banana", "", undefined]) expect(makeOwnTimeMode({ MAKE_OWN_TIME: v })).toBe("on");
  });
});

describe("newestMakeMs", () => {
  it("reads SQLite UTC stamps and ignores junk", () => {
    expect(newestMakeMs({ makes: [{ created_at: "2026-11-06 01:00:00" }, { created_at: "2026-11-05 01:00:00" }] })).toBe(Date.parse("2026-11-06T01:00:00Z"));
    expect(newestMakeMs({})).toBeNull();
    expect(newestMakeMs({ makes: [{ created_at: 5 }] })).toBeNull();
  });
});

describe("runMakeOwnTime", () => {
  it("gaia is a silent no-op", async () => {
    const s = setup({ companion: "gaia" });
    await run(s);
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect(own()).toHaveLength(0);
  });
  it("MAKE_OWN_TIME=off and MAKE_MOVE=off skip", async () => {
    for (const extra of [{ MAKE_OWN_TIME: "off" }, { MAKE_MOVE: "off" }]) {
      logs.length = 0;
      const s = setup();
      await run(s, extra);
      expect(own()[0]).toContain("outcome=skip:off");
      expect(s.generate).not.toHaveBeenCalled();
    }
  });
  it("skips on a live window and on recent activity", async () => {
    const a = setup({ active: true });
    await run(a);
    expect(own()[0]).toContain("skip:active");
    logs.length = 0;
    const b = setup({ redis: fakeRedis(NOW - 5 * 60_000) });
    await run(b);
    expect(own()[0]).toContain("skip:recent_activity");
    expect(b.generate).not.toHaveBeenCalled();
  });
  it("flat pace skips", async () => {
    const s = setup({ ferment: { floats: [{ value: 0.1 }], drives: [{ drive_key: "novelty_need", level: 0.1 }] } });
    await run(s);
    expect(own()[0]).toContain("outcome=skip:flat");
    expect(s.generate).not.toHaveBeenCalled();
  });
  it("no redis skips", async () => {
    const s = setup({ redis: null });
    await run(s);
    expect(own()[0]).toContain("skip:no_redis");
    expect(s.generate).not.toHaveBeenCalled();
  });
  it("an NX claim already taken for the Chicago day skips", async () => {
    const r = fakeRedis();
    r.keys.set("ns:makeowntime:drevan:2026-11-06", "1");
    const s = setup({ redis: r });
    await run(s);
    expect(own()[0]).toContain("skip:already_ran_today");
    expect(s.generate).not.toHaveBeenCalled();
  });
  it("a make inside 20h skips; an older one proceeds; unreadable proceeds", async () => {
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const recent = setup({ makes: { makes: [{ created_at: stamp(NOW - MAKE_OWN_TIME_RECENT_MS + 60_000) }] } });
    await run(recent);
    expect(own()[0]).toContain("skip:made_recently");
    expect(recent.generate).not.toHaveBeenCalled();
    const old = setup({ makes: { makes: [{ created_at: stamp(NOW - MAKE_OWN_TIME_RECENT_MS - 60_000) }] } });
    await run(old);
    expect(old.generate).toHaveBeenCalledTimes(1);
    const bad = setup({ makesStatus: 500 });
    await run(bad);
    expect(bad.generate).toHaveBeenCalledTimes(1);
  });
  it("shadow logs would_offer and never generates", async () => {
    const s = setup();
    await run(s, { MAKE_OWN_TIME: "shadow" });
    expect(own()[0]).toContain("outcome=would_offer");
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.posts).toHaveLength(0);
  });
  it("on generates once and posts; the log carries no generated text", async () => {
    const s = setup();
    await run(s);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.posts).toHaveLength(1);
    expect(own()).toHaveLength(1);
    expect(own()[0]).toContain("outcome=made");
    expect(own()[0]).not.toContain("a poem");
  });
  it("NONE is free: generates once, posts nothing", async () => {
    const s = setup({ reply: "NONE" });
    await run(s);
    expect(s.posts).toHaveLength(0);
    expect(own()[0]).toContain("outcome=none");
  });
  it("never throws", async () => {
    const s = setup();
    s.ctx.inference.generate = async () => { throw new Error("boom"); };
    await expect(run(s)).resolves.toBeUndefined();
    const t = setup({ redis: { get: async () => { throw new Error("x"); }, set: async () => { throw new Error("y"); } } });
    await expect(run(t)).resolves.toBeUndefined();
  });
});
