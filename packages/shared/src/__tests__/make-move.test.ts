import { describe, it, expect, jest } from "@jest/globals";
import {
  parseMakeReply, makeMoveOn, mayMake, decidePace, parseFerment, warmestInterest, offerMake, runMakeMove,
  buildMakePrompt, makeAction, paceLogLine, executeMetronomeAction,
  type InterestLite, type HalsethHttp,
} from "../index.js";

const fence = (body: string, tag = "") => "```" + tag + "\n" + body + "\n```";

describe("parseMakeReply", () => {
  it("reads a good drawing", () => {
    const r = parseMakeReply(`KIND: drawing\nTITLE: Low tide\nFOR: tide tables\nWHY: it keeps coming back\n${fence("<svg><rect/></svg>", "svg")}`);
    expect(r).toMatchObject({ result: "make", make: { kind: "drawing", title: "Low tide", forInterest: "tide tables", why: "it keeps coming back" } });
    expect((r as { make: { source: string } }).make.source).toContain("<svg>");
  });
  it("reads NONE, in any case and with decoration", () => {
    expect(parseMakeReply("NONE")).toEqual({ result: "none" });
    expect(parseMakeReply("  none.\n")).toEqual({ result: "none" });
    expect(parseMakeReply("**NONE**")).toEqual({ result: "none" });
  });
  it("FOR: none means no interest", () => {
    const r = parseMakeReply(`KIND: writing\nTITLE: T\nFOR: none\nWHY: w\n${fence("a poem")}`);
    expect(r).toMatchObject({ result: "make", make: { forInterest: null } });
  });
  it("rejects malformed replies", () => {
    expect(parseMakeReply("")).toMatchObject({ result: "invalid" });
    expect(parseMakeReply("I would like to make a thing")).toMatchObject({ result: "invalid", reason: "no KIND line" });
    expect(parseMakeReply(`KIND: writing\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid", reason: "no TITLE line" });
    expect(parseMakeReply("KIND: writing\nTITLE: T\nWHY: w\nno block here")).toMatchObject({ result: "invalid", reason: "no fenced block" });
    expect(parseMakeReply(`KIND: writing\nTITLE: ${"x".repeat(121)}\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid", reason: "title too long" });
  });
  it("rejects a wrong kind and a kind outside the allowed menu", () => {
    expect(parseMakeReply(`KIND: sculpture\nTITLE: T\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid" });
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\n${fence("x")}`, ["writing"])).toMatchObject({ result: "invalid" });
  });
  it("rejects a drawing that is not an svg and an oversize source", () => {
    expect(parseMakeReply(`KIND: drawing\nTITLE: T\nWHY: w\n${fence("<p>no</p>")}`)).toMatchObject({ result: "invalid", reason: "drawing is not an svg" });
    expect(parseMakeReply(`KIND: writing\nTITLE: T\nWHY: w\n${fence("a".repeat(64 * 1024 + 10))}`)).toMatchObject({ result: "invalid", reason: "source over 64 KB" });
  });
  it("music_audio: first block is the prompt, second is lyrics; duration clamped", () => {
    const r = parseMakeReply(`KIND: music_audio\nTITLE: T\nWHY: w\nDURATION: 400\n${fence("slow, warm piano")}\n${fence("la la")}`);
    expect(r).toMatchObject({ result: "make", make: { kind: "music_audio", params: { prompt: "slow, warm piano", lyrics: "la la", instrumental: false, duration: 120 } } });
    const inst = parseMakeReply(`KIND: music_audio\nTITLE: T\nWHY: w\n${fence("drone")}`);
    expect(inst).toMatchObject({ make: { params: { instrumental: true, duration: 30 } } });
  });
  it("video: aspect defaults to 9:16", () => {
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\n${fence("a crow at dusk")}`)).toMatchObject({ make: { params: { aspect: "9:16", prompt: "a crow at dusk" } } });
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\nASPECT: 16:9\n${fence("p")}`)).toMatchObject({ make: { params: { aspect: "16:9" } } });
  });
  it("strips em dashes from title and why", () => {
    const r = parseMakeReply(`KIND: writing\nTITLE: Night — again\nWHY: it held — barely\n${fence("x")}`);
    const m = (r as { make: { title: string; why: string } }).make;
    expect(m.title + m.why).not.toMatch(/—/);
  });
});

describe("switches", () => {
  it("MAKE_MOVE: unset is on; off/0/false/no kill it", () => {
    expect(makeMoveOn({})).toBe(true);
    for (const v of ["off", "OFF", "0", "false", "no"]) expect(makeMoveOn({ MAKE_MOVE: v })).toBe(false);
    expect(makeMoveOn({ MAKE_MOVE: "on" })).toBe(true);
  });
  it("Gaia never gets the move", () => {
    expect(mayMake("gaia")).toBe(false);
    expect(mayMake("cypher") && mayMake("drevan")).toBe(true);
  });
});

describe("pace gate", () => {
  const fl = (v: number[], nn: number | null) => ({ floats: v, noveltyNeed: nn });
  it("flat = low mood AND low novelty", () => {
    expect(decidePace(fl([0.2, 0.3, 0.2], 0.1)).pace).toBe("flat");
    expect(decidePace(fl([0.2, 0.3, 0.2], 0.4)).pace).toBe("normal");
    expect(decidePace(fl([0.5, 0.5, 0.5], 0.1)).pace).toBe("normal");
  });
  it("bright = high mood OR novelty >= 0.6", () => {
    expect(decidePace(fl([0.8, 0.8, 0.7], 0.1)).pace).toBe("bright");
    expect(decidePace(fl([0.4, 0.4, 0.4], 0.6)).pace).toBe("bright");
  });
  it("unknown reads are normal, never flat", () => {
    expect(decidePace(null).pace).toBe("normal");
    expect(decidePace(fl([], null)).pace).toBe("normal");
    expect(decidePace(fl([0.1], null)).pace).toBe("normal");
  });
  it("parseFerment pulls floats and novelty_need", () => {
    expect(parseFerment({ floats: [{ value: 0.4 }, { value: null }, { value: 0.6 }], drives: [{ drive_key: "novelty_need", level: 0.3 }, { drive_key: "x", level: 1 }] }))
      .toEqual({ floats: [0.4, 0.6], noveltyNeed: 0.3 });
    expect(parseFerment(null)).toEqual({ floats: [], noveltyNeed: null });
  });
  it("[pace] line carries the numbers", () => {
    expect(paceLogLine("cypher", "make", { pace: "flat", mood: 0.2, noveltyNeed: 0.1 }, "skip")).toBe("[pace] cypher path=make pace=flat mood=0.20 novelty_need=0.10 -> skip");
  });
});

const interests: InterestLite[] = [
  { id: "i1", name: "knot theory", why: "loops", status: "active", heat: 0.8 },
  { id: "i2", name: "my medication", why: null, status: "active", heat: 0.99 },
  { id: "i3", name: "tide tables", why: null, status: "dormant", heat: 0.9 },
];

describe("interests + prompt hygiene", () => {
  it("picks the warmest active, non-health interest at heat >= 0.5", () => {
    expect(warmestInterest(interests)?.name).toBe("knot theory");
    expect(warmestInterest([{ ...interests[0]!, heat: 0.4 }])).toBeNull();
    expect(warmestInterest(null)).toBeNull();
  });
  it("the make prompt names the interest, lists the kinds and never carries care or Raziel state", () => {
    const p = buildMakePrompt("drevan", interests[0]!, "bright");
    expect(p).toMatch(/knot theory/);
    expect(p).toMatch(/KIND:.*writing.*video/);
    expect(p).toMatch(/NONE/);
    expect(p).not.toMatch(/Raziel|spoons|medication|pain|sleep/i);
    expect(p).not.toMatch(/—/);
    expect(buildMakePrompt("cypher", null, "normal")).toMatch(/Make anything that is yours/);
  });
  it("the palette row is a builtin that leans on warmth", () => {
    const a = makeAction(interests[0]!, "bright");
    expect(a).toMatchObject({ id: "builtin:make", action_type: "make", quiet_hours_allowed: 1 });
    expect(a.prompt).toMatch(/knot theory/);
    expect(a.prompt).toMatch(/restlessness/);
  });
});

function fakeHalseth(opts: { interests?: unknown; ferment?: unknown; postStatus?: number } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ id: "f".repeat(32), status: "pending" }), { status: opts.postStatus ?? 200 });
    }
    if (url.includes("/mind/interests/")) return new Response(JSON.stringify(opts.interests ?? { interests: [] }), { status: 200 });
    if (url.includes("/mind/ferment/")) return new Response(JSON.stringify(opts.ferment ?? { floats: [{ value: 0.5 }], drives: [{ drive_key: "novelty_need", level: 0.4 }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const h: HalsethHttp = { url: "https://h.test", secret: "s", fetchFn };
  return { h, posts };
}

const GOOD = `KIND: scad\nTITLE: A small cup\nFOR: knot theory\nWHY: it wanted a handle\n${fence("difference(){cylinder(h=10,r=5);}")}`;

describe("offerMake", () => {
  const live = { interests: [{ id: "i1", name: "knot theory", why: null, status: "active", heat: 0.8 }] };
  it("offers to cypher and drevan with the warm interest", async () => {
    const { h } = fakeHalseth({ interests: live });
    const o = await offerMake("drevan", h, {});
    expect(o.offer).toBe(true);
    expect(o.action?.prompt).toMatch(/knot theory/);
  });
  it("never offers to Gaia, and never touches the network for her", async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const o = await offerMake("gaia", { url: "https://h.test", secret: "s", fetchFn }, {});
    expect(o.offer).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("kill switch", async () => {
    const { h } = fakeHalseth();
    expect((await offerMake("cypher", h, { MAKE_MOVE: "off" })).offer).toBe(false);
  });
  it("flat pace skips this tick's optional make", async () => {
    const { h } = fakeHalseth({ ferment: { floats: [{ value: 0.1 }, { value: 0.2 }], drives: [{ drive_key: "novelty_need", level: 0.05 }] } });
    const o = await offerMake("cypher", h, {});
    expect(o.offer).toBe(false);
    expect(o.why).toBe("flat pace");
  });
  it("fails soft when Halseth is down (normal pace, freedom)", async () => {
    const fetchFn = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const o = await offerMake("cypher", { url: "https://h.test", secret: "s", fetchFn }, {});
    expect(o.offer).toBe(true);
    expect(o.interest).toBeNull();
  });
});

describe("runMakeMove (dispatch)", () => {
  it("posts the parsed make over HTTP", async () => {
    const { h, posts } = fakeHalseth();
    const r = await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => GOOD, env: {} });
    expect(r).toMatchObject({ outcome: "made", kind: "scad" });
    expect(posts[0]).toMatchObject({ companion_id: "cypher", kind: "scad", title: "A small cup", interest_name: "knot theory", why: "it wanted a handle" });
    expect(posts[0]!["source"]).toContain("cylinder");
  });
  it("dry run composes but posts nothing", async () => {
    const { h, posts } = fakeHalseth();
    const seen: string[] = [];
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => GOOD, dryRun: true, onDryRun: (s) => seen.push(s), env: {} });
    expect(r.outcome).toBe("dry_run");
    expect(posts).toHaveLength(0);
    expect(seen[0]).toMatch(/Halseth POST skipped/);
  });
  it("Gaia is excluded before any inference", async () => {
    const { h, posts } = fakeHalseth();
    const generate = jest.fn(async () => GOOD);
    const r = await runMakeMove({ companionId: "gaia", halseth: h, generate, env: {} });
    expect(r.outcome).toBe("gaia");
    expect(generate).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("kill switch stops it before any inference", async () => {
    const { h } = fakeHalseth();
    const generate = jest.fn(async () => GOOD);
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate, env: { MAKE_MOVE: "off" } })).outcome).toBe("off");
    expect(generate).not.toHaveBeenCalled();
  });
  it("NONE costs nothing: no post", async () => {
    const { h, posts } = fakeHalseth();
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => "NONE", env: {} })).outcome).toBe("none");
    expect(posts).toHaveLength(0);
  });
  it("malformed and empty replies post nothing", async () => {
    const { h, posts } = fakeHalseth();
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => "blah", env: {} })).outcome).toBe("invalid");
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => null, env: {} })).outcome).toBe("no_reply");
    expect(posts).toHaveLength(0);
  });
  it("a failed POST is reported, not thrown", async () => {
    const { h } = fakeHalseth({ postStatus: 500 });
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => GOOD, env: {} })).outcome).toBe("post_failed");
  });
  it("the executeMetronomeAction `make` case posts nothing to Discord and dry-runs cleanly", async () => {
    const prev = process.env["HALSETH_URL"];
    process.env["HALSETH_URL"] = "https://h.test";
    const { posts } = fakeHalseth();
    const realFetch = globalThis.fetch;
    const sendSpy = jest.fn();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: "a".repeat(32), status: "ready" }), { status: 200 }); }
      return new Response(JSON.stringify(String(url).includes("interests") ? { interests: [] } : { floats: [], drives: [] }), { status: 200 });
    }) as never;
    try {
      const ctx = {
        companionId: "cypher", halsethSecret: "s", heartbeatChannelId: "c",
        librarian: {}, inference: { generate: async () => GOOD }, bootCtx: { systemPrompt: "sys" }, prompts: {},
        client: { channels: { fetch: sendSpy } },
      } as never;
      const decision = { action: makeAction(null, "normal"), reason: "r" };
      await executeMetronomeAction(ctx, decision);
      expect(posts).toHaveLength(1);
      expect(sendSpy).not.toHaveBeenCalled();
      const dctx = { ...(ctx as object), dryRun: true, dryRunSink: { compose: jest.fn() } } as never;
      await executeMetronomeAction(dctx, decision);
      expect(posts).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      if (prev === undefined) delete process.env["HALSETH_URL"]; else process.env["HALSETH_URL"] = prev;
    }
  });
});
