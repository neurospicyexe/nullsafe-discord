// Item 10 (2026-11-05): worker kill switches honour off|0|false|no (any case), not only exact "off".
import { describe, it, expect, vi, afterEach } from "vitest";
import { solHoardEnabled } from "../sol-hoard.js";
import { voiceLessonsOn } from "../voice-lessons.js";
import { runVoiceDriftTick } from "../voice-drift.js";
import { runLiveSyncWatchTick } from "../livesync-watch.js";

const OFFS = ["off", "OFF", " Off ", "0", "false", "FALSE", "no"];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("worker off switches", () => {
  it.each(OFFS)("SOL_HOARD / VOICE_LESSONS %j disable", (v) => {
    expect(solHoardEnabled({ SOL_HOARD: v })).toBe(false);
    expect(voiceLessonsOn({ VOICE_LESSONS: v })).toBe(false);
  });
  it("defaults stay on", () => {
    expect(solHoardEnabled({})).toBe(true);
    expect(voiceLessonsOn({})).toBe(true);
  });
  it.each(OFFS)("VOICE_DRIFT=%j returns before touching rows", async (v) => {
    vi.stubEnv("VOICE_DRIFT", v);
    const fetchRows = vi.fn(async () => []);
    await runVoiceDriftTick({ fetchRows });
    expect(fetchRows).not.toHaveBeenCalled();
  });
  it.each(OFFS)("LIVESYNC_WATCH=%j skips before reading config", async (v) => {
    vi.stubEnv("LIVESYNC_WATCH", v);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runLiveSyncWatchTick()).toBe("skipped");
    expect(warn).not.toHaveBeenCalled();
  });
});
