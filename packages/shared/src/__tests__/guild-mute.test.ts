import { describe, it, expect, afterEach } from "@jest/globals";
import { mutedGuildIds, isMutedGuild, MIDNIGHT_VOICES_GUILD_ID } from "../guild-mute.js";

describe("guild mute (2026-10-05)", () => {
  const prev = process.env["MUTED_GUILD_IDS"];
  afterEach(() => { if (prev === undefined) delete process.env["MUTED_GUILD_IDS"]; else process.env["MUTED_GUILD_IDS"] = prev; });

  // Unset must mute Midnight Voices: deleting its channel entries alone would have opened every room there.
  it("defaults to muting Midnight Voices", () => {
    delete process.env["MUTED_GUILD_IDS"];
    expect(isMutedGuild(MIDNIGHT_VOICES_GUILD_ID, mutedGuildIds())).toBe(true);
    expect(isMutedGuild("1497731504577712191", mutedGuildIds())).toBe(false);
  });
  it("an empty string unmutes everything; a list overrides", () => {
    process.env["MUTED_GUILD_IDS"] = "";
    expect(mutedGuildIds().size).toBe(0);
    process.env["MUTED_GUILD_IDS"] = " 1, 2 ";
    expect([...mutedGuildIds()]).toEqual(["1", "2"]);
  });
  it("never mutes a DM", () => {
    expect(isMutedGuild(null, new Set([MIDNIGHT_VOICES_GUILD_ID]))).toBe(false);
    expect(isMutedGuild(undefined, new Set([MIDNIGHT_VOICES_GUILD_ID]))).toBe(false);
  });
});
