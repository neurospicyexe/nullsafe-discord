// declare_preference (Wave 3, 2026-07-21; turned outward B7 2c, 2026-09-27).
//
// It used to be a Halseth-only internal act ("never Discord/generateOutward"). That contradicted
// COMPANION_CONSTITUTION_v1.md:99 ("Preferences are the opposite: not private"), so it now keeps the
// Halseth write AND says the same words in his DM, through the outward rails, from the companion's
// own heartbeat decision only (T-1, T-4). Still capped (never past 5 active) and still null-biased
// (NONE writes nothing). Driven through the real runHeartbeat, because a direct executor call has no
// companion origin and is refused by design (heartbeat-dm-route.test.ts).

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
afterEach(() => restore());
// These tests drive the DM lane as B7 2+2c built it, so they run with the REACH_DM switch ON
// (reach-dm-switch.test.ts covers off, the default).
beforeEach(() => { process.env["REACH_DM"] = "on"; });
afterEach(() => { delete process.env["REACH_DM"]; });

function run(lines: Array<string | null>, prefs = 0) {
  restore = inWindowOf("cypher");
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const h = heartbeatCtx({ companionId: "cypher", palette: [row("declare_preference", "a preference")], choose: "a preference", lines, prefs });
  return h;
}

describe("declare_preference", () => {
  it("skips (no generation, no reserve, no write) when 5+ preferences are already active", async () => {
    const h = run(["should never be reached"], 5);
    await runHeartbeat(h.ctx);
    expect(h.librarian.getPreferences).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledTimes(1); // the decision only
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
  });

  it("proceeds under the cap (4 active)", async () => {
    const h = run(["Domain: build\nPreference: I prefer building the boring layer first. It's where the bugs I actually like live."], 4);
    await runHeartbeat(h.ctx);
    expect(h.librarian.declarePreference).toHaveBeenCalledTimes(1);
    expect(h.dmSent).toHaveLength(1);
  });

  it.each([["NONE"], ["   "], [null]])("null-biased: %p writes nothing and sends nothing", async (reply) => {
    const h = run([reply]);
    await runHeartbeat(h.ctx);
    expect(h.librarian.declarePreference).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
  });

  it("parses the two-line shape, declares with both, and DMs the preference line itself", async () => {
    const h = run(["Domain: autonomy\nPreference: I prefer starting from the concrete example."]);
    await runHeartbeat(h.ctx);
    expect(h.librarian.declarePreference).toHaveBeenCalledWith("I prefer starting from the concrete example.", "autonomy");
    expect(h.dmSent).toEqual(["I prefer starting from the concrete example."]);
  });

  it("tolerates a model that ignores the shape: raw text is the preference, domain undefined", async () => {
    const h = run(["I just want to say I like starting from concrete examples."]);
    await runHeartbeat(h.ctx);
    expect(h.librarian.declarePreference).toHaveBeenCalledWith("I just want to say I like starting from concrete examples.", undefined);
  });

  it("a Halseth write failure is caught and logged, never thrown, and does not stop the line reaching him", async () => {
    const h = run(["Domain: work\nPreference: I prefer mornings."]);
    h.librarian.declarePreference.mockImplementation(async () => { throw new Error("Halseth 500"); });
    await expect(runHeartbeat(h.ctx)).resolves.toBeUndefined();
    expect(h.librarian.declarePreference).toHaveBeenCalledTimes(1);
    expect(h.dmSent).toEqual(["I prefer mornings."]);
  });
});
