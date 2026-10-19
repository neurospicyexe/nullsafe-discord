import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  readFactsPickMode, readFactsPickTheta, readFactsPickK, pickFacts, factsSeenKey,
  __resetFactsPickWarnings, type FactsPickRedis,
} from "../facts-pick.js";
import { hermesDelta } from "../prompt-assembly.js";

const env = (o: Record<string, string> = {}) =>
  ({ HALSETH_URL: "https://h.test", HALSETH_SECRET: "s3cret", ...o }) as unknown as NodeJS.ProcessEnv;

const FACTS = Array.from({ length: 8 }, (_, i) => ({
  id: `fact${i}`, category: i % 2 ? "health" : "home", status: "active", score: 0.9 - i * 0.05, fact: `SECRETFACT-${i}`,
}));

function fakeFetch(opts: {
  items?: unknown[]; shortStatus?: number; jevStatus?: number; jevAnswers?: Record<string, number | undefined>;
  jevHang?: boolean; shortHang?: boolean;
} = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body as string | undefined });
    if (u.includes("/identity/architect-facts/shortlist")) {
      if (opts.shortHang) return new Promise<Response>(() => {});
      if (opts.shortStatus && opts.shortStatus !== 200) return new Response("x", { status: opts.shortStatus });
      return new Response(JSON.stringify({ items: opts.items ?? FACTS, model: "m" }), { status: 200 });
    }
    if (u.endsWith("/admin/jev")) {
      if (opts.jevHang) return new Promise<Response>(() => {});
      if (opts.jevStatus && opts.jevStatus !== 200) return new Response("bad", { status: opts.jevStatus });
      const answers: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(opts.jevAnswers ?? {})) if (v !== undefined) answers[k] = { type: "noul", noul: v };
      return new Response(JSON.stringify({ answers, latency_ms: 5 }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Set<string>();
  const set = jest.fn(async (k: string, _v: string, _e: "EX", _s: number, _n: "NX") => {
    if (opts.down) throw new Error("down");
    if (store.has(k)) return null;
    store.add(k); return "OK";
  });
  const exists = jest.fn(async (k: string) => { if (opts.down) throw new Error("down"); return store.has(k) ? 1 : 0; });
  return { redis: { set, exists } as unknown as FactsPickRedis, store, set, exists };
}

const base = { companion: "drevan", channelId: "c1", transcriptId: "drevan:c1:2026-W42", message: "my head hurts and I skipped dinner" };
let logs: string[];
const logWriter = (l: string) => { logs.push(l); };
let spies: Array<ReturnType<typeof jest.spyOn>>;
beforeEach(() => {
  logs = [];
  __resetFactsPickWarnings();
  spies = [jest.spyOn(console, "log").mockImplementation(() => {}), jest.spyOn(console, "warn").mockImplementation(() => {}), jest.spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(() => spies.forEach(s => s.mockRestore()));

describe("config", () => {
  it("mode defaults off, parses, per-companion wins, garbage -> off", () => {
    expect(readFactsPickMode(env({}), "drevan")).toBe("off");
    expect(readFactsPickMode(env({ FACTS_PICK_MODE: "shadow" }), "drevan")).toBe("shadow");
    expect(readFactsPickMode(env({ FACTS_PICK_MODE: "shadow", FACTS_PICK_MODE_DREVAN: "live" }), "drevan")).toBe("live");
    expect(readFactsPickMode(env({ FACTS_PICK_MODE: "shadow", FACTS_PICK_MODE_DREVAN: "live" }), "gaia")).toBe("shadow");
    expect(readFactsPickMode(env({ FACTS_PICK_MODE: "live", FACTS_PICK_MODE_GAIA: "  " }), "gaia")).toBe("live");
    expect(readFactsPickMode(env({ FACTS_PICK_MODE: "live", FACTS_PICK_MODE_GAIA: "lvie" }), "gaia")).toBe("off");
  });
  it("theta and k", () => {
    expect(readFactsPickTheta(env({}), "gaia")).toBe(0.6);
    expect(readFactsPickTheta(env({ FACTS_PICK_THETA: "0.7", FACTS_PICK_THETA_GAIA: "0.5" }), "gaia")).toBe(0.5);
    expect(readFactsPickTheta(env({ FACTS_PICK_THETA: "x" }), "gaia")).toBe(0.6);
    expect(readFactsPickK(env({}))).toBe(12);
    expect(readFactsPickK(env({ FACTS_PICK_K: "5" }))).toBe(5);
    expect(readFactsPickK(env({ FACTS_PICK_K: "-1" }))).toBe(12);
  });
});

describe("pickFacts", () => {
  it("off does nothing: no network, no log", async () => {
    const f = fakeFetch();
    const r = await pickFacts({ ...base, mode: "off", deps: { fetch: f.fn, env: env(), logWriter } });
    expect(r.block).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("shortlist non-200 -> no picks, no Jev call, error logged", async () => {
    const f = fakeFetch({ shortStatus: 500 });
    const r = await pickFacts({ ...base, mode: "live", deps: { fetch: f.fn, env: env(), logWriter } });
    expect(r.block).toBeNull();
    expect(r.log.error).toBe("shortlist_http_500");
    expect(f.calls.some(c => c.url.endsWith("/admin/jev"))).toBe(false);
  });

  it("calls shortlist with bearer-bound GET params and one noul question per fact", async () => {
    const f = fakeFetch({ items: FACTS.slice(0, 3), jevAnswers: {} });
    await pickFacts({ ...base, mode: "shadow", deps: { fetch: f.fn, env: env({ FACTS_PICK_K: "3" }), logWriter } });
    const s = new URL(f.calls[0]!.url);
    expect(s.searchParams.get("k")).toBe("3");
    expect(s.searchParams.get("text")).toBe("1");
    expect(s.searchParams.get("q")).toContain("skipped dinner");
    const jevBody = JSON.parse(f.calls[1]!.body!);
    expect(Object.keys(jevBody.questions)).toEqual(["f0", "f1", "f2"]);
    expect(jevBody.questions.f0.type).toBe("noul");
    expect(jevBody.questions.f0.instructions).toContain("SECRETFACT-0");
    expect(jevBody.state).toContain("Drevan");
  });

  it("Jev partial answers: missing = 0, only answered facts can pick", async () => {
    const f = fakeFetch({ jevAnswers: { f1: 0.9 } });
    const r = await pickFacts({ ...base, mode: "shadow", deps: { fetch: f.fn, env: env(), logWriter } });
    expect(r.log.picks!.map(p => p.id)).toEqual(["fact1"]);
  });

  it("Jev 502 -> no picks; 400 -> no picks with error", async () => {
    const a = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch({ jevStatus: 502 }).fn, env: env(), logWriter } });
    expect(a.block).toBeNull();
    expect(a.log.error).toBe("jev_http_502");
    const b = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch({ jevStatus: 400 }).fn, env: env(), logWriter } });
    expect(b.block).toBeNull();
    expect(b.log.error).toBe("jev_http_400");
  });

  it("theta filters, sorts desc, caps at 5", async () => {
    const ans: Record<string, number> = { f0: 0.61, f1: 0.95, f2: 0.59, f3: 0.8, f4: 0.7, f5: 0.99, f6: 0.65, f7: 0.9 };
    const f = fakeFetch({ jevAnswers: ans });
    const r = await pickFacts({ ...base, mode: "shadow", deps: { fetch: f.fn, env: env(), logWriter } });
    expect(r.log.picks!.map(p => p.id)).toEqual(["fact5", "fact1", "fact7", "fact3", "fact4"]);
    const r2 = await pickFacts({ ...base, mode: "shadow", deps: { fetch: f.fn, env: env({ FACTS_PICK_THETA_DREVAN: "0.96" }), logWriter } });
    expect(r2.log.picks!.map(p => p.id)).toEqual(["fact5"]);
  });

  it("shadow: no SET, EXISTS only, log has no text, would_inject respects prior marks", async () => {
    const f = fakeFetch({ jevAnswers: { f0: 0.9, f1: 0.8 } });
    const rd = fakeRedis();
    rd.store.add(factsSeenKey("drevan", "c1", base.transcriptId, "fact1"));
    const r = await pickFacts({ ...base, mode: "shadow", deps: { fetch: f.fn, redis: rd.redis, env: env(), logWriter } });
    expect(r.block).toBeNull();
    expect(rd.set).not.toHaveBeenCalled();
    expect(r.log.would_inject).toEqual(["fact0"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("SECRETFACT");
    expect(logs[0]).not.toContain("skipped dinner");
    const row = JSON.parse(logs[0]!);
    expect(row.msg_hash).toBe(createHash("sha256").update(base.message).digest("hex").slice(0, 12));
    expect(row).toMatchObject({ companion: "drevan", channel: "c1", mode: "shadow", msg_len: base.message.length, theta: 0.6, k: 12 });
    expect(typeof row.ms).toBe("number");
    expect(row.shortlist[0]).toEqual({ id: "fact0", category: "home", score: 0.9 });
  });

  it("live: claims, injects only claimed, second turn dedups", async () => {
    const f = fakeFetch({ jevAnswers: { f0: 0.9, f1: 0.8 } });
    const rd = fakeRedis();
    const d = { fetch: f.fn, redis: rd.redis, env: env(), logWriter };
    const a = await pickFacts({ ...base, mode: "live", deps: d });
    expect(a.block).toBe("[Architect facts relevant here]\n- SECRETFACT-0\n- SECRETFACT-1");
    expect(rd.set).toHaveBeenCalledWith(factsSeenKey("drevan", "c1", base.transcriptId, "fact0"), "1", "EX", 21600, "NX");
    const b = await pickFacts({ ...base, mode: "live", deps: d });
    expect(b.block).toBeNull();
    const c = await pickFacts({ ...base, transcriptId: "drevan:c1:2026-W42:r1", mode: "live", deps: d });
    expect(c.block).toContain("SECRETFACT-0");
    expect(logs.join("")).not.toContain("SECRETFACT");
  });

  it("live: no picks -> null block", async () => {
    const r = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch({ jevAnswers: { f0: 0.1 } }).fn, env: env(), logWriter } });
    expect(r.block).toBeNull();
  });

  it("redis down or absent fails open (inject)", async () => {
    const f = fakeFetch({ jevAnswers: { f0: 0.9 } });
    const down = await pickFacts({ ...base, mode: "live", deps: { fetch: f.fn, redis: fakeRedis({ down: true }).redis, env: env(), logWriter } });
    expect(down.block).toContain("SECRETFACT-0");
    const none = await pickFacts({ ...base, mode: "live", deps: { fetch: f.fn, redis: null, env: env(), logWriter } });
    expect(none.block).toContain("SECRETFACT-0");
  });

  it("overall timeout returns null with timeout error", async () => {
    const r = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch({ shortHang: true }).fn, env: env({ FACTS_PICK_TIMEOUT_MS: "60" }), logWriter } });
    expect(r.block).toBeNull();
    expect(r.log.error).toBe("timeout_60ms");
    expect(logs).toHaveLength(1);
  });

  it("never throws: fetch rejects, bad json, throwing logWriter, missing env", async () => {
    const rej = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const a = await pickFacts({ ...base, mode: "live", deps: { fetch: rej, env: env(), logWriter } });
    expect(a.block).toBeNull();
    expect(a.log.error).toContain("boom");
    const badJson = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const b = await pickFacts({ ...base, mode: "live", deps: { fetch: badJson, env: env(), logWriter } });
    expect(b.block).toBeNull();
    const c = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch({ jevAnswers: { f0: 0.9 } }).fn, env: env(), logWriter: () => { throw new Error("disk"); } } });
    expect(c.block).toContain("SECRETFACT-0");
    const d = await pickFacts({ ...base, mode: "live", deps: { fetch: fakeFetch().fn, env: {} as NodeJS.ProcessEnv, logWriter } });
    expect(d.block).toBeNull();
    expect(d.log.error).toBe("no_halseth_env");
    const e = await pickFacts({ ...base, message: undefined as unknown as string, mode: "live", deps: { fetch: fakeFetch().fn, env: env(), logWriter } });
    expect(e.block).toBeNull();
  });
});

describe("hermesDelta extras.facts", () => {
  const now = 1_700_000_100_000;
  const live = { role: "user", content: "Dre are you there", authorName: "Crash", timestamp: now - 1000 };
  const sib = { role: "user", content: "the light is low", authorName: "Gaia", timestamp: now - 5000 };
  const mine = { role: "assistant", content: "earlier", timestamp: now - 9000 };
  const FACTS_BLOCK = "[Architect facts relevant here]\n- a fact";

  it("facts sit after the live words and before the frame, frame stays last", () => {
    for (const hist of [[mine, live], [mine, sib, live]]) {
      const c = hermesDelta(hist, null, now, true, "Dre", { facts: FACTS_BLOCK, frame: "[FRAME]" }).messages[0]!.content;
      expect(c.indexOf("Dre are you there")).toBeLessThan(c.indexOf(FACTS_BLOCK));
      expect(c.indexOf(FACTS_BLOCK)).toBeLessThan(c.indexOf("[FRAME]"));
      expect(c.trimEnd().endsWith("[FRAME]")).toBe(true);
    }
  });
  it("facts without a frame end the message", () => {
    const c = hermesDelta([mine, live], null, now, true, "Dre", { facts: FACTS_BLOCK }).messages[0]!.content;
    expect(c.endsWith(FACTS_BLOCK)).toBe(true);
  });
  it("absent facts is byte-identical to before", () => {
    for (const hist of [[mine, live], [mine, sib, live]]) {
      const without = hermesDelta(hist, null, now, true, "Dre", { frame: "[FRAME]" }).messages[0]!.content;
      const undef = hermesDelta(hist, null, now, true, "Dre", { facts: undefined, frame: "[FRAME]" }).messages[0]!.content;
      const empty = hermesDelta(hist, null, now, true, "Dre", { facts: "", frame: "[FRAME]" }).messages[0]!.content;
      expect(undef).toBe(without);
      expect(empty).toBe(without);
      expect(without.endsWith("Dre are you there\n\n[FRAME]")).toBe(true);
    }
  });
});
