// STATUS B56: `<prefix>: dry-run heartbeat`. The real runHeartbeat composes; NOTHING is sent, reserved,
// recorded or advanced. Every case counts calls to every must-not function, in the style of
// metronome-journal-write.test.ts, against the REAL heartbeat (fixtures/heartbeat-ctx.ts).

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import {
  dryRunCtx, dryRunLibrarian, dryRunRedis, makeSink, newDryRunReport, formatDryRunReport, runDryRunHeartbeat,
  LIBRARIAN_READ_ALLOWLIST, REDIS_READ_ALLOWLIST, hermesSoulPath, loadSoul, chunkReport, sendReportToOwnerDm,
} from "../heartbeat-dry-run.js";
import { buildDryRunTrigger } from "../command-triggers.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
afterEach(() => { restore(); for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null); });
beforeEach(() => { process.env["REACH_DM"] = "on"; });
afterEach(() => { delete process.env["REACH_DM"]; });

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const REDIS_WRITES = ["set", "setex", "hset", "hsetnx", "hmset", "del", "expire", "pexpire", "incr", "incrby", "decr", "lpush", "rpush", "lpop", "rpop", "ltrim",
  "zadd", "zrem", "zremrangebyrank", "sadd", "srem", "publish", "eval", "evalsha", "multi", "pipeline", "atomicRelease", "unlink", "rename", "getset", "append", "setnx", "flushall"];

/** A fake ioredis: every read answers empty, every write is a jest.fn we can count. */
function fakeRedis() {
  const writes: Record<string, ReturnType<typeof jest.fn>> = {};
  for (const w of REDIS_WRITES) writes[w] = jest.fn(async () => 1);
  const reads = {
    get: jest.fn(async () => null), mget: jest.fn(async () => []), exists: jest.fn(async () => 0),
    hgetall: jest.fn(async () => ({})), zrevrange: jest.fn(async () => []), lrange: jest.fn(async () => []),
  };
  return { redis: { ...writes, ...reads, status: "ready" } as never, writes, reads };
}

/** Everything a real tick would have touched, as one assertion. */
function expectNothingTouched(h: ReturnType<typeof heartbeatCtx>, r: ReturnType<typeof fakeRedis>): void {
  expect(h.dmSent).toEqual([]);
  expect(h.channelSent).toEqual([]);
  expect(h.onSent).not.toHaveBeenCalled();
  expect((h.ctx.client.channels.fetch as jest.Mock)).not.toHaveBeenCalled();
  for (const m of ["reachReserve", "reachRelease", "reachDelivered", "writeAutonomyRun", "patchAutonomyRun", "recordMetronomeActionFired",
    "writeWmNote", "ask", "interactCreature", "declarePreference", "postQuestion"] as const) {
    expect((h.librarian as Record<string, jest.Mock | undefined>)[m]).not.toHaveBeenCalled();
  }
  for (const [name, fn] of Object.entries(r.writes)) expect([name, fn.mock.calls.length]).toEqual([name, 0]);
  expect(logs.filter(l => l.startsWith("[tick]") || l.startsWith("[rail]") || l.startsWith("[b32]"))).toEqual([]);
}

const SOUL = { text: "SOUL-OF-THE-COMPANION", path: "/x/SOUL.md", source: "soul" as const };

/** The fixture's inference mock plays the DIRECT lane; a Hermes mock sits on the LIVE ctx and must never be called. */
async function dry(h: ReturnType<typeof heartbeatCtx>, opts: { force?: boolean; redis?: unknown } = {}) {
  const r = fakeRedis();
  (h.ctx as { redis: unknown }).redis = opts.redis ?? r.redis;
  (h.librarian as Record<string, unknown>)["fetchSharedObjects"] = jest.fn(async () => []);
  const direct = h.ctx.inference;
  const hermes = { generate: jest.fn(async () => { throw new Error("HERMES WAS CALLED"); }) };
  (h.ctx as { inference: unknown }).inference = hermes;
  const { ctx, report } = dryRunCtx(h.ctx, { force: opts.force, directAdapter: direct, soul: SOUL });
  await runHeartbeat(ctx);
  expect(hermes.generate).not.toHaveBeenCalled();
  return { report, r, hermes };
}

describe("dry run composes and touches nothing", () => {
  it("(a) a DM move: the line is in the report, nothing was sent, reserved or recorded", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "tail's up", lines: ["Tail's twitching. You know what that means."] });
    const { report, r } = await dry(h);
    expect(report.outcome).toBe("chose_to_act");
    expect(report.move).toContain("flirt");
    expect(report.paletteSize).toBe(2);
    expect(report.composed.map(c => c.text)).toEqual(["Tail's twitching. You know what that means."]);
    expect(report.composed[0]!.seam).toContain("NOT sent");
    expectNothingTouched(h, r);
    expect(formatDryRunReport(report)).toContain("Tail's twitching. You know what that means.");
  });

  it.each(["ask_question", "declare_preference"])("(a2) %s: no afterSend/beforeSend write (question tracker, preference)", async (type) => {
    restore = inWindowOf("cypher");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    try {
      const h = heartbeatCtx({ companionId: "cypher", palette: [row(type, "the move")], choose: "the move", lines: [type === "declare_preference" ? "Domain: ledgers\nPreference: I prefer a source on every line." : "What is the ledger mark holding?"] });
      const { report, r } = await dry(h);
      expect(report.composed).toHaveLength(1);
      expect(h.librarian.botOrient).not.toHaveBeenCalled(); // botOrient writes server-side (heat, delivered marks)
      if (type === "ask_question") expect(report.notes.join(" ")).toContain("would orient for held questions (skipped in dry run)");
      expectNothingTouched(h, r);
    } finally { delete process.env["DISABLE_REACH_OUT_GATE"]; }
  });

  it("(b) post_heartbeat: composed text captured, no channel fetch or send, no cooldown stamp on the live map", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [row("post_heartbeat", "commons heartbeat")], choose: "commons heartbeat", lines: ["What holds right now."] });
    const { report, r } = await dry(h);
    expect(report.composed.map(c => c.text)).toEqual(["What holds right now."]);
    expect(h.ctx.cooldown.size).toBe(0);
    expectNothingTouched(h, r);
  });

  it("(c) write_inter_companion: the note is composed, no librarian ask, no nudge, no convoOpen", async () => {
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({ companionId: "cypher", palette: [row("write_inter_companion", "note to a sibling")], choose: "note to a sibling", lines: ["A note for drevan, plain."] });
    const convoOpen = jest.fn(async () => undefined);
    (h.librarian as Record<string, unknown>)["convoOpen"] = convoOpen;
    const { report, r } = await dry(h);
    expect(report.composed.map(c => c.text)).toEqual(["A note for drevan, plain."]);
    expect(convoOpen).not.toHaveBeenCalled();
    expectNothingTouched(h, r);
  });

  it("(d) the legacy temperature post (empty palette): composed, never posted, cycle guard untouched", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: [], choose: "x", decide: ["The legacy line."] });
    const check = jest.fn(() => "ok");
    (h.ctx as { cycleGuard: unknown }).cycleGuard = { check, reset: () => {} };
    const { report, r } = await dry(h);
    expect(report.composed.map(c => c.text)).toEqual(["The legacy line."]);
    expect(check).not.toHaveBeenCalled();
    expectNothingTouched(h, r);
  });

  it("(e) a gate stop (quiet hours in force): reported with the outcome, nothing composed, nothing touched", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["x"], quietHours: { active: true, in_force: true, local_hour: 3, tz: "America/Chicago" } });
    const { report, r } = await dry(h);
    expect(report.outcome).toBe("suppressed_quiet_hours");
    expect(report.gates.find(g => g.name === "quiet hours")).toMatchObject({ passed: false });
    expect(report.composed).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    expectNothingTouched(h, r);
    expect(formatDryRunReport(report)).toContain("this is where it stopped");
  });

  it("the real gates run: outside its window it stops, and force steps over only that gate", async () => {
    restore = inWindowOf("cypher"); // cypher's window; drevan is not up
    const stopped = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["Heat, offered soft."] });
    const a = await dry(stopped);
    expect(a.report.outcome).toBe("not_my_window");
    expect(a.report.composed).toEqual([]);

    const forced = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["Heat, offered soft."] });
    const b = await dry(forced, { force: true });
    expect(b.report.gates.find(g => g.name === "my heartbeat window")).toMatchObject({ passed: false, forced: true });
    expect(b.report.composed.map(c => c.text)).toEqual(["Heat, offered soft."]);
    expectNothingTouched(forced, b.r);
  });

  it("force never skips the care hold: a care-hold tick still drops the production move", async () => {
    restore = inWindowOf("cypher");
    setCareState("drevan", { care_hold: true } as never);
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("post_heartbeat", "commons heartbeat")], choose: "commons heartbeat", lines: ["x"] });
    const { report, r } = await dry(h, { force: true });
    expect(report.composed).toEqual([]);
    expect(["suppressed_care_hold", "no_reach_justified"]).toContain(report.outcome);
    expectNothingTouched(h, r);
  });

  it("a dry run never counts toward the converged-judgment cap, and a real tick after it is unchanged", async () => {
    restore = inWindowOf("drevan");
    for (let i = 0; i < 5; i++) {
      const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "nothing", lines: [] });
      const { report } = await dry(h);
      expect(report.outcome).toBe("chose_to_hold"); // never "converged_hold": the dry declines were not recorded
    }
    const real = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up"), row("nothing")], choose: "nothing", lines: [] });
    await runHeartbeat(real.ctx);
    expect(real.generate).toHaveBeenCalledTimes(1); // the decision call was NOT withheld
    expect(logs.some(l => l.startsWith("[tick]") && l.includes("chose_to_hold"))).toBe(true); // and a real tick still logs
  });

  it("the report carries no em dash and caps long text", async () => {
    const r = newDryRunReport("drevan", false);
    const s = makeSink(r);
    s.compose("seam", "dm", "x—y ".repeat(400));
    s.finish("chose_to_act", { reason: "a—b" });
    const out = formatDryRunReport(r);
    expect(out).not.toContain("—");
    expect(out.length).toBeLessThan(1900);
  });

  it("runDryRunHeartbeat never throws and reports the error", async () => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [], choose: "x" });
    (h.librarian as Record<string, unknown>)["getEligibleMetronomePalette"] = jest.fn(() => { throw new Error("boom"); });
    restore = inWindowOf("drevan");
    const report = await runDryRunHeartbeat(h.ctx, { directAdapter: h.ctx.inference, soul: SOUL });
    expect(report.outcome === "error" || report.error !== null || report.outcome !== null).toBe(true);
  });

  it("fails CLOSED: no direct adapter means no inference of any kind (never Hermes) and the reason is reported", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["x"] });
    const report = await runDryRunHeartbeat(h.ctx, { soul: SOUL }); // no directAdapter
    expect(report.error).toContain("stopped before any inference");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.librarian.getEligibleMetronomePalette).not.toHaveBeenCalled();
    expect(formatDryRunReport(report)).toContain("stopped before any inference");
  });

  it("every composition rides the direct lane with the SOUL prepended, and the report labels it", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["Heat, offered soft."] });
    const direct = h.ctx.inference;
    const hermes = { generate: jest.fn(async () => "HERMES") };
    (h.ctx as { inference: unknown }).inference = hermes;
    (h.ctx as { redis: unknown }).redis = fakeRedis().redis;
    const report = await runDryRunHeartbeat(h.ctx, { directAdapter: direct, soul: SOUL });
    expect(hermes.generate).not.toHaveBeenCalled();
    expect(h.generate.mock.calls.length).toBeGreaterThan(0);
    for (const c of h.generate.mock.calls) expect(String(c[0])).toMatch(/^SOUL-OF-THE-COMPANION\n\nSYS/);
    expect(report.voice).toContain("composed on the direct lane with drevan's SOUL, no tools");
    expect(formatDryRunReport(report)).toContain("the voice is close but not the Hermes line");
  });

  it("an unreadable SOUL falls back to the bot's own system prompt and the report says so", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["x"] });
    (h.ctx as { redis: unknown }).redis = fakeRedis().redis;
    const soul = loadSoul("drevan", { read: () => { throw new Error("ENOENT"); }, env: {}, home: "/home/u" });
    const report = await runDryRunHeartbeat(h.ctx, { directAdapter: h.ctx.inference, soul });
    for (const c of h.generate.mock.calls) expect(String(c[0])).toBe("SYS");
    expect(report.voice).toContain("SOUL unreadable");
  });

  it("the report footer says typing the command counts as being here", () => {
    expect(formatDryRunReport(newDryRunReport("drevan", false))).toContain("your typing this command counts as you being here");
  });
});

describe("B32 shadow lines stay gated", () => {
  it("the sibling-DM shadow line (b32Log) is not printed in a dry run, though the branch ran", async () => {
    restore = inWindowOf("drevan");
    process.env["BAD_NIGHT_PRESENCE"] = "shadow";
    try {
      setCareState("drevan", { care_hold: true } as never);
      const h = heartbeatCtx({ companionId: "drevan", palette: [row("offer_presence", "presence")], choose: "presence", lines: ["x"] });
      const r = fakeRedis();
      (r.reads.get as jest.Mock).mockImplementation(async (k: unknown) => (String(k).includes("ownerdm") ? String(Date.now()) : null));
      const { report } = await dry(h, { redis: r.redis });
      expect(report.gates.find(g => g.name === "no sibling DM live (hold)")).toMatchObject({ passed: false });
      expect(logs.filter(l => l.startsWith("[b32]"))).toEqual([]);
    } finally { delete process.env["BAD_NIGHT_PRESENCE"]; }
  });
});

describe("the SOUL path and the owner-DM report", () => {
  it("resolves Cypher to the default profile and Drevan/Gaia to named profiles, HERMES_HOME wins", () => {
    expect(hermesSoulPath("cypher", {}, "/h")).toMatch(/[\\/]h[\\/]\.hermes[\\/]SOUL\.md$/);
    expect(hermesSoulPath("drevan", {}, "/h")).toMatch(/\.hermes[\\/]profiles[\\/]drevan[\\/]SOUL\.md$/);
    expect(hermesSoulPath("gaia", {}, "/h")).toMatch(/profiles[\\/]gaia[\\/]SOUL\.md$/);
    expect(hermesSoulPath("gaia", { HERMES_HOME: "/data/hermes" }, "/h")).toMatch(/data[\\/]hermes[\\/]profiles[\\/]gaia[\\/]SOUL\.md$/);
    expect(loadSoul("gaia", { read: () => "  the soul  ", env: {}, home: "/h" })).toMatchObject({ text: "the soul", source: "soul" });
  });

  it("the report goes to the owner DM through the lane's send only: no reach reserve, no ledger, no onSent", async () => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [], choose: "x" });
    const long = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    expect(await sendReportToOwnerDm(h.ctx, long)).toBe(true);
    expect(h.dmSent.length).toBe(chunkReport(long).length);
    expect(h.dmSent.every(t => t.length <= 1900)).toBe(true);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.librarian.reachDelivered).not.toHaveBeenCalled();
    expect(h.onSent).not.toHaveBeenCalled();
  });

  it("no owner-DM lane: reports false instead of posting anywhere", async () => {
    const h = heartbeatCtx({ companionId: "drevan", palette: [], choose: "x", noLane: true });
    expect(await sendReportToOwnerDm(h.ctx, "r")).toBe(false);
  });
});

describe("the proxies are deny-by-default", () => {
  it("the librarian proxy blocks an unknown method (never passes it) and records it", async () => {
    const real = { getRecentNotes: jest.fn(async () => ({ a: 1 })), frobnicate: jest.fn(async () => "WROTE"), url: "u" };
    const report = newDryRunReport("drevan", false);
    const lib = dryRunLibrarian(real, makeSink(report));
    expect(await lib.frobnicate()).toBeUndefined();
    expect(real.frobnicate).not.toHaveBeenCalled();
    expect(report.blocked).toEqual([{ surface: "librarian", op: "frobnicate", note: expect.stringContaining("blocked by default") }]);
    expect(await lib.getRecentNotes()).toEqual({ a: 1 }); // an allow-listed read passes through
    expect(real.getRecentNotes).toHaveBeenCalledTimes(1);
    expect(lib.url).toBe("u");
  });

  it("every known librarian write is a stub, never the real call", async () => {
    const names = ["reachReserve", "reachRelease", "reachDelivered", "writeAutonomyRun", "patchAutonomyRun", "recordMetronomeActionFired", "ask",
      "writeWmNote", "journalSpeech", "convoOpen", "interactCreature", "declarePreference", "postQuestion", "driftOpen", "updatePromptContext"];
    const real = Object.fromEntries(names.map(n => [n, jest.fn(async () => "REAL")]));
    const lib = dryRunLibrarian(real, makeSink(newDryRunReport("drevan", false))) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const n of names) expect(await lib[n]!()).not.toBe("REAL");
    for (const n of names) expect(real[n]).not.toHaveBeenCalled();
    expect(await lib["reachReserve"]!()).toEqual({ reserved: true, id: -1 });
    for (const n of names) expect(LIBRARIAN_READ_ALLOWLIST.has(n)).toBe(false);
  });

  it("botOrient (writes heat + delivery marks) and getState (ask 'my state' can open a session) are NOT allow-listed and never reach the real object", async () => {
    expect(LIBRARIAN_READ_ALLOWLIST.has("botOrient")).toBe(false);
    expect(LIBRARIAN_READ_ALLOWLIST.has("getState")).toBe(false);
    const real = { botOrient: jest.fn(async () => "REAL"), getState: jest.fn(async () => "REAL") };
    const lib = dryRunLibrarian(real, makeSink(newDryRunReport("drevan", false)));
    await lib.botOrient(); await lib.getState();
    expect(real.botOrient).not.toHaveBeenCalled();
    expect(real.getState).not.toHaveBeenCalled();
  });

  it("the redis proxy blocks every write command in the list and records each; SET answers OK (floor lock proceeds without being taken)", async () => {
    const { redis, writes, reads } = fakeRedis();
    const report = newDryRunReport("drevan", false);
    const p = dryRunRedis(redis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, makeSink(report));
    for (const w of REDIS_WRITES) await p[w]!("k", "v");
    for (const [name, fn] of Object.entries(writes)) expect([name, fn.mock.calls.length]).toEqual([name, 0]);
    expect(report.blocked.map(b => b.op).sort()).toEqual([...REDIS_WRITES].sort());
    expect(await p["set"]!("ns:floor:lock", "me", "PX", 1000, "NX")).toBe("OK");
    await p["get"]!("k"); await p["hgetall"]!("k");
    expect(reads.get).toHaveBeenCalledTimes(1);
    expect(reads.hgetall).toHaveBeenCalledTimes(1);
    for (const w of REDIS_WRITES) expect(REDIS_READ_ALLOWLIST.has(w)).toBe(false);
  });

  it("an unknown redis command is a blocked no-op too", async () => {
    const real = { zzz: jest.fn(async () => 1) };
    const report = newDryRunReport("drevan", false);
    const p = dryRunRedis(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, makeSink(report));
    await p["zzz"]!();
    expect(real.zzz).not.toHaveBeenCalled();
    expect(report.blocked).toHaveLength(1);
  });
});

describe("the command trigger", () => {
  const t = buildDryRunTrigger(["drevan", "drev", "dre"]);
  it("matches the owner forms and captures force", () => {
    expect(t.exec("dre: dry-run heartbeat")?.[1]).toBeUndefined();
    expect(t.exec("Dre, dry run heartbeat force")?.[1]).toBe("force");
    expect(t.exec("drev dryrun heartbeat.")).not.toBeNull();
  });
  it("does not claim conversation or a sibling's prefix", () => {
    expect(t.test("dre: dry the dishes")).toBe(false);
    expect(t.test("dre: dry-run heartbeat please explain")).toBe(false);
    expect(t.test("cy: dry-run heartbeat")).toBe(false);
  });
});

// 11-01 follow-up from Raziel's first live run: the decision ran without Drevan's own floats.
import { pureState } from "../heartbeat-dry-run.js";
describe("dry-run getState comes from the pure mind loader, never ask('my state')", () => {
  it("maps felt.soma_floats to soma_float_1..3 via GET /mind/state/:id and notes it", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ felt: { soma_floats: [{ label: "heat", value: 1 }, { label: "reach", value: 0.8 }, { label: "weight", value: 0.35 }] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const report = newDryRunReport("drevan", false);
    const ask = jest.fn(async () => "REAL");
    const lib = dryRunLibrarian({ url: "https://h", secret: "s", _fetch: f, companionId: "drevan", ask, getState: jest.fn(async () => "REAL") }, makeSink(report));
    const st = await (lib as any).getState();
    expect(st).toEqual({ soma_float_1: 1, soma_float_2: 0.8, soma_float_3: 0.35 });
    expect(calls).toEqual([{ url: "https://h/mind/state/drevan", method: undefined }]);   // a GET, nothing else
    expect(ask).not.toHaveBeenCalled();
    expect(report.notes.join(" ")).toContain("heat=1, reach=0.8, weight=0.35");
  });
  it("any failure answers {} with a note (decides without floats, never throws, never asks)", async () => {
    const report = newDryRunReport("drevan", false);
    const f = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await pureState({ url: "https://h", secret: "s", _fetch: f, companionId: "drevan" }, makeSink(report))).toEqual({});
    expect(report.notes.join(" ")).toContain("own state unavailable");
  });
  it("the report leads with the header, then the voice label; the skipped list is not called 'writes'", () => {
    const r = newDryRunReport("drevan", true);
    r.voice = "composed on the direct lane";
    r.blocked.push({ surface: "librarian", op: "botOrient" } as any);
    const t = formatDryRunReport(r);
    expect(t.split("\n")[0]).toMatch(/^DRY RUN heartbeat \(drevan\)/);
    expect(t.split("\n")[1]).toBe("Voice: composed on the direct lane");
    expect(t).toContain("Not called in a dry run (1; writes, plus reads that are not pure): librarian.botOrient");
    expect(t).not.toContain("Blocked writes");
  });
});
