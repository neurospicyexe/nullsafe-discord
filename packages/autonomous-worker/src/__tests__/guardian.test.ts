// Guardian tick: thin trigger -- letter rides the GUARDIAN_LETTER_DOW tick only.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  runGuardian: vi.fn(async () => ({ flags_created: 1, flags_resolved: 0, letter_id: null })),
}));

import { runGuardianTick } from "../guardian.js";
import { runGuardian } from "../halseth-client.js";
import { GUARDIAN_LETTER_DOW } from "../config.js";

const mocked = vi.mocked(runGuardian);

// Build a date that lands on / off the letter day-of-week (default Sunday).
function dateOnDow(dow: number): Date {
  const d = new Date("2026-06-07T08:00:00Z"); // a Sunday
  d.setUTCDate(d.getUTCDate() + ((dow - d.getDay() + 7) % 7));
  return d;
}

beforeEach(() => { mocked.mockClear(); });

describe("runGuardianTick", () => {
  it("requests the weekly letter only on the configured day", async () => {
    await runGuardianTick(dateOnDow(GUARDIAN_LETTER_DOW));
    expect(mocked).toHaveBeenLastCalledWith(true);

    await runGuardianTick(dateOnDow((GUARDIAN_LETTER_DOW + 3) % 7));
    expect(mocked).toHaveBeenLastCalledWith(false);
  });

  it("propagates halseth failure to the caller (scheduler catches + logs)", async () => {
    mocked.mockRejectedValueOnce(new Error("halseth down"));
    await expect(runGuardianTick(dateOnDow(1))).rejects.toThrow("halseth down");
  });
});
