// B64 final review wave: R25 (a failed tick never skips the tend, the appearance or the night; sleep runs on its
// own long-timeout route) and R27 (every model-voiced Sol line is sanitized before the webhook post).
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  tickCreatures: vi.fn(),
  getCreatures: vi.fn(),
  recordSolAppearance: vi.fn(),
  tendCreatureAs: vi.fn(),
  fetchCreatureMoment: vi.fn(),
  sleepCreature: vi.fn(),
  postSolMoment: vi.fn(),
}));

vi.mock("../halseth-client.js", () => ({
  tickCreatures: h.tickCreatures,
  getCreatures: h.getCreatures,
  recordSolAppearance: h.recordSolAppearance,
  tendCreatureAs: h.tendCreatureAs,
  fetchCreatureMoment: h.fetchCreatureMoment,
  sleepCreature: h.sleepCreature,
}));
vi.mock("../sol-presence.js", () => ({
  shouldSolAppear: () => true,
  postSolMoment: h.postSolMoment,
}));

import { runCreaturesTick } from "../creatures.js";

const HOSTILE = "*Sol shrieks @everyone <@123> `x` ||y|| ~~z~~\nat the rail.*";
const SLEEP = { ran: true, reason: "slept", created: 1, reinforced: 0, decayed: 0, promoted: 0, softened: 0, retired: 0 };

let logs: string[] = [];
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  process.env["SOL_WEBHOOK_URL"] = "https://discord.com/api/webhooks/1/x";
  // An untended, aloof Sol: the day's tend fires.
  h.getCreatures.mockResolvedValue([{ id: "sol1", name: "Sol", disposition: "aloof", last_interaction_at: null, created_at: "2026-01-01T00:00:00Z", state: "hungry" }]);
  h.tickCreatures.mockResolvedValue({ ok: true, ticked: 1, total: 1 });
  h.tendCreatureAs.mockResolvedValue({ milestones_fired: [], care: { fit: "met", reaction_named: HOSTILE } });
  h.fetchCreatureMoment.mockResolvedValue({ moment: HOSTILE, kind: "moment", state: "hungry" });
  h.sleepCreature.mockResolvedValue(SLEEP);
  h.postSolMoment.mockResolvedValue(true);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env["SOL_WEBHOOK_URL"]; });

describe("runCreaturesTick (R25)", () => {
  test("a tick that throws (e.g. a 15s timeout) still runs the tend, the appearance and the night", async () => {
    h.tickCreatures.mockRejectedValue(new Error("TimeoutError"));
    await expect(runCreaturesTick()).resolves.toBeUndefined();
    expect(h.tendCreatureAs).toHaveBeenCalledTimes(1);
    expect(h.fetchCreatureMoment).toHaveBeenCalledTimes(1);
    expect(h.sleepCreature).toHaveBeenCalledWith("sol1");
  });
  test("the night runs after the tend and the appearance, and its failure is non-fatal", async () => {
    const order: string[] = [];
    h.tendCreatureAs.mockImplementation(async () => { order.push("tend"); return { milestones_fired: [], care: null }; });
    h.fetchCreatureMoment.mockImplementation(async () => { order.push("moment"); return { moment: "*Sol.*", kind: "moment" }; });
    h.sleepCreature.mockImplementation(async () => { order.push("sleep"); throw new Error("boom"); });
    await expect(runCreaturesTick()).resolves.toBeUndefined();
    expect(order).toEqual(["tend", "moment", "sleep"]);
  });
  test("the sleep line logs the reason and counts", async () => {
    await runCreaturesTick();
    expect(logs.join("\n")).toContain("[creatures] Sol sleep: ran=true reason=slept created=1 reinforced=0 decayed=0 promoted=0 softened=0 retired=0");
  });
});

describe("Sol lines are sanitized before posting (R27)", () => {
  test("the voiced tend reaction and the moment go out clean, and the recorded appearance is the clean line", async () => {
    await runCreaturesTick();
    const posted = h.postSolMoment.mock.calls.map(c => String(c[1]));
    const voiced = posted.filter(t => t.includes("shrieks"));
    expect(voiced).toHaveLength(2);
    for (const t of voiced) {
      expect(t).toBe("*Sol shrieks @\u200beveryone x y z at the rail.*");
      expect(t).not.toMatch(/<@|[`|~\n]/);
    }
    expect(h.recordSolAppearance).toHaveBeenCalledWith("sol1", "*Sol shrieks @\u200beveryone x y z at the rail.*");
  });
});
