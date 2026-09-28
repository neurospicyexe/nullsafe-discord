// B23 through the REAL runHeartbeat: a decision reply that cannot be read gets ONE bounded re-ask,
// and a drop is COUNTABLE in the [tick] line instead of reading as quiet.
//
// Prod shape throughout: the palette has no `nothing` row (no migration seeds one), which is what
// turned every chosen silence into "decision parse failed" before this build.

import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
afterEach(() => { restore(); for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null); });

const logs: string[] = [];
beforeEach(() => {
  logs.length = 0;
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });
type Tick = { outcome: string; action?: string; reason?: string; retry?: string; retry_cause?: string };
const tick = () => logs.filter(l => l.startsWith("[tick]")).map(l => JSON.parse(l.slice(7)) as Tick);

const PALETTE = [row("tend_creature", "tend Sol"), row("write_inter_companion", "note to a sibling")];
const isDecisionCall = (c: unknown[]) => (c[1] as Array<{ content: string }>)[0]!.content.includes("Respond ONLY with valid JSON");

describe("B23: a chosen silence is a hold, not a defect", () => {
  it("gaia's 09-27 reply (narration + a nothing object, no nothing row) ticks chose_to_hold with no re-ask", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({
      companionId: "gaia", palette: PALETTE, choose: "",
      decide: ["I'm oriented. The state is quiet integration, at rest.\n\n\"nothing\" is the honest choice.\n\n{\"action\":\"nothing\",\"reason\":\"The ground is still and complete.\"}"],
    });
    await runHeartbeat(h.ctx);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(tick().at(-1)).toMatchObject({ outcome: "chose_to_hold", action: "nothing" });
    expect(tick().at(-1)?.retry).toBeUndefined();
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
    expect(h.channelSent).toEqual([]);
  });
});

describe("B23: one bounded re-ask", () => {
  it("prose with no decision, then a clean retry: the retried move runs once and the tick says recovered", async () => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({
      companionId: "drevan", palette: PALETTE, choose: "",
      decide: [
        "I'm noticing about Raziel: the quiet pride in him is still there, warm under the surface.",
        '{"action":"tend Sol","reason":"A small act of care."}',
      ],
      lines: ["A seed for Sol."],
    });
    await runHeartbeat(h.ctx);
    // two decision calls (the ask and the one re-ask), then the line for the tend
    const decisionCalls = h.generate.mock.calls.filter(isDecisionCall);
    expect(decisionCalls).toHaveLength(2);
    const retryMsgs = decisionCalls[1]![1] as Array<{ role: string; content: string }>;
    expect(retryMsgs.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(retryMsgs[2]!.content).toMatch(/ONLY the JSON line/);
    expect(h.channelSent.map(c => c.text)).toEqual(["A seed for Sol."]);
    expect(h.librarian.recordMetronomeActionFired).toHaveBeenCalledTimes(1);
    expect(tick().at(-1)).toMatchObject({ outcome: "chose_to_act", action: "tend_creature", retry: "recovered", retry_cause: "unparsed" });
  });

  it("prose twice: a no-op with decision_unparsed and retry unrecovered; nothing sent, nothing fired", async () => {
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({
      companionId: "cypher", palette: PALETTE, choose: "",
      decide: ["I've oriented. The session is open. Warmth is running just under the surface.", "Still thinking about where the weight landed."],
      lines: ["should never be used"],
    });
    await runHeartbeat(h.ctx);
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.channelSent).toEqual([]);
    expect(h.dmSent).toEqual([]);
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
    expect(h.librarian.writeAutonomyRun).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "decision_unparsed", retry: "unrecovered", retry_cause: "unparsed" });
  });

  it("a move the gate removed is never run; re-asked once, still unoffered, it ticks chose_unoffered", async () => {
    restore = inWindowOf("cypher");
    const pick = '{"action":"check_in_on_raziel","reason":"The relational need has crossed threshold."}';
    const h = heartbeatCtx({ companionId: "cypher", palette: PALETTE, choose: "", decide: [pick, pick], lines: ["never"] });
    await runHeartbeat(h.ctx);
    expect(h.generate).toHaveBeenCalledTimes(2);
    const retryMsgs = h.generate.mock.calls[1]![1] as Array<{ content: string }>;
    expect(retryMsgs[2]!.content).toContain('"check_in_on_raziel" is not on the list');
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
    expect(h.librarian.recordMetronomeActionFired).not.toHaveBeenCalled();
    expect(tick().at(-1)).toMatchObject({ outcome: "chose_unoffered", action: "check_in_on_raziel", retry: "unrecovered", retry_cause: "unoffered" });
  });

  it("no reply at all (every provider failed) is its own outcome and is not re-asked", async () => {
    restore = inWindowOf("gaia");
    const h = heartbeatCtx({ companionId: "gaia", palette: PALETTE, choose: "", decide: [null] });
    await runHeartbeat(h.ctx);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(tick().at(-1)).toMatchObject({ outcome: "no_reply" });
  });
});
