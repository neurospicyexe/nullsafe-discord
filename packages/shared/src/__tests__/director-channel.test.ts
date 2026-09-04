import { describe, test, expect, afterEach } from "@jest/globals";
import { directorMode, isDirectorChannel } from "../channel-config.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("director channel gate", () => {
  test("mode parses off/shadow/live", () => {
    delete process.env["DIRECTOR_ENABLED"]; expect(directorMode()).toBe("off");
    process.env["DIRECTOR_ENABLED"] = "shadow"; expect(directorMode()).toBe("shadow");
    process.env["DIRECTOR_ENABLED"] = "true"; expect(directorMode()).toBe("live");
    process.env["DIRECTOR_ENABLED"] = "yes"; expect(directorMode()).toBe("off");
  });
  test("triad commons is always a director channel", () => {
    expect(isDirectorChannel({ modes: ["autonomous", "inter_companion"] }, "123")).toBe(true);
    expect(isDirectorChannel({ modes: ["owner_only", "inter_companion"] }, "123")).toBe(false);
  });
  test("DIRECTOR_CHANNELS opts extra channels in", () => {
    process.env["DIRECTOR_CHANNELS"] = "111, 222";
    expect(isDirectorChannel(undefined, "222")).toBe(true);
    expect(isDirectorChannel(undefined, "333")).toBe(false);
  });
});
