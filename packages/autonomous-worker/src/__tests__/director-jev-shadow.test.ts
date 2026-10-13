// The director's Jev shadow (2026-10-13): detached, never steers select(), logs one decide row.
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  getDirectorSupply: vi.fn(async () => ({ items: [], cursor: "2026-09-03T00:00:00.000Z" })),
  getDirectorNeighborhood: vi.fn(async () => ({ lines: [], nodes: [] })),
  recordInvitation: vi.fn(async () => {}),
  resolveInvitation: vi.fn(async () => {}),
  convoActiveFor: vi.fn(async () => null),
  convoOpenFor: vi.fn(async () => ({ id: "t1" })),
  convoTurnFor: vi.fn(async () => {}),
  convoLandFor: vi.fn(async () => true),
  convoFadeFor: vi.fn(async () => true),
  consumeForageFind: vi.fn(async () => true),
}));

import { fireDirectorJev } from "../director/index.js";
import { emptyState, type ConversationState } from "../director/types.js";

const cfg = { turnBudget: 12, noUptakeMs: 1, inviteTtlMs: 1, order: "heat" as const, limbic: false, minGapMs: 1 };
const state = (): ConversationState => ({
  ...emptyState("ch1", "2026-10-13T00:00:00.000Z"),
  turns: [{ author: "cypher", companionId: "cypher", gist: "Gaia, what do you see?", messageId: "m9", saidAt: "2026-10-13T00:01:00.000Z", isHuman: false }],
  botTurns: 3,
});
const verdict = { nextSpeaker: "gaia" as const, confidence: 0.8, probabilities: { gaia: 0.8 }, threadHasMore: 0.7, echoing: 0.1 };

afterEach(() => { delete process.env["DIRECTOR_JEV"]; });

describe("fireDirectorJev", () => {
  it("logs the director's pick beside Jev's, with agreement", async () => {
    const log = vi.fn();
    const evalFn = vi.fn(async (_s: string) => ({ ok: true as const, verdict, latency_ms: 150, wall_ms: 190 }));
    await fireDirectorJev(state(), { kind: "invite", companionId: "gaia", reason: "addressed", offer: [] }, false, { cfg }, { evalFn, log });
    expect(evalFn.mock.calls[0]![0]).toContain("Cypher: Gaia, what do you see?");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      kind: "decide", channel_id: "ch1", after_msg_id: "m9", after_author: "cypher", bot_turns: 3,
      director: { kind: "invite", companion: "gaia", reason: "addressed", paced: false },
      jev: verdict, jev_failure: null, agree: true,
    }));
  });
  it("a paced invite counts as silence for agreement", async () => {
    const log = vi.fn();
    const evalFn = vi.fn(async () => ({ ok: true as const, verdict, latency_ms: 1, wall_ms: 1 }));
    await fireDirectorJev(state(), { kind: "invite", companionId: "gaia", reason: "addressed", offer: [] }, true, { cfg }, { evalFn, log });
    expect(log.mock.calls[0]![0]).toMatchObject({ agree: false, director: { paced: true } });
  });
  it("a failure is logged as a reason; a throw never escapes", async () => {
    const log = vi.fn();
    await fireDirectorJev(state(), { kind: "silence", reason: "nothing_to_add" }, false, { cfg }, { evalFn: async () => ({ ok: false as const, reason: "http_502", wall_ms: 40 }), log });
    expect(log.mock.calls[0]![0]).toMatchObject({ jev: null, jev_failure: "http_502", agree: null });
    await expect(fireDirectorJev(state(), { kind: "silence", reason: "budget" }, false, { cfg }, { evalFn: async () => { throw new Error("boom"); }, log })).resolves.toBeUndefined();
  });
  it("DIRECTOR_JEV=off: no call, no row", async () => {
    process.env["DIRECTOR_JEV"] = "off";
    const evalFn = vi.fn(); const log = vi.fn();
    await fireDirectorJev(state(), { kind: "silence", reason: "budget" }, false, { cfg }, { evalFn: evalFn as never, log });
    expect(evalFn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
