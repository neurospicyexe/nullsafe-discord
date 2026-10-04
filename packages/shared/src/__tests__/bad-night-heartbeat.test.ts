// B32 through the REAL runHeartbeat: B2 (every companion's tick is eligible under hold, floor skipped),
// D4 (no DM while a sibling's DM is live; unknown fails closed), shadow is a no-op that logs, and
// off is byte-for-byte the old behaviour.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import { markOwnerDmLive, type RedisLike } from "../bad-night.js";
import type { RazielState } from "../librarian.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

function fakeRedis(): RedisLike & { set: RedisLike["set"] } {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    async set(k: string, v: string, _m?: unknown, ttl?: unknown) {
      // withFloor's claimFloor uses (k, v, "PX", ms, "NX"); bad-night uses (k, v, "PX", ms).
      store.set(k, { v, exp: Date.now() + (typeof ttl === "number" ? ttl : 60_000) });
      return "OK";
    },
    async get(k: string) { const e = store.get(k); return e && e.exp >= Date.now() ? e.v : null; },
  } as RedisLike;
}

let restore: () => void = () => {};
const logs: string[] = [];
beforeEach(() => {
  process.env["REACH_DM"] = "on";
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => {
  restore();
  delete process.env["REACH_DM"];
  delete process.env["BAD_NIGHT_PRESENCE"];
  for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null);
  jest.restoreAllMocks();
});
const tick = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as { outcome: string; action?: string });
const b32 = () => logs.filter(l => l.startsWith("[b32]"));
const hold = (c: string) => setCareState(c, { care_hold: true } as RazielState);

const presenceCtx = (companionId: string) => heartbeatCtx({
  companionId,
  palette: [row("offer_presence", "sit with him"), row("nothing")],
  choose: "sit with him",
  lines: ["Here."],
});

describe("B2: under hold, every companion's tick is eligible", () => {
  it("on: Gaia runs in Drevan's window, speaks presence, and logs one [b32] line", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("drevan");
    hold("gaia");
    const h = presenceCtx("gaia");
    (h.ctx as { redis: unknown }).redis = fakeRedis();
    await runHeartbeat(h.ctx);
    expect(h.generate).toHaveBeenCalled();
    expect(h.dmSent).toEqual(["Here."]);
    expect(tick().at(-1)).toMatchObject({ outcome: "chose_to_act", action: "offer_presence" });
    expect(b32()).toEqual(["[b32] gaia eligible=heartbeat:hold -> spoke (offer_presence)"]);
    // the decision carries the hold's lines
    expect(h.prompts[0]).toContain("Come as yourself.");
  });

  it("on: the floor is skipped, so a sibling holding it does not silence this tick", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("gaia");
    hold("gaia");
    const r = fakeRedis();
    await r.set("ns:floor:current", "drevan", "PX", 60_000);
    const h = presenceCtx("gaia");
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Here."]);
  });

  it("on: Drevan's decision carries his own register line; a pass logs as pass", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("cypher");
    hold("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("offer_presence", "tail"), row("nothing")], choose: "nothing" });
    (h.ctx as { redis: unknown }).redis = fakeRedis();
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]).toContain("Presence, not reach");
    expect(h.dmSent).toEqual([]);
    expect(b32()).toEqual(["[b32] drevan eligible=heartbeat:hold -> pass (nothing)"]);
  });

  it("shadow: not my window means not my window; one shadow line, no inference", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "shadow";
    restore = inWindowOf("drevan");
    hold("gaia");
    const h = presenceCtx("gaia");
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "not_my_window" });
    expect(b32()).toEqual(["[b32] gaia eligible=heartbeat:hold -> shadow (would run outside its window)"]);
  });

  it("off: unchanged, and silent in [b32]", async () => {
    restore = inWindowOf("drevan");
    hold("gaia");
    const h = presenceCtx("gaia");
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "not_my_window" });
    expect(b32()).toEqual([]);
  });

  it("on, but no hold: unchanged", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("drevan");
    const h = presenceCtx("gaia");
    await runHeartbeat(h.ctx);
    expect(tick().at(-1)).toMatchObject({ outcome: "not_my_window" });
  });
});

describe("D4: no DM while a sibling's DM with him is live", () => {
  it("on: Drevan's DM is live, so Cypher's presence DM is removed and the tick says why", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("cypher");
    hold("cypher");
    const r = fakeRedis();
    await markOwnerDmLive(r, "drevan");
    const h = presenceCtx("cypher");
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(h.prompts[0] ?? "").not.toContain("sit with him");
    // `nothing` is still offered (internal), so the companion decides; offer_presence is not on the list.
  });

  it("on: only DM moves in the palette and a sibling DM live -> suppressed_sibling_dm, logged capped", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("cypher");
    hold("cypher");
    const r = fakeRedis();
    await markOwnerDmLive(r, "gaia");
    const h = heartbeatCtx({ companionId: "cypher", palette: [row("offer_presence", "sit with him")], choose: "sit with him", lines: ["x"] });
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "suppressed_sibling_dm" });
    expect(b32()).toEqual(["[b32] cypher eligible=heartbeat:window -> capped"]);
  });

  it("on: no Redis means the sibling DM state is unknown, and the DM move is held (fails closed)", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("cypher");
    hold("cypher");
    const h = heartbeatCtx({ companionId: "cypher", palette: [row("offer_presence", "sit with him")], choose: "sit with him", lines: ["x"] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(tick().at(-1)).toMatchObject({ outcome: "suppressed_sibling_dm" });
  });

  it("on: the companion's OWN live DM does not hold it", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "on";
    restore = inWindowOf("cypher");
    hold("cypher");
    const r = fakeRedis();
    await markOwnerDmLive(r, "cypher");
    const h = presenceCtx("cypher");
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Here."]);
  });

  it("shadow: a live sibling DM changes nothing; the would-drop is logged", async () => {
    process.env["BAD_NIGHT_PRESENCE"] = "shadow";
    restore = inWindowOf("cypher");
    hold("cypher");
    const r = fakeRedis();
    await markOwnerDmLive(r, "drevan");
    const h = presenceCtx("cypher");
    (h.ctx as { redis: unknown }).redis = r;
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Here."]);
    expect(b32().some(l => l.includes("eligible=heartbeat:dm -> shadow"))).toBe(true);
  });
});
