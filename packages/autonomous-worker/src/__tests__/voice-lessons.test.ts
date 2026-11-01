// Voice lessons (2026-11-01): one staged lesson per flagged night, from marker names and z only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { lessonAsk, parseLesson, stageVoiceLesson } from "../voice-lessons.js";

afterEach(() => { delete process.env["VOICE_LESSONS"]; vi.restoreAllMocks(); });

describe("voice lessons", () => {
  it("the ask carries marker names and z only", () => {
    const a = lessonAsk("drevan", { hedging: 2.4, length: -0.3 }, ["hedging"]);
    expect(a).toContain("hedging: z=2.4 (more than your usual)");
    expect(a).not.toContain("length");
  });
  it("parses the JSON reply, strips em dashes, rejects junk", () => {
    expect(parseLesson('ok {"kind":"corrective","body":"say it plain — once"}')).toEqual({ kind: "corrective", body: "say it plain; once" });
    expect(parseLesson('{"kind":"rule","body":"x"}')).toBeNull();
    expect(parseLesson("no json")).toBeNull();
  });
  it("stages one lesson and reports staged / exists / unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const posted: any[] = [];
    const ask = async () => '{"kind":"lesson","body":"I hedge when I care."}';
    expect(await stageVoiceLesson("gaia", { hedging: 2.1 }, ["hedging"], { ask, post: async (b) => { posted.push(b); return 201; } })).toBe("staged");
    expect(posted[0]).toEqual({ companion_id: "gaia", kind: "lesson", body: "I hedge when I care.", evidence: { hedging: 2.1 } });
    expect(await stageVoiceLesson("gaia", { hedging: 2.1 }, ["hedging"], { ask, post: async () => 200 })).toBe("exists");
    expect(await stageVoiceLesson("gaia", { hedging: 2.1 }, ["hedging"], { ask, post: async () => 404 })).toBe("unavailable");
  });
  it("quiet night, off switch and a throwing model all stage nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = vi.fn(async () => 201);
    expect(await stageVoiceLesson("cypher", {}, [], { post })).toBe("nothing_flagged");
    process.env["VOICE_LESSONS"] = "off";
    expect(await stageVoiceLesson("cypher", { a: 3 }, ["a"], { post })).toBe("off");
    delete process.env["VOICE_LESSONS"];
    expect(await stageVoiceLesson("cypher", { a: 3 }, ["a"], { ask: async () => { throw new Error("down"); }, post })).toBe("failed");
    expect(post).not.toHaveBeenCalled();
  });
});
