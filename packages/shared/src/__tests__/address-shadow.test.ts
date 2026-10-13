// B37 step 1 (2026-09-29): the address shadow's wiring contract. It never changes who speaks,
// never delays a reply, never throws into the reply path, runs once per message across the three
// bots, and never runs for a DM.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  fireAddressShadow, runAddressShadow, recordAddressSpoke, ADDRESS_CLAIM_PREFIX,
  type AddressShadowCtx, type AddressShadowRedis,
} from "../address-shadow.js";
import { extractAddress } from "../channel-config.js";
import { sealDmChannel, resetSealedDmChannels } from "../recall-context.js";
import type { InferenceAdapter } from "../inference.js";
import type { JevAddressVerdict } from "../address-jev.js";

function fakeRedis(opts: { claimed?: Set<string>; spoke?: string | null; bids?: Record<string, string>; throwOnSet?: boolean } = {}) {
  const claimed = opts.claimed ?? new Set<string>();
  const calls: string[] = [];
  const redis: AddressShadowRedis = {
    set: jest.fn(async (key: string) => {
      calls.push(`set ${key}`);
      if (opts.throwOnSet) throw new Error("redis down");
      if (claimed.has(key)) return null;
      claimed.add(key);
      return "OK";
    }) as AddressShadowRedis["set"],
    get: jest.fn(async (key: string) => { calls.push(`get ${key}`); return opts.spoke ?? null; }) as AddressShadowRedis["get"],
    hgetall: jest.fn(async (key: string) => { calls.push(`hgetall ${key}`); return opts.bids ?? {}; }) as AddressShadowRedis["hgetall"],
  };
  return { redis, calls, claimed };
}

const adapterReturning = (raw: string | null | Promise<string | null>): InferenceAdapter & { generate: jest.Mock } =>
  ({ generate: jest.fn(async () => raw) }) as unknown as InferenceAdapter & { generate: jest.Mock };

function ctx(over: Partial<AddressShadowCtx> = {}): AddressShadowCtx {
  const content = over.content ?? "Cy said the fence needs wire";
  return {
    mode: "shadow",
    isDm: false,
    companionId: "drevan",
    messageId: "m1",
    channelId: "c1",
    createdTimestamp: 0,
    content,
    speaker: "Raziel",
    mentionedCompanion: false,
    replyToMe: false,
    regex: extractAddress(content),
    holder: undefined,
    redis: fakeRedis().redis,
    adapter: adapterReturning('{"to":"room","mentioned":["cypher"],"confidence":0.9}'),
    fetchRecent: async () => ({ turns: [{ speaker: "Drevan", text: "the fence is down" }], holder: "drevan" }),
    now: () => 10_000, // well past the bid window: no winner-read wait
    sleep: async () => {},
    log: () => {},
    append: () => {},
    // Step-1 tests exercise Flash alone; the Jev voice has its own block below. Never the real call.
    jev: null,
    ...over,
  };
}

const jevVerdict = (over: Partial<JevAddressVerdict> = {}): JevAddressVerdict => ({
  addressee: "room", confidence: 0.8, probabilities: { room: 0.8 }, spokenTo: {},
  invitesReply: 0.7, mentionsWithoutAddressing: 0.9, moreComing: 0.1, to: "room", ...over,
});
const jevReturning = (verdict: JevAddressVerdict) =>
  jest.fn(async (_state: string) => ({ ok: true as const, verdict, latency_ms: 210, wall_ms: 480 }));

beforeEach(() => resetSealedDmChannels());
afterEach(() => resetSealedDmChannels());

describe("fireAddressShadow never touches the reply path", () => {
  it("returns undefined synchronously even when the model never answers", () => {
    const hang = adapterReturning(new Promise<string | null>(() => { /* never */ }));
    const decision = { speak: true, winner: "cypher" };
    const snapshot = JSON.stringify(decision);
    const t0 = Date.now();
    const ret = fireAddressShadow(ctx({ adapter: hang, now: Date.now, timeoutMs: 20 }));
    expect(ret).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(JSON.stringify(decision)).toBe(snapshot);
  });

  it("a throwing Redis, model, fetch, log and append never surface", async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const boom = { generate: jest.fn(async () => { throw new Error("model down"); }) } as unknown as InferenceAdapter;
      expect(() => fireAddressShadow(ctx({ redis: fakeRedis({ throwOnSet: true }).redis }))).not.toThrow();
      const row = await runAddressShadow(ctx({
        adapter: boom,
        fetchRecent: async () => { throw new Error("discord down"); },
        log: () => { throw new Error("stdout gone"); },
        append: () => { throw new Error("disk full"); },
      }));
      expect(row?.failure).toBe("error");
      expect(row?.turns).toEqual([]);
      // a getter that throws on the ctx itself
      const hostile = new Proxy(ctx(), { get: (t, p) => { if (p === "content") throw new Error("x"); return (t as never)[p]; } });
      expect(() => fireAddressShadow(hostile)).not.toThrow();
      await expect(runAddressShadow(hostile)).resolves.toBeNull();
      await new Promise(r => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("the handler fires it without awaiting, before its own gates, and records the spoke row after send", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../bot-message-handler.ts"), "utf8");
    expect(src).toMatch(/\n\s+fireAddressShadow\(\{/);
    expect(src).not.toMatch(/await\s+fireAddressShadow|await\s+runAddressShadow|runAddressShadow\(/);
    // Before the gates: the fire precedes the ambient judge and the shouldRespond stand-down.
    expect(src.indexOf("fireAddressShadow({")).toBeLessThan(src.indexOf("const isAmbientOwnerOnly"));
    // The DM seal and the human-only gate at the call site.
    const call = src.slice(src.lastIndexOf("if (isArrival", src.indexOf("fireAddressShadow({")), src.indexOf("fireAddressShadow({"));
    expect(call).toMatch(/!isOwnerDm/);
    expect(call).toMatch(/!isSol/);
    expect(call).toMatch(/!senderCtx\.isCompanionBot/);
    // Raziel and Blue (step 2); never a guest.
    expect(call).toMatch(/userTier === "owner" \|\| userTier === "intimate"/);
    expect(call).not.toMatch(/guest/);
    expect(src).toMatch(/withCaller\(directAdapter, "address_model"\)/);
    expect(src.indexOf("recordAddressSpoke({")).toBeGreaterThan(src.indexOf("for (const m of sent) sentIds.add(m.id);"));
    const spoke = src.slice(src.lastIndexOf("if (sent.length > 0", src.indexOf("recordAddressSpoke({")), src.indexOf("recordAddressSpoke({"));
    expect(spoke).toMatch(/userTier === "owner" \|\| userTier === "intimate"/);
  });
});

describe("runAddressShadow", () => {
  it("logs regex, holder, model verdict and agreement; stdout carries no message text", async () => {
    const lines: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const row = await runAddressShadow(ctx({ log: l => lines.push(l), append: r => rows.push(r) }));
    expect(row).toMatchObject({
      kind: "shadow", msg_id: "m1", channel_id: "c1", runner: "drevan",
      regex: { type: "named", ids: ["cypher"] }, holder: "drevan", regex_route: ["cypher"],
      model: { to: "room", mentioned: ["cypher"], confidence: 0.9 }, agree: false, misread: ["cypher"], failure: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("[address] ")).toBe(true);
    expect(lines[0]).not.toContain("fence");
    const meta = JSON.parse(lines[0]!.slice("[address] ".length));
    expect(meta.text).toBeUndefined();
    expect(meta.turns).toBeUndefined();
    expect(typeof meta.at).toBe("string");
    // The labelling row keeps the text and the turns.
    expect(rows[0]).toMatchObject({ text: "Cy said the fence needs wire", turns: [{ speaker: "Drevan", text: "the fence is down" }] });
  });

  it("calls the model at temperature 0 with a small token cap, through the given (direct) adapter", async () => {
    const a = adapterReturning('{"to":["cypher"],"mentioned":[],"confidence":0.8}');
    await runAddressShadow(ctx({ adapter: a }));
    expect(a.generate).toHaveBeenCalledTimes(1);
    const [system, msgs, temp, max] = a.generate.mock.calls[0] as [string, Array<{ content: string }>, number, number];
    expect(system).toMatch(/ONLY one JSON object/);
    expect(msgs[0]!.content).toContain("the fence is down");
    expect(temp).toBe(0);
    expect(max).toBeLessThanOrEqual(200);
  });

  it("only ONE bot per message runs the model: the claim loser does nothing", async () => {
    const shared = fakeRedis();
    const aD = adapterReturning('{"to":"room","mentioned":["cypher"],"confidence":0.9}');
    const aG = adapterReturning('{"to":"room","mentioned":["cypher"],"confidence":0.9}');
    const [d, g] = await Promise.all([
      runAddressShadow(ctx({ companionId: "drevan", redis: shared.redis, adapter: aD })),
      runAddressShadow(ctx({ companionId: "gaia", redis: shared.redis, adapter: aG })),
    ]);
    expect([d, g].filter(Boolean)).toHaveLength(1);
    expect(aD.generate.mock.calls.length + aG.generate.mock.calls.length).toBe(1);
    expect(shared.calls.filter(c => c === `set ${ADDRESS_CLAIM_PREFIX}m1`)).toHaveLength(2);
  });

  it("no Redis means no shadow (never three model calls)", async () => {
    const a = adapterReturning("{}");
    expect(await runAddressShadow(ctx({ redis: null, adapter: a }))).toBeNull();
    expect(a.generate).not.toHaveBeenCalled();
  });

  it("off mode, fast-path messages and cold nameless messages never claim", async () => {
    for (const over of [
      { mode: "off" as const },
      { content: "Cy, what do you think", regex: extractAddress("Cy, what do you think") },
      { content: "the fence", regex: extractAddress("the fence"), mentionedCompanion: true },
      { content: "the fence", regex: extractAddress("the fence"), holder: null },
    ]) {
      const r = fakeRedis();
      expect(await runAddressShadow(ctx({ redis: r.redis, ...over }))).toBeNull();
      expect(r.calls).toEqual([]);
    }
  });

  it("a nameless message with a holder runs", async () => {
    const row = await runAddressShadow(ctx({
      content: "yeah but the second one", regex: extractAddress("yeah but the second one"), holder: "gaia",
      adapter: adapterReturning('{"to":"continuing","mentioned":[],"confidence":0.7}'),
    }));
    expect(row).toMatchObject({ holder: "gaia", regex_route: ["gaia"], agree: true });
  });

  it("a reply to a sibling is a fast path, found only after the claim", async () => {
    const a = adapterReturning("{}");
    const reply = jest.fn(async () => true);
    expect(await runAddressShadow(ctx({ adapter: a, replyToCompanion: reply }))).toBeNull();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(a.generate).not.toHaveBeenCalled();
  });

  it("DM: never runs, even if the call site slipped (flag or sealed channel)", async () => {
    const r1 = fakeRedis();
    expect(await runAddressShadow(ctx({ isDm: true, redis: r1.redis }))).toBeNull();
    sealDmChannel("dm-chan");
    const r2 = fakeRedis();
    expect(await runAddressShadow(ctx({ channelId: "dm-chan", redis: r2.redis }))).toBeNull();
    expect([...r1.calls, ...r2.calls]).toEqual([]);
  });

  it("timeout, empty, parse failure and no adapter are logged as failures, not thrown", async () => {
    const hang = adapterReturning(new Promise<string | null>(() => {}));
    expect((await runAddressShadow(ctx({ adapter: hang, timeoutMs: 5 })))?.failure).toBe("timeout");
    expect((await runAddressShadow(ctx({ messageId: "m2", adapter: adapterReturning(null) })))?.failure).toBe("empty");
    expect((await runAddressShadow(ctx({ messageId: "m3", adapter: adapterReturning("Cypher, probably.") })))?.failure).toBe("parse");
    const noA = await runAddressShadow(ctx({ messageId: "m4", adapter: null }));
    expect(noA).toMatchObject({ failure: "no_direct_adapter", model: null, agree: null, latency_ms: null });
  });

  it("reads the bid outcome from Redis once the window has closed", async () => {
    const slept: number[] = [];
    const r = fakeRedis({ spoke: "gaia", bids: { gaia: "0.61", drevan: "0.20" } });
    const row = await runAddressShadow(ctx({
      redis: r.redis, createdTimestamp: 1_000, now: () => 1_500, sleep: async (ms) => { slept.push(ms); },
    }));
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(2_500);
    expect(row).toMatchObject({ spoke_bid: "gaia", bids: { gaia: 0.61, drevan: 0.2 } });
  });
});

describe("runAddressShadow: the Jev voice (step 2)", () => {
  it("runs beside Flash on the same row; state names Blue as family; agreement on both axes", async () => {
    const jev = jevReturning(jevVerdict());
    const row = await runAddressShadow(ctx({ jev }));
    expect(jev).toHaveBeenCalledTimes(1);
    const state = jev.mock.calls[0]![0];
    expect(state).toContain("Blue: Raziel's husband, family");
    expect(state).toContain("Drevan: the fence is down");
    expect(state).toContain("Cy said the fence needs wire");
    expect(row).toMatchObject({
      speaker_side: "raziel", model: { to: "room" }, jev: { addressee: "room" },
      jev_failure: null, jev_latency_ms: 210, jev_wall_ms: 480,
      jev_agree_flash: true, today_route: ["cypher"], jev_agree_today: false,
    });
  });

  it("a cold nameless message runs Jev only; Flash is logged as skipped_gate", async () => {
    const a = adapterReturning("{}");
    const jev = jevReturning(jevVerdict({ addressee: "nobody", to: null, invitesReply: 0.1 }));
    const row = await runAddressShadow(ctx({
      content: "the fence", regex: extractAddress("the fence"), holder: null,
      fetchRecent: async () => ({ turns: [], holder: null }), adapter: a, jev,
    }));
    expect(a.generate).not.toHaveBeenCalled();
    expect(row).toMatchObject({ failure: "skipped_gate", model: null, jev: { addressee: "nobody" }, today_route: ["room"], jev_agree_today: false, jev_agree_flash: null });
  });

  it("the fast path still skips everything, Jev included", async () => {
    const r = fakeRedis();
    const jev = jevReturning(jevVerdict());
    expect(await runAddressShadow(ctx({ redis: r.redis, jev, content: "Cy, what do you think", regex: extractAddress("Cy, what do you think") }))).toBeNull();
    expect(jev).not.toHaveBeenCalled();
    expect(r.calls).toEqual([]);
  });

  it("Blue's message: Jev runs, Flash never does, the holder is Blue's own and the state says Blue sent it", async () => {
    const a = adapterReturning('{"to":"room","mentioned":[],"confidence":0.9}');
    const jev = jevReturning(jevVerdict({ addressee: "raziel", to: null }));
    const row = await runAddressShadow(ctx({
      speaker: "Blue", speakerSide: "blue", humanAddressee: "raziel",
      content: "Raziel, are you eating tonight?", regex: extractAddress("Raziel, are you eating tonight?"),
      fetchRecent: async () => ({ turns: [{ speaker: "Raziel", text: "home in 10" }], holder: "gaia" }),
      adapter: a, jev,
    }));
    expect(a.generate).not.toHaveBeenCalled();
    expect(jev.mock.calls[0]![0]).toContain(`The last message, from Blue (shown as "Blue")`);
    expect(jev.mock.calls[0]![0]).toContain("Gaia is holding the current one-on-one exchange");
    expect(row).toMatchObject({
      speaker_side: "blue", human_addressee: "raziel", holder: "gaia", failure: "skipped_gate",
      jev: { addressee: "raziel" }, today_route: ["raziel"], jev_agree_today: true,
    });
  });

  it("a Jev failure is a logged reason, never a throw, and Flash still lands", async () => {
    const down = jest.fn(async () => ({ ok: false as const, reason: "http_502", wall_ms: 90 }));
    const throws = jest.fn(async () => { throw new Error("socket"); });
    const r1 = await runAddressShadow(ctx({ jev: down }));
    expect(r1).toMatchObject({ jev: null, jev_failure: "http_502", jev_wall_ms: 90, model: { to: "room" }, jev_agree_flash: null });
    const r2 = await runAddressShadow(ctx({ messageId: "m9", jev: throws }));
    expect(r2?.jev_failure).toMatch(/^error: /);
    expect(r2?.model).not.toBeNull();
  });

  it("only the claim winner calls Jev", async () => {
    const shared = fakeRedis();
    const jD = jevReturning(jevVerdict());
    const jG = jevReturning(jevVerdict());
    await Promise.all([
      runAddressShadow(ctx({ companionId: "drevan", redis: shared.redis, jev: jD })),
      runAddressShadow(ctx({ companionId: "gaia", redis: shared.redis, jev: jG })),
    ]);
    expect(jD.mock.calls.length + jG.mock.calls.length).toBe(1);
  });
});

describe("recordAddressSpoke", () => {
  it("appends one spoke row in shadow mode; nothing when off or for a DM", () => {
    const rows: Record<string, unknown>[] = [];
    const append = (r: Record<string, unknown>) => rows.push(r);
    recordAddressSpoke({ isDm: false, msgId: "m1", channelId: "c1", companionId: "cypher", append, mode: "shadow", now: () => 0 });
    recordAddressSpoke({ isDm: false, msgId: "m1", channelId: "c1", companionId: "gaia", append, mode: "off" });
    recordAddressSpoke({ isDm: true, msgId: "m1", channelId: "c1", companionId: "gaia", append, mode: "shadow" });
    sealDmChannel("dm-chan");
    recordAddressSpoke({ isDm: false, msgId: "m1", channelId: "dm-chan", companionId: "gaia", append, mode: "shadow" });
    expect(rows).toEqual([{ kind: "spoke", at: "1970-01-01T00:00:00.000Z", msg_id: "m1", channel_id: "c1", companion: "cypher" }]);
  });
  it("never throws", () => {
    expect(() => recordAddressSpoke({ isDm: false, msgId: "m", channelId: "c", companionId: "cypher", mode: "shadow", append: () => { throw new Error("x"); } })).not.toThrow();
  });
});
