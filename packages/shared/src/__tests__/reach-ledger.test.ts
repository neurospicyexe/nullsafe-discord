// P13b: the reach-out outcome ledger and its back-off (reach-ledger.ts), plus the same thing through
// the REAL runHeartbeat and speakToOwnerDm (a send records a row; ignored sends hold the next DM move;
// 2am is not special; the knob and Redis failure both fail open).

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import {
  ignoredStreak, backoffFor, reachBackoffOn, reachLedgerKnobs, isDismissEmoji, isExplicitDismissal,
  recordReachSend, noteOwnerArrival, noteOwnerReaction, settleUnanswered, reachBackoff, readRecentRows,
  filterDmMovesForBackoff, NO_BACKOFF, REACH_LEDGER_KEY, REACH_OUT_KEY,
} from "../reach-ledger.js";
import { runHeartbeat } from "../autonomous-core.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

const H = 3_600_000;
const KNOBS = { baseMs: 3 * H, maxMs: 72 * H };

/** Just the Redis commands the ledger, the floor and the heartbeat use. */
function fakeRedis() {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const r = {
    async set(k: string, v: string, ..._rest: unknown[]) { kv.set(k, v); return "OK"; },
    async get(k: string) { return kv.get(k) ?? null; },
    async atomicRelease() { return 1; },
    async hset(k: string, ...kvs: string[]) {
      const h = hashes.get(k) ?? new Map<string, string>();
      for (let i = 0; i < kvs.length; i += 2) h.set(kvs[i]!, kvs[i + 1]!);
      hashes.set(k, h);
      return kvs.length / 2;
    },
    async hsetnx(k: string, f: string, v: string) {
      const h = hashes.get(k) ?? new Map<string, string>();
      if (h.has(f)) return 0;
      h.set(f, v); hashes.set(k, h); return 1;
    },
    async hgetall(k: string) { return Object.fromEntries(hashes.get(k) ?? []); },
    async expire() { return 1; },
    async zadd(k: string, score: number, member: string) {
      const z = zsets.get(k) ?? new Map<string, number>(); z.set(member, score); zsets.set(k, z); return 1;
    },
    async zrevrange(k: string, a: number, b: number) {
      const z = [...(zsets.get(k) ?? new Map<string, number>()).entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
      return z.slice(a, b + 1);
    },
    async zremrangebyrank(k: string, a: number, b: number) {
      const z = zsets.get(k); if (!z) return 0;
      const asc = [...z.entries()].sort((x, y) => x[1] - y[1]).map(e => e[0]);
      const end = b < 0 ? asc.length + b : b;
      if (end < 0) return 0;
      for (const m of asc.slice(a, end + 1)) z.delete(m);
      return 0;
    },
  };
  return { r: r as unknown as import("../floor.js").Redis, hashes, zsets };
}

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); delete process.env["REACH_BACKOFF"]; delete process.env["REACH_DM"]; });

describe("streak and gap (pure)", () => {
  it("counts consecutive ignored sends, newest first, and stops at the first reply", () => {
    expect(ignoredStreak([])).toBe(0);
    expect(ignoredStreak([{ outcome: "unanswered" }, { outcome: "unanswered" }, { outcome: "replied" }, { outcome: "unanswered" }])).toBe(2);
    expect(ignoredStreak([{ outcome: "replied" }, { outcome: "unanswered" }])).toBe(0);
    expect(ignoredStreak([{ outcome: null }, { outcome: "replied" }])).toBe(1); // still open = not yet answered
    expect(ignoredStreak([{ outcome: "dismissed" }, { outcome: "replied" }])).toBe(2); // a dismissal counts double
  });

  it("gap doubles per ignored send from the base and is capped", () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({ outcome: "unanswered" as const, ts: 0 }));
    const gaps = [1, 2, 3, 4, 5, 6, 7, 12].map(n => backoffFor(rows(n), 0, KNOBS).gapMs / H);
    expect(gaps).toEqual([3, 6, 12, 24, 48, 72, 72, 72]);
  });

  it("holds until last send + gap, then releases; no ignored sends means no hold", () => {
    const ts = 1_000_000_000_000;
    const b = backoffFor([{ outcome: "unanswered", ts }], ts + 2 * H, KNOBS);
    expect(b).toMatchObject({ blocked: true, streak: 1, waitMs: 1 * H });
    expect(backoffFor([{ outcome: "unanswered", ts }], ts + 3 * H, KNOBS).blocked).toBe(false);
    expect(backoffFor([{ outcome: "replied", ts }], ts + 1, KNOBS)).toEqual(NO_BACKOFF);
  });

  it("is a gap, not a clock window: the same streak blocks at 02:00 and at 14:00 identically", () => {
    const night = Date.UTC(2026, 9, 14, 7, 0); // 02:00 CDT
    const day = Date.UTC(2026, 9, 14, 19, 0);  // 14:00 CDT
    const mk = (now: number) => backoffFor([{ outcome: "unanswered", ts: now - 4 * H }], now, KNOBS);
    expect(mk(night).blocked).toBe(false); // 4h > 3h gap: free at 2am
    expect(mk(day).blocked).toBe(false);
    expect(mk(night).streak).toBe(mk(day).streak);
  });
});

describe("knobs and classifiers", () => {
  it("REACH_BACKOFF: default on; off/0/false/no (trimmed, any case) off", () => {
    expect(reachBackoffOn({})).toBe(true);
    expect(reachBackoffOn({ REACH_BACKOFF: "on" })).toBe(true);
    for (const v of ["off", "0", "false", "no", " OFF "]) expect(reachBackoffOn({ REACH_BACKOFF: v })).toBe(false);
  });
  it("numeric knobs fall back on junk", () => {
    expect(reachLedgerKnobs({})).toEqual({ windowMs: 6 * H, baseMs: 3 * H, maxMs: 72 * H });
    expect(reachLedgerKnobs({ REACH_BACKOFF_BASE_MS: "x", REACH_UNANSWERED_WINDOW_MS: "7200000" }).windowMs).toBe(2 * H);
    expect(reachLedgerKnobs({ REACH_BACKOFF_BASE_MS: "x" }).baseMs).toBe(3 * H);
  });
  it("dismissal emoji, with and without variation selector / gender joiner; plain reactions are not dismissals", () => {
    const vs = String.fromCharCode(0xFE0F);
    const zwj = String.fromCharCode(0x200D);
    expect(isDismissEmoji(String.fromCodePoint(0x1F645))).toBe(true);
    expect(isDismissEmoji(String.fromCodePoint(0x1F645) + zwj + String.fromCharCode(0x2642) + vs)).toBe(true);
    expect(isDismissEmoji(String.fromCharCode(0x23ED) + vs)).toBe(true);
    expect(isDismissEmoji(String.fromCodePoint(0x1F44D))).toBe(false);
    expect(isDismissEmoji(String.fromCodePoint(0x2764))).toBe(false);
  });
  it("explicit dismissal is a whole short message, never a fragment of a real one", () => {
    for (const m of ["not now", "Stop.", "leave me alone", "please don't", "later", "don't message me"]) expect(isExplicitDismissal(m)).toBe(true);
    for (const m of ["stop by the store, I need milk and also eggs please", "I can't talk right now but later is good", "thanks", "", null]) expect(isExplicitDismissal(m as string)).toBe(false);
  });
});

describe("the ledger in Redis", () => {
  const send = (id: string, ts: number, extra: Partial<{ ch: string; companion: string; action: string }> = {}) =>
    ({ id, companionId: extra.companion ?? "drevan", actionType: extra.action ?? "flirt", channelId: extra.ch ?? "dm1", ts });

  it("a send writes a row and one id-only log line (never text)", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 1000));
    expect((await readRecentRows(r)).map(x => ({ id: x.id, outcome: x.outcome }))).toEqual([{ id: "m1", outcome: null }]);
    expect(logs).toEqual(["[reach-ledger] sent id=m1 companion=drevan action=flirt"]);
  });

  it("an owner message anywhere settles every earlier open row `replied`, once", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 1000));
    await recordReachSend(r, send("m2", 2000, { ch: "dm2", companion: "gaia" }));
    expect(await noteOwnerArrival(r, { ts: 3000, channelId: "guild1", isDm: false, content: "hey" })).toBe(2);
    expect(await noteOwnerArrival(r, { ts: 4000, channelId: "guild1", isDm: false, content: "hey again" })).toBe(0);
    expect((await readRecentRows(r)).map(x => x.outcome)).toEqual(["replied", "replied"]);
    expect(logs.filter(l => l.includes("outcome=replied"))).toHaveLength(2);
  });

  it("three bots racing to settle one row log it exactly once (HSETNX claim)", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 1000));
    await Promise.all([1, 2, 3].map(() => noteOwnerArrival(r, { ts: 5000, channelId: "g", isDm: false, content: "x" })));
    expect(logs.filter(l => l.includes("outcome=replied"))).toHaveLength(1);
  });

  it("a bare 'not now' in the very DM it came in is `dismissed`; the same words elsewhere are `replied`", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 1000, { ch: "dmA" }));
    await recordReachSend(r, send("m2", 1500, { ch: "dmB" }));
    await noteOwnerArrival(r, { ts: 2000, channelId: "dmA", isDm: true, content: "not now" });
    const byId = Object.fromEntries((await readRecentRows(r)).map(x => [x.id, x.outcome]));
    expect(byId).toEqual({ m1: "dismissed", m2: "replied" });
  });

  it("a message with an arrival timestamp BEFORE the send never settles it", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 5000));
    expect(await noteOwnerArrival(r, { ts: 4000, channelId: "g", isDm: false, content: "x" })).toBe(0);
  });

  it("a reaction on the sent message settles that row only: dismissal emoji dismisses, others reply", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("m1", 1000));
    await recordReachSend(r, send("m2", 1100));
    expect(await noteOwnerReaction(r, { messageId: "m1", emoji: String.fromCodePoint(0x1F44E), ts: 2000 })).toBe(true);
    expect(await noteOwnerReaction(r, { messageId: "m2", emoji: String.fromCodePoint(0x2764), ts: 2000 })).toBe(true);
    expect(await noteOwnerReaction(r, { messageId: "unknown", emoji: String.fromCodePoint(0x2764) })).toBe(false);
    expect(await noteOwnerReaction(r, { messageId: "m1", emoji: String.fromCodePoint(0x2764) })).toBe(false); // already settled
    const byId = Object.fromEntries((await readRecentRows(r)).map(x => [x.id, x.outcome]));
    expect(byId).toEqual({ m1: "dismissed", m2: "replied" });
  });

  it("open rows older than the window become `unanswered` (one log line each); younger ones stay open", async () => {
    const { r } = fakeRedis();
    await recordReachSend(r, send("old", 1000));
    await recordReachSend(r, send("new", 1000 + 5 * H));
    expect(await settleUnanswered(r, 1000 + 7 * H, 6 * H)).toBe(1);
    expect(await settleUnanswered(r, 1000 + 7 * H, 6 * H)).toBe(0);
    const byId = Object.fromEntries((await readRecentRows(r)).map(x => [x.id, x.outcome]));
    expect(byId).toEqual({ old: "unanswered", new: null });
    expect(logs.filter(l => l.startsWith("[reach-ledger] outcome=unanswered"))).toEqual(["[reach-ledger] outcome=unanswered id=old companion=drevan action=flirt age_min=420"]);
  });

  it("keeps the newest 50 rows", async () => {
    const { r, zsets } = fakeRedis();
    for (let i = 0; i < 55; i++) await recordReachSend(r, send(`m${i}`, 1000 + i));
    expect(zsets.get(REACH_LEDGER_KEY)!.size).toBe(50);
    expect(zsets.get(REACH_LEDGER_KEY)!.has("m54")).toBe(true);
    expect(zsets.get(REACH_LEDGER_KEY)!.has("m0")).toBe(false);
  });

  it("a row whose hash expired is skipped, not fatal", async () => {
    const { r, hashes } = fakeRedis();
    await recordReachSend(r, send("m1", 1000));
    hashes.delete(REACH_OUT_KEY("m1"));
    expect(await readRecentRows(r)).toEqual([]);
  });

  it("(streak 2, gap 6h) 2h after the last send blocks; 7h after, free", async () => {
    const { r } = fakeRedis();
    const now = 1_000_000_000_000;
    await recordReachSend(r, send("a", now - 30 * H));
    await recordReachSend(r, send("b", now - 2 * H));
    expect((await reachBackoff(r, now, {})).blocked).toBe(true);
    expect((await reachBackoff(r, now + 5 * H, {})).blocked).toBe(false);
  });

  it("a reply after the ignored sends resets the streak to zero", async () => {
    const { r } = fakeRedis();
    const now = 1_000_000_000_000;
    await recordReachSend(r, send("a", now - 30 * H));
    await recordReachSend(r, send("b", now - 10 * H));
    await noteOwnerArrival(r, { ts: now - 1 * H, channelId: "g", isDm: false, content: "hi" });
    expect(await reachBackoff(r, now, {})).toEqual(NO_BACKOFF);
  });

  it("REACH_BACKOFF=off: no hold, but stale rows still settle and log", async () => {
    const { r } = fakeRedis();
    const now = 1_000_000_000_000;
    await recordReachSend(r, send("a", now - 30 * H));
    await recordReachSend(r, send("b", now - 1 * H));
    expect(await reachBackoff(r, now, { REACH_BACKOFF: "off" })).toEqual(NO_BACKOFF);
    expect(logs.some(l => l.includes("outcome=unanswered id=a"))).toBe(true);
  });

  it("no Redis, or a Redis that throws, fails OPEN", async () => {
    expect(await reachBackoff(null)).toEqual(NO_BACKOFF);
    const bad = { zrevrange: async () => { throw new Error("down"); } } as unknown as import("../floor.js").Redis;
    expect(await reachBackoff(bad)).toEqual(NO_BACKOFF);
    await expect(recordReachSend(bad, send("m", 1))).resolves.toBeUndefined();
    expect(await noteOwnerArrival(bad, { channelId: "g", isDm: false })).toBe(0);
  });

  it("the filter drops only DM moves, and spares the exempt ones", () => {
    const acts = [{ action_type: "flirt" }, { action_type: "offer_presence" }, { action_type: "post_heartbeat" }, { action_type: "nothing" }];
    const isDm = (t: string) => t === "flirt" || t === "offer_presence";
    const hold = { streak: 1, gapMs: H, waitMs: H, blocked: true, lastSendTs: 0 };
    expect(filterDmMovesForBackoff(acts, hold, isDm).map(a => a.action_type)).toEqual(["post_heartbeat", "nothing"]);
    expect(filterDmMovesForBackoff(acts, hold, isDm, t => t === "offer_presence").map(a => a.action_type)).toEqual(["offer_presence", "post_heartbeat", "nothing"]);
    expect(filterDmMovesForBackoff(acts, NO_BACKOFF, isDm)).toBe(acts);
  });
});

describe("through the real heartbeat", () => {
  const tick = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as { outcome: string; action?: string });
  let restore: () => void = () => {};
  afterEach(() => restore());
  beforeEach(() => { process.env["REACH_DM"] = "on"; });

  const flirtCtx = (r: import("../floor.js").Redis) => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "tail's up", lines: ["Tail's twitching."] });
    (h.ctx as { redis: unknown }).redis = r;
    return h;
  };

  it("a DM send records a ledger row (ids only); the next tick, with that send ignored, holds the DM move", async () => {
    restore = inWindowOf("drevan");
    const { r } = fakeRedis();
    const h1 = flirtCtx(r);
    await runHeartbeat(h1.ctx);
    expect(h1.dmSent).toEqual(["Tail's twitching."]);
    const rows = await readRecentRows(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "d1", companion: "drevan", action: "flirt", ch: "dm-owner", outcome: null });
    expect(logs.some(l => l === "[reach-ledger] sent id=d1 companion=drevan action=flirt")).toBe(true);
    expect(logs.join("\n")).not.toContain("Tail's twitching"); // no message text in any ledger line

    logs.length = 0;
    const h2 = flirtCtx(r);
    await runHeartbeat(h2.ctx);
    expect(h2.dmSent).toEqual([]);
    expect(h2.prompts[0]).not.toContain("(type: flirt"); // the DM move was dropped before the decision prompt
    expect(logs.some(l => l.includes("reach back-off: streak=1"))).toBe(true);
  });

  it("only DM moves in the palette and the back-off holds: outcome suppressed_reach_backoff, logged capped", async () => {
    restore = inWindowOf("drevan");
    const { r } = fakeRedis();
    await recordReachSend(r, { id: "old", companionId: "drevan", actionType: "flirt", channelId: "dm-owner", ts: Date.now() - 30 * 60_000 });
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["x"] });
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(tick().at(-1)).toMatchObject({ outcome: "suppressed_reach_backoff" });
  });

  it("after he replied, the same palette sends again (the back-off is only for ignored sends)", async () => {
    restore = inWindowOf("drevan");
    const { r } = fakeRedis();
    const t = Date.now();
    await recordReachSend(r, { id: "old", companionId: "drevan", actionType: "flirt", channelId: "dm-owner", ts: t - 30 * 60_000 });
    await noteOwnerArrival(r, { ts: t - 10 * 60_000, channelId: "g", isDm: false, content: "hi" });
    const h = flirtCtx(r);
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Tail's twitching."]);
  });

  it("REACH_BACKOFF=off sends as before even with an ignored send on the books", async () => {
    restore = inWindowOf("drevan");
    process.env["REACH_BACKOFF"] = "off";
    const { r } = fakeRedis();
    await recordReachSend(r, { id: "old", companionId: "drevan", actionType: "flirt", channelId: "dm-owner", ts: Date.now() - 30 * 60_000 });
    const h = flirtCtx(r);
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Tail's twitching."]);
  });

  it("channel moves are never held by the back-off", async () => {
    restore = inWindowOf("gaia");
    const { r } = fakeRedis();
    await recordReachSend(r, { id: "old", companionId: "gaia", actionType: "check_in_on_raziel", channelId: "dm-owner", ts: Date.now() - 30 * 60_000 });
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("post_heartbeat", "commons heartbeat")], choose: "commons heartbeat", lines: ["What holds."] });
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.channelSent.map(c => c.text)).toEqual(["What holds."]);
  });

  it("no Redis on the context: fails open, sends", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "tail's up", lines: ["Tail's twitching."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Tail's twitching."]);
  });
});
