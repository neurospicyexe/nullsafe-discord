import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  readFeelingLineBotMode, gateFeelingLine, renderFeelingLine, feelingLineFromWire, __resetFeelingLineBotWarnings,
} from "../feeling-line-bot.js";
import { formatRecentContext, LibrarianClient } from "../librarian.js";

const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };
const floats = [{ label: "heat", value: 0.68, baseline: 0.5, seed: 0.5, off_baseline_hours: 3 }];
const LINE = "banked ember (0.62)";

describe("readFeelingLineBotMode", () => {
  beforeEach(() => { __resetFeelingLineBotWarnings(); jest.spyOn(console, "warn").mockImplementation(() => {}); });
  it("defaults to shadow", () => { expect(readFeelingLineBotMode({}, "gaia")).toBe("shadow"); });
  it("global knob applies", () => {
    expect(readFeelingLineBotMode({ FEELING_LINE_BOT: "live" }, "cypher")).toBe("live");
    expect(readFeelingLineBotMode({ FEELING_LINE_BOT: " OFF " }, "cypher")).toBe("off");
  });
  it("per-bot override wins, case-insensitively on the companion", () => {
    const env = { FEELING_LINE_BOT: "live", FEELING_LINE_BOT_GAIA: "off", FEELING_LINE_BOT_DREVAN: "shadow" };
    expect(readFeelingLineBotMode(env, "gaia")).toBe("off");
    expect(readFeelingLineBotMode(env, "Drevan")).toBe("shadow");
    expect(readFeelingLineBotMode(env, "cypher")).toBe("live");
  });
  it("junk falls to off", () => { expect(readFeelingLineBotMode({ FEELING_LINE_BOT: "yes" }, "cypher")).toBe("off"); });
});

describe("feelingLineFromWire", () => {
  it.each([[null], [undefined], [""], ["   "], [42], [{}], [["x"]]])("%p renders nothing", (v) => {
    expect(feelingLineFromWire(v)).toBeNull();
    expect(renderFeelingLine(v as any)).toBe("");
  });
  it("returns a string untouched", () => { expect(feelingLineFromWire(` ${LINE} `)).toBe(` ${LINE} `); });
});

describe("gateFeelingLine", () => {
  it("live passes the line, shadow and off inject nothing", () => {
    const log = jest.fn();
    expect(gateFeelingLine(LINE, "cypher", { FEELING_LINE_BOT: "live" }, log)).toBe(LINE);
    expect(gateFeelingLine(LINE, "cypher", { FEELING_LINE_BOT: "shadow" }, log)).toBeNull();
    expect(gateFeelingLine(LINE, "cypher", { FEELING_LINE_BOT: "off" }, log)).toBeNull();
  });
  it("shadow logs counts only, never the text", () => {
    const log = jest.fn();
    gateFeelingLine(LINE, "gaia", {}, log);
    expect(log).toHaveBeenCalledTimes(1);
    const out = String(log.mock.calls[0]![0]);
    expect(out).toBe(`[feeling-line-bot] companion=gaia mode=shadow present=1 len=${LINE.length}`);
    expect(out).not.toContain("ember");
  });
  it("shadow with an absent key logs present=0", () => {
    const log = jest.fn();
    gateFeelingLine(undefined, "gaia", {}, log);
    expect(log).toHaveBeenCalledWith("[feeling-line-bot] companion=gaia mode=shadow present=0 len=0");
  });
  it("off logs nothing and live with a null line is null", () => {
    const log = jest.fn();
    gateFeelingLine(LINE, "cypher", { FEELING_LINE_BOT: "off" }, log);
    expect(log).not.toHaveBeenCalled();
    expect(gateFeelingLine(null, "cypher", { FEELING_LINE_BOT: "live" }, log)).toBeNull();
  });
  it("live logs counts only, never the text", () => {
    const log = jest.fn();
    gateFeelingLine(LINE, "drevan", { FEELING_LINE_BOT: "live" }, log);
    expect(log).toHaveBeenCalledWith(`[feeling-line-bot] companion=drevan mode=live present=1 len=${LINE.length}`);
    expect(String(log.mock.calls[0]![0])).not.toContain("ember");
    gateFeelingLine(null, "drevan", { FEELING_LINE_BOT: "live" }, log);
    expect(log).toHaveBeenLastCalledWith("[feeling-line-bot] companion=drevan mode=live present=0 len=0");
  });
});

describe("formatRecentContext [Feels]", () => {
  it("renders one verbatim line directly above [Body]", () => {
    const ctx = formatRecentContext({ ...base, soma_floats: floats, soma_provenance: [], feeling_line: LINE });
    expect(ctx).toContain(`[Feels] ${LINE}\n[Body] heat 0.68`);
    expect(ctx.match(/\[Feels\]/g)).toHaveLength(1);
  });
  it("renders on its own when there are no floats", () => {
    expect(formatRecentContext({ ...base, feeling_line: LINE })).toContain(`[Feels] ${LINE}`);
  });
  it.each([[null], [undefined], [""]])("renders nothing for %p, body block unchanged", (v) => {
    const withKey = formatRecentContext({ ...base, soma_floats: floats, soma_provenance: [], feeling_line: v as any });
    const without = formatRecentContext({ ...base, soma_floats: floats, soma_provenance: [] });
    expect(withKey).not.toContain("[Feels]");
    expect(withKey.replace(/Now:[^\n]*/, "")).toBe(without.replace(/Now:[^\n]*/, ""));
  });
});

describe("bot orient mapping honours the knob", () => {
  const orientWire = (extra: Record<string, unknown>) => ({
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ data: { ground_threads: [], rag_excerpts: [], ...extra } }) }] } }),
  });
  const run = async (companion: string, mode: string | undefined, extra: Record<string, unknown>) => {
    const saved = { ...process.env };
    if (mode === undefined) { delete process.env["FEELING_LINE_BOT"]; } else process.env["FEELING_LINE_BOT"] = mode;
    delete process.env[`FEELING_LINE_BOT_${companion.toUpperCase()}`];
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const client = new LibrarianClient({ url: "https://example.com", secret: "s", companionId: companion as any, fetch: jest.fn().mockResolvedValue(orientWire(extra)) as unknown as typeof fetch });
      const o = await (client as any).botOrient();
      return { o, logs: logSpy.mock.calls.map((c) => String(c[0])) };
    } finally { logSpy.mockRestore(); process.env = saved; }
  };
  it("live maps the line; old Halseth without the key maps null", async () => {
    expect((await run("cypher", "live", { feeling_line: LINE })).o.feeling_line).toBe(LINE);
    expect((await run("cypher", "live", {})).o.feeling_line).toBeNull();
  });
  it("default shadow maps null and logs counts only", async () => {
    const { o, logs } = await run("drevan", undefined, { feeling_line: LINE });
    expect(o.feeling_line).toBeNull();
    const fl = logs.filter((l) => l.startsWith("[feeling-line-bot]"));
    expect(fl).toHaveLength(1);
    expect(fl[0]).not.toContain("ember");
  });
});
