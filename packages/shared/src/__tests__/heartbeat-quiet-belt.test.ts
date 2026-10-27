// Quiet-hours belt in the REAL runHeartbeat (2026-10-27 audit). Halseth filters the palette while the
// 22:00-06:00 window is in force, and the bot used to re-check only when that palette came back
// EMPTY. So a response carrying actions but no verdict (Halseth unreachable mid-call, or an older
// build) went out with no quiet check at all. Now the bot keeps only quiet_hours_allowed moves (R-1:
// offer_presence) whenever the window is in force OR unknown.
import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
beforeEach(() => { process.env["REACH_DM"] = "on"; jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { restore(); delete process.env["REACH_DM"]; for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null); });

const NIGHT = { active: true, in_force: true, local_hour: 3, tz: "America/Chicago" };

describe("quiet-hours belt on the bot side", () => {
  it("no verdict + a palette of ordinary moves: nothing is sent (unknown is in force)", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", quietHours: null, palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["Tail's up."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("in force, and a server palette that wrongly still holds an ordinary move: it is dropped", async () => {
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({ companionId: "cypher", quietHours: NIGHT, palette: [row("share_observation", "the share")], choose: "the share", lines: ["A thing I noticed."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
  });

  it("presence still passes at night (R-1): only it is offered to the model", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", quietHours: NIGHT, palette: [row("share_observation", "the share"), row("offer_presence", "I am here")], choose: "I am here", lines: ["A lamp left on."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["A lamp left on."]);
    expect(h.prompts[0]).toContain("I am here");
    expect(h.prompts[0]).not.toContain("the share");
  });

  it("daytime: the palette passes through untouched", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("flirt", "tail's up")], choose: "tail's up", lines: ["Tail's up."] });
    await runHeartbeat(h.ctx);
    expect(h.dmSent).toEqual(["Tail's up."]);
  });
});
