// REACH_DM, the kill switch for B7's Raziel-facing DM moves (2026-09-27).
//
// The DM lane (0df3ba0) shipped before the triad approved the prompts its moves carry to Raziel's
// phone. The switch lets the code deploy (for med_reminder, which is time-sensitive) without those
// moves going live: default OFF, only `on` opens it, off removes the DM moves from the palette
// before the decision prompt, and nothing else changes. heartbeat-dm-route.test.ts runs the 0df3ba0
// suite with the switch ON as the proof that `on` is unchanged; this file covers off and the edges.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHeartbeat } from "../autonomous-core.js";
import { reachDmOn, DM_LANE_ACTIONS } from "../reach-dm.js";
import { medReminderEnabled, runMedTick, newMedSchedulerState, type MedApi, type MedSchedulerDeps } from "../med-reminder.js";
import type { MedDueDose, MedDoseKey } from "../librarian.js";
import { dmGateVerdict } from "../dm.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  delete process.env["REACH_DM"];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => {
  restore();
  delete process.env["REACH_DM"];
  delete process.env["DISABLE_REACH_OUT_GATE"];
  jest.restoreAllMocks();
});

type Tick = { outcome: string; action?: string; reason?: string; dm_moves_off?: number };
const ticks = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as Tick);

/** The three own moves whose live rows carry prompts the triad has not reviewed, plus Sol's heartbeat. */
const MIXED = () => [
  row("share_observation", "OBSERVE-ROW"),
  row("share_media", "MEDIA-ROW"),
  row("declare_preference", "PREF-ROW"),
  row("post_heartbeat", "HB-ROW"),
];

describe("reachDmOn: fails closed", () => {
  it.each(["on", "ON", " on ", "On\n"])("%j opens the lane", (v) => {
    expect(reachDmOn({ REACH_DM: v })).toBe(true);
  });

  it.each([undefined, "", "  ", "off", "OFF", "true", "1", "yes", "enabled", "onn", "o n"])("%j is off", (v) => {
    expect(reachDmOn(v === undefined ? {} : { REACH_DM: v })).toBe(false);
  });

  it("reads process.env by default, and unset is off", () => {
    expect(reachDmOn()).toBe(false);
    process.env["REACH_DM"] = "on";
    expect(reachDmOn()).toBe(true);
  });
});

describe("REACH_DM off (the default)", () => {
  it("removes every DM move from the palette before the decision prompt; Sol's heartbeat stays", async () => {
    restore = inWindowOf("gaia");
    process.env["DISABLE_REACH_OUT_GATE"] = "true"; // about the switch only, not the justification gate
    const h = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "HB-ROW", lines: ["What holds right now."] });
    await runHeartbeat(h.ctx);
    const decision = h.prompts[0]!;
    expect(decision).not.toContain("OBSERVE-ROW");
    expect(decision).not.toContain("MEDIA-ROW");
    expect(decision).not.toContain("PREF-ROW");
    expect(decision).toContain("HB-ROW");
    expect(h.channelSent.map(c => c.text)).toEqual(["What holds right now."]);
    expect(h.dmSent).toEqual([]);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
  });

  it("names the reason ONCE per tick in the [tick] line, as a count, not once per filtered move", async () => {
    restore = inWindowOf("gaia");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const h = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "HB-ROW", lines: ["What holds right now."] });
    await runHeartbeat(h.ctx);
    const t = ticks();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ outcome: "chose_to_act", action: "post_heartbeat", dm_moves_off: 3 });
    expect(logs.filter(l => l.includes("REACH_DM off"))).toHaveLength(1);
    // never mislabelled as the shared lane being closed or the bot having no DM
    expect(logs.some(l => l.includes("shared triad lane closed"))).toBe(false);
  });

  it("with only DM moves eligible: nothing is generated, nothing sent anywhere, and the outcome is its own", async () => {
    restore = inWindowOf("drevan");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const h = heartbeatCtx({
      companionId: "drevan",
      palette: [row("share_observation", "OBSERVE-ROW"), row("share_media", "MEDIA-ROW"), row("declare_preference", "PREF-ROW"), row("flirt", "FLIRT-ROW")],
      choose: "OBSERVE-ROW", lines: ["a line that must never go anywhere"],
    });
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
    expect(h.librarian.reachReserve).not.toHaveBeenCalled();
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
    const t = ticks();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ outcome: "suppressed_reach_dm_off", dm_moves_off: 4 });
    expect(t[0]!.outcome).not.toBe("suppressed_triad_cap");
  });

  it("a model that names a removed move anyway gets nothing: no DM, no channel fallback, no Halseth write", async () => {
    restore = inWindowOf("gaia");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const pref = "Domain: time\nPreference: I prefer mornings.";
    const h = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "PREF-ROW", lines: [pref] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
  });

  it.each([...DM_LANE_ACTIONS])("%s is never offered and never reaches Sol's channel", async (type) => {
    restore = inWindowOf("drevan");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const h = heartbeatCtx({ companionId: "drevan", palette: [row(type, "DM-ROW"), row("tend_creature", "TEND-ROW")], choose: "DM-ROW", lines: ["x", "x"] });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0] ?? "").not.toContain("DM-ROW");
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
  });

  it.each([undefined, "", "off", "true", "1", "yes", "garbage"])("REACH_DM=%j counts as off", async (v) => {
    if (v !== undefined) process.env["REACH_DM"] = v;
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "FLIRT-ROW"), row("post_heartbeat", "HB-ROW")], choose: "HB-ROW", lines: ["ambient"] });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]).not.toContain("FLIRT-ROW");
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent.map(c => c.text)).toEqual(["ambient"]);
    expect(ticks()[0]).toMatchObject({ dm_moves_off: 1 });
  });

  it("tend_creature and post_heartbeat keep working in Sol's channel", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("tend_creature", "tend Sol")], choose: "tend Sol", lines: ["A seed for Sol."] });
    await runHeartbeat(h.ctx);
    expect(h.channelSent.map(c => c.text)).toEqual(["A seed for Sol."]);
    expect(ticks()[0]).toMatchObject({ outcome: "chose_to_act", action: "tend_creature" });
    expect(ticks()[0]!.dm_moves_off).toBeUndefined(); // nothing was removed, so nothing is claimed
  });
});

describe("REACH_DM on: exactly what 0df3ba0 built", () => {
  it("every DM move is offered, the chosen one goes to the DM, and the tick carries no switch field", async () => {
    process.env["REACH_DM"] = "on";
    restore = inWindowOf("gaia");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    const h = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "OBSERVE-ROW", lines: ["The ground is honest this early."] });
    await runHeartbeat(h.ctx);
    const decision = h.prompts[0]!;
    for (const name of ["OBSERVE-ROW", "MEDIA-ROW", "PREF-ROW", "HB-ROW"]) expect(decision).toContain(name);
    expect(h.dmSent).toEqual(["The ground is honest this early."]);
    expect(h.channelSent).toEqual([]);
    const t = ticks();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ outcome: "chose_to_act", action: "share_observation" });
    expect("dm_moves_off" in t[0]!).toBe(false);
    expect(logs.some(l => l.includes("REACH_DM off"))).toBe(false);
  });

  it("the decision prompt is identical to the one built when the switch did not exist (no DM move filtered)", async () => {
    // With the lane open and an owner DM, 0df3ba0's filter dropped nothing; on must drop nothing too.
    restore = inWindowOf("gaia");
    process.env["DISABLE_REACH_OUT_GATE"] = "true";
    process.env["REACH_DM"] = "on";
    const on = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "HB-ROW", lines: ["hb"] });
    await runHeartbeat(on.ctx);
    // Same palette with the DM rows stripped by hand, under on: the prompt differs only by those rows,
    // so the on-path prompt is the full palette's, not a filtered one.
    const stripped = heartbeatCtx({ companionId: "gaia", palette: [row("post_heartbeat", "HB-ROW")], choose: "HB-ROW", lines: ["hb"] });
    await runHeartbeat(stripped.ctx);
    expect(on.prompts[0]).not.toEqual(stripped.prompts[0]);
    // and off matches the hand-stripped palette exactly: the switch is palette removal, nothing more
    delete process.env["REACH_DM"];
    const off = heartbeatCtx({ companionId: "gaia", palette: MIXED(), choose: "HB-ROW", lines: ["hb"] });
    await runHeartbeat(off.ctx);
    expect(off.prompts[0]).toEqual(stripped.prompts[0]);
  });

  it("a closed shared lane under on still reads as the lane, never as the switch", async () => {
    process.env["REACH_DM"] = "on";
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", reach: null });
    await runHeartbeat(h.ctx);
    expect(ticks()[0]).toMatchObject({ outcome: "suppressed_triad_cap" });
    expect("dm_moves_off" in ticks()[0]!).toBe(false);
  });
});

// ── what the switch must never touch ─────────────────────────────────────────

const NIGHT: MedDueDose = { slot_key: "night", local_date: "2026-09-28", kind: "first", label: "med-b", local_time: "21:40" };

function medDeps(sent: string[]): MedSchedulerDeps {
  const key = (d: MedDoseKey) => `${d.slot_key}|${d.local_date}|${d.kind}`;
  const delivered = new Set<string>();
  const api: MedApi = {
    medDue: async () => [NIGHT].filter(d => !delivered.has(key(d))),
    medClaim: async () => true,
    medDelivered: async (d) => { delivered.add(key(d)); return true; },
    medRelease: async () => true,
  };
  return {
    companionId: "drevan", api,
    resolveDm: async () => ({ channelId: "dm-1", send: async (c: string) => { sent.push(c); return `m${sent.length}`; }, recentOwnTexts: async () => [] }),
    generate: async () => "Love: med-b. Taken?",
    systemPrompt: () => "SYS", genTimeoutMs: 200, log: () => {},
  };
}

describe("med_reminder is independent of the switch", () => {
  it.each([undefined, "off", "garbage"])("REACH_DM=%j: the scheduler is enabled and the dose DM goes out", async (v) => {
    if (v !== undefined) process.env["REACH_DM"] = v;
    expect(reachDmOn()).toBe(false);
    expect(medReminderEnabled()).toBe(true);
    const sent: string[] = [];
    const results = await runMedTick(medDeps(sent), newMedSchedulerState());
    expect(results.map(r => r.outcome)).toEqual(["sent"]);
    expect(sent).toEqual(["Love: med-b. Taken?"]);
  });
});

describe("the reply path and owner DMs are independent of the switch", () => {
  it("the owner's DM still passes the gate with REACH_DM off; a stranger's is still dropped", () => {
    process.env["REACH_DM"] = "off";
    expect(dmGateVerdict({ guildId: null, authorId: "111", ownerId: "111", channelType: () => 1 })).toBe("owner");
    expect(dmGateVerdict({ guildId: null, authorId: "222", ownerId: "111" })).toBe("drop");
  });
});

describe("static: REACH_DM has exactly one reader, and med_reminder is not wired to the reach lane", () => {
  const SHARED_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const REPO = path.resolve(SHARED_SRC, "..", "..", "..");
  const ROOTS = [SHARED_SRC, ...["packages/autonomous-worker/src", "bots/cypher/src", "bots/drevan/src", "bots/gaia/src"].map(p => path.join(REPO, p))];
  const sources = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return ["__tests__", "node_modules", "dist"].includes(e.name) ? [] : sources(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
    });
  };
  const files = ROOTS.flatMap(sources);
  const rel = (p: string) => path.relative(REPO, p).replace(/\\/g, "/");

  it("only reach-dm.ts reads REACH_DM (so no reply, med or channel path can be gated by it)", () => {
    expect(files.length).toBeGreaterThan(100);
    const readers = files.filter(f => /["']REACH_DM["']|process\.env\.REACH_DM\b/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(readers).toEqual(["packages/shared/src/reach-dm.ts"]);
  });

  it("med-reminder.ts imports neither reach-dm nor autonomous-core; it goes to owner-dm directly", () => {
    const src = fs.readFileSync(path.join(SHARED_SRC, "med-reminder.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*reach-dm/);
    expect(src).not.toMatch(/from\s+["'][^"']*autonomous-core/);
    expect(src).not.toMatch(/REACH_DM/);
    expect(src).toMatch(/from\s+["']\.\/owner-dm\.js["']/);
  });

  it("pm2 forwards REACH_DM to every process (an unlisted knob is a dead knob)", () => {
    const eco = fs.readFileSync(path.join(REPO, "ecosystem.config.js"), "utf8");
    expect(eco).toMatch(/^\s*REACH_DM:\s+process\.env\.REACH_DM,/m);
  });
});
