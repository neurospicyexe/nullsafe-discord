import { describe, test, expect, vi } from "vitest";
import { createWakeDispatcher } from "../wake-dispatch.js";

describe("createWakeDispatcher", () => {
  test("runs the registered runner and returns true", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const dispatch = createWakeDispatcher({ council: runner });
    await expect(dispatch("council")).resolves.toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test("returns false for a kind with no registered runner", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const dispatch = createWakeDispatcher({ council: runner });
    await expect(dispatch("club")).resolves.toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  test("in-flight guard: a second dispatch of the same kind is skipped while one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = vi.fn(() => gate);
    const dispatch = createWakeDispatcher({ council: runner });

    const first = dispatch("council");        // starts the runner, suspends on gate
    const second = dispatch("council");        // guard active -> skipped immediately

    await expect(second).resolves.toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe(true);

    // guard cleared -> a later dispatch runs again
    await expect(dispatch("council")).resolves.toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test("guard is released even if the runner throws", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("boom"));
    const dispatch = createWakeDispatcher({ council: runner });

    await expect(dispatch("council")).rejects.toThrow("boom");
    // finally cleared the in-flight flag, so the next dispatch is not stuck
    await expect(dispatch("council")).rejects.toThrow("boom");
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
