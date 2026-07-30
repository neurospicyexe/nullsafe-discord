import {
  buildCompanionCommands,
  filterModelChoices,
  buildStatusLines,
  AUTOCOMPLETE_LIMIT,
} from "../slash-commands.js";
import { ALL_MODELS } from "../models.js";

describe("buildCompanionCommands", () => {
  it("builds the requested commands with the companion label woven in", () => {
    const cmds = buildCompanionCommands("Cypher", ["model", "status"]) as Array<{
      name: string;
      description: string;
      options?: unknown[];
    }>;
    expect(cmds.map((c) => c.name)).toEqual(["model", "status"]);
    expect(cmds[0].description).toContain("Cypher");
    // /model has the autocompleting key option
    expect((cmds[0].options as Array<{ name: string; autocomplete?: boolean }>)[0].name).toBe("key");
    expect((cmds[0].options as Array<{ name: string; autocomplete?: boolean }>)[0].autocomplete).toBe(true);
  });

  it("defaults to all three commands", () => {
    const cmds = buildCompanionCommands("Gaia") as Array<{ name: string }>;
    expect(cmds.map((c) => c.name).sort()).toEqual(["model", "status", "voice"]);
  });
});

describe("filterModelChoices", () => {
  it("offers 'list' first on an empty query", () => {
    const choices = filterModelChoices("");
    expect(choices[0].value).toBe("list");
  });

  it("filters by key or label, case-insensitive", () => {
    const choices = filterModelChoices("kimi");
    const values = choices.map((c) => c.value);
    expect(values).toContain("kimi-k2");
    expect(values).not.toContain("deepseek-chat");
  });

  it("never exceeds the Discord autocomplete cap", () => {
    // Empty query returns 'list' + every model; assert the cap holds.
    const choices = filterModelChoices("");
    expect(choices.length).toBeLessThanOrEqual(AUTOCOMPLETE_LIMIT);
  });

  it("maps to {name,value} with names within Discord's 100-char limit", () => {
    const choices = filterModelChoices("deepseek");
    for (const c of choices) {
      expect(c.name.length).toBeLessThanOrEqual(100);
      expect(typeof c.value).toBe("string");
    }
    expect(choices.some((c) => c.value === "deepseek-chat")).toBe(true);
  });
});

describe("buildStatusLines", () => {
  it("shows the setting, substrate, and voice state", () => {
    const out = buildStatusLines({
      companionLabel: "Cypher",
      modelKey: "kimi-k2",
      modelLabel: ALL_MODELS["kimi-k2"].label,
      provider: "kimi",
      substrate: "direct/fallback",
      voiceChannel: null,
    });
    expect(out).toContain("Cypher");
    expect(out).toContain("`kimi-k2`");
    expect(out).toContain("substrate: direct/fallback");
    expect(out).toContain("not in voice");
    // Direct mode never shows a Brain line.
    expect(out).not.toContain("Brain live model");
  });

  // These two tests used to cover the Brain live-model sync lines ("✓ in sync" / "catching up" /
  // "unreachable"). Brain mode was removed 2026-07-29, so that behaviour is gone -- replaced here
  // rather than deleted, because the thing worth protecting is that /status reports the substrate
  // TRUTHFULLY. The old code could only ever emit "direct/fallback" (brainClient was always null),
  // so all three bots reported direct/fallback while every reply came from the Hermes agent. A label
  // that cannot be right is worse than no label, and that is what these now pin.
  it("reports hermes as the substrate when that is what is running", () => {
    const out = buildStatusLines({
      companionLabel: "Cypher",
      modelKey: "kimi-k2",
      modelLabel: "Kimi K2",
      provider: "kimi",
      substrate: "hermes",
      voiceChannel: "general",
    });
    expect(out).toContain("substrate: hermes");
    expect(out).toContain("connected to general");
  });

  it("never emits a Brain line on any substrate -- the mode no longer exists", () => {
    for (const substrate of ["hermes", "direct/fallback"] as const) {
      const out = buildStatusLines({
        companionLabel: "Cypher",
        modelKey: "kimi-k2",
        modelLabel: "Kimi K2",
        provider: "kimi",
        substrate,
        voiceChannel: null,
      });
      expect(out).not.toContain("Brain");
      expect(out).not.toContain("in sync");
      expect(out).not.toContain("catching up");
      expect(out).not.toContain("unreachable");
    }
  });

  it("falls back to 'env default' when no model setting is active", () => {
    const out = buildStatusLines({
      companionLabel: "Drevan",
      modelKey: null,
      modelLabel: null,
      provider: null,
      substrate: "direct/fallback",
      voiceChannel: null,
    });
    expect(out).toContain("env default");
  });
});
