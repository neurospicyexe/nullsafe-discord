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
});
