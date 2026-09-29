// B37 (2026-09-29): Phase 7 (inferred SOMA) is a clerk guessing state, stopped under LEDGER_DISTILL.
// It wrote through PATCH /soma, which Halseth records as writer=<companion>, so its guesses were
// landing as the companions' own authorship.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const updateSomaState = vi.fn().mockResolvedValue(undefined);
vi.mock("../halseth-client.js", () => ({
  updateSomaState: (...a: unknown[]) => updateSomaState(...a),
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

import { runSomaUpdate } from "../phases/soma.js";
import type { PipelineContext } from "../types.js";

const ctx = (companionId: string) =>
  ({ companionId, runId: "r1", runType: "exploration", journalEntry: null, newMarkers: [] }) as unknown as PipelineContext;

describe("Phase 7 SOMA inference gate (B37)", () => {
  const prev = process.env.LEDGER_DISTILL;
  beforeEach(() => updateSomaState.mockClear());
  afterEach(() => { if (prev === undefined) delete process.env.LEDGER_DISTILL; else process.env.LEDGER_DISTILL = prev; });

  it("writes nothing for any companion when the knob is on (the default)", async () => {
    delete process.env.LEDGER_DISTILL;
    for (const c of ["cypher", "drevan", "gaia"]) await runSomaUpdate(ctx(c));
    expect(updateSomaState).not.toHaveBeenCalled();
  });

  it("knob off restores the old writer", async () => {
    process.env.LEDGER_DISTILL = "off";
    await runSomaUpdate(ctx("drevan"));
    expect(updateSomaState).toHaveBeenCalledWith("drevan", expect.objectContaining({ heat: "warm" }));
  });
});
