import { describe, it, expect, afterEach } from "vitest";
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("director config", () => {
  it("parses mode, channels and numeric knobs with defaults", async () => {
    process.env["DIRECTOR_ENABLED"] = "shadow";
    process.env["DIRECTOR_CHANNELS"] = "1,2";
    delete process.env["DIRECTOR_SILENCE_HOURS"];
    const cfg = await import("../director/config.js");
    expect(cfg.directorConfig().mode).toBe("shadow");
    expect(cfg.directorConfig().channels).toEqual(["1", "2"]);
    expect(cfg.directorConfig().silenceHours).toBe(6);
    expect(cfg.directorConfig().order).toBe("heat");
  });

  it("reads env on every call, not at import", async () => {
    const cfg = await import("../director/config.js");
    process.env["DIRECTOR_ENABLED"] = "shadow";
    expect(cfg.directorConfig().mode).toBe("shadow");
    process.env["DIRECTOR_ENABLED"] = "true";
    expect(cfg.directorConfig().mode).toBe("live");
    process.env["DIRECTOR_WAKING_START"] = "0";
    process.env["DIRECTOR_TZ_OFFSET_HOURS"] = "0";
    expect(cfg.directorConfig().wakingStartHour).toBe(0);
    expect(cfg.directorConfig().tzOffsetHours).toBe(0);
  });
});
