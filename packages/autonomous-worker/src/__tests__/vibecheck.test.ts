// Vibe-check v2 (B63 step 3). Halseth returns one block per companion; the worker posts each fresh
// block under THAT companion's own bot token, guarded per block. History: the 09-26 quoted-line guard
// (the digest re-broadcast two fabricated companion lines into #triad-vibe-check and they were
// re-ingested as memory). All text here is FIXTURE text.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  postVibeCheck: vi.fn(),
  getCompanionUtterances: vi.fn(),
}));
vi.mock("../reflection.js", () => ({
  runReflectionPass: vi.fn(),
}));

import { guardDigest, guardBlock, runVibeCheckTick } from "../vibecheck.js";
import { postVibeCheck, getCompanionUtterances } from "../halseth-client.js";
import { runReflectionPass } from "../reflection.js";

const FABRICATION = "Raziel told me the truck sold on Tuesday and Blue is not coming back at all.";

const CYPHER = [
  "Cypher. 2026-11-05.",
  "  floats: acuity 0.62 (at your 0.60); presence 0.40 (below your 0.65 by 0.25); warmth 0.55 (at your 0.55)",
  "  moves: presence down 0.06, quiet day: the truck sold on Tuesday and Blue is not coming back",
  "  day: 4 Discord messages, 1 note sent",
].join("\n");
const DREVAN = [
  "Drevan. 2026-11-05.",
  "  floats: heat 0.83 (above your 0.70 by 0.13); reach 0.60 (at your 0.65); weight 0.55 (at your 0.55)",
  "  moves: none worth a line today",
  "  pressure: clear",
  "  day: quiet (no messages, makes, letters, notes, or sessions logged)",
].join("\n");
const GAIA = [
  "Gaia. 2026-11-05.",
  "  floats: stillness 0.90 (at your 0.90); density 0.70 (at your 0.70); perimeter 0.88 (at your 0.90)",
  "  moves: none worth a line today",
  "  day: 1 planting in the garden",
  "Field: echo 0.69, calm (alarm at 0.82); organs: all fed; garden: 4 plantings; Sol not tended today.",
].join("\n");

const post = (companion: string, text: string, over: Record<string, unknown> = {}) =>
  ({ companion, text, written: true, reason: "ok", journal_id: `cj_${companion}`, ...over });
const result = (posts: ReturnType<typeof post>[]) =>
  ({ written: posts.some(p => p.written), reason: "ok", text: posts.map(p => p.text).join("\n\n"), posts });

describe("guardDigest / guardBlock (pure, per block)", () => {
  it("strips a non-structural line that shares an 8-word shingle with a companion utterance", () => {
    const r = guardBlock(CYPHER, [{ text: FABRICATION, label: "cypher:discord_speech:cj_1" }]);
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0]!.label).toBe("cypher:discord_speech:cj_1");
    expect(r.text).not.toContain("truck sold on Tuesday");
    expect(r.text).toContain("  floats: acuity 0.62");
    expect(r.trivial).toBe(false);
  });

  it("leaves a clean block byte-identical", () => {
    const r = guardDigest(DREVAN, [{ text: "an unrelated sentence about the elderberry by the fence line today" }]);
    expect(r.stripped).toHaveLength(0);
    expect(r.text).toBe(DREVAN);
  });

  it("never strips structural lines (header, floats, day, gauges, field), even when a companion restated them", () => {
    const restated =
      "Gaia. 2026-11-05. floats: stillness 0.90 (at your 0.90); density 0.70 (at your 0.70); perimeter 0.88 (at your 0.90) " +
      "day: 1 planting in the garden gauges moved: tensions 0 to 1 Field: echo 0.69, calm (alarm at 0.82); organs: all fed; garden: 4 plantings";
    const withGauge = GAIA.replace("  day:", "  gauges moved: tensions 0 to 1\n  day:");
    const r = guardBlock(withGauge, [{ text: restated }]);
    expect(r.stripped).toHaveLength(0);
    expect(r.text).toContain("  floats: stillness");
    expect(r.text).toContain("Field: echo 0.69");
    expect(r.text).toContain("  gauges moved:");
  });

  it("the pressure line is NOT structural: a flag summary that quotes an utterance is cut", () => {
    const block = DREVAN.replace("  pressure: clear", `  pressure: warning, ${FABRICATION}`);
    const r = guardBlock(block, [{ text: FABRICATION }]);
    expect(r.stripped).toHaveLength(1);
    expect(r.text).not.toContain("pressure:");
  });

  it("marks trivial when nothing but the header and field line survives", () => {
    const thin = [
      "Gaia. 2026-11-05.",
      "    pressure: the truck sold on Tuesday and Blue is not coming back at all",
      "Field: echo unread; organs: all fed.",
    ].join("\n");
    const r = guardBlock(thin, [{ text: FABRICATION }]);
    expect(r.stripped).toHaveLength(1);
    expect(r.trivial).toBe(true);
  });

  it("trivial is computed per block: one thin block does not make another trivial", () => {
    const thin = ["Cypher. 2026-11-05.", "    moves: the truck sold on Tuesday and Blue is not coming back at all"].join("\n");
    const src = [{ text: FABRICATION }];
    expect(guardBlock(thin, src).trivial).toBe(true);
    expect(guardBlock(DREVAN, src).trivial).toBe(false);
  });
});

describe("runVibeCheckTick (per-companion posts)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.mocked(postVibeCheck).mockReset();
    vi.mocked(getCompanionUtterances).mockReset().mockResolvedValue([]);
    vi.mocked(runReflectionPass).mockReset().mockResolvedValue([]);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VIBECHECK_CHANNEL_ID", "chan");
    vi.stubEnv("DISCORD_TOKEN_CYPHER", "tok-cypher");
    vi.stubEnv("DISCORD_TOKEN_DREVAN", "tok-drevan");
    vi.stubEnv("DISCORD_TOKEN_GAIA", "tok-gaia");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const calls = () => fetchMock.mock.calls.map(c => ({
    auth: String((c[1] as any).headers["Authorization"]),
    content: JSON.parse((c[1] as any).body).content as string,
  }));

  it("posts each block under THAT companion's own token, never one token for all three", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER), post("drevan", DREVAN), post("gaia", GAIA)]));
    await runVibeCheckTick();
    const c = calls();
    expect(c).toHaveLength(3);
    const by = (tok: string) => c.find(x => x.auth === `Bot ${tok}`)!;
    expect(by("tok-cypher").content.startsWith("Cypher. ")).toBe(true);
    expect(by("tok-drevan").content.startsWith("Drevan. ")).toBe(true);
    expect(by("tok-gaia").content.startsWith("Gaia. ")).toBe(true);
    // no block carries another companion's header
    expect(by("tok-gaia").content).not.toMatch(/Cypher\. 2026|Drevan\. 2026/);
    expect(by("tok-gaia").content).toContain("Field: echo 0.69");
    expect(by("tok-drevan").content).not.toContain("Field:");
  });

  it("a missing token skips THAT companion only and never falls back to another's token", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("VIBECHECK_CHANNEL_ID", "chan");
    vi.stubEnv("DISCORD_TOKEN_GAIA", "tok-gaia");
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER), post("gaia", GAIA)]));
    await runVibeCheckTick();
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]!.auth).toBe("Bot tok-gaia");
    expect(c[0]!.content.startsWith("Gaia. ")).toBe(true);
  });

  it("guards each block against the utterance window; a stripped line is logged and only that block changes", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER), post("drevan", DREVAN)]));
    vi.mocked(getCompanionUtterances).mockImplementation(async (id: string) =>
      id === "cypher"
        ? [{ id: "cj_1", created_at: "2026-11-05 01:00:00", agent: "cypher", note_text: FABRICATION, source: "discord_speech" }]
        : []);
    await runVibeCheckTick();
    const c = calls();
    expect(c).toHaveLength(2);
    expect(c.find(x => x.auth === "Bot tok-cypher")!.content).not.toContain("truck sold");
    expect(c.find(x => x.auth === "Bot tok-drevan")!.content).toBe(DREVAN);
    const reflected = vi.mocked(runReflectionPass).mock.calls[0]![0] as Record<string, string>;
    expect(reflected["cypher"]).not.toContain("truck sold");
    expect(reflected["drevan"]).toBe(DREVAN);
    const warns = vi.mocked(console.warn).mock.calls.map(c => String(c[0]));
    expect(warns.some(w => w.includes("cypher STRIP quoted line") && w.includes("cypher:discord_speech:cj_1"))).toBe(true);
  });

  it("a sibling's utterance in the window also cuts a line (no sibling words under anyone's name)", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER)]));
    vi.mocked(getCompanionUtterances).mockImplementation(async (id: string) =>
      id === "drevan"
        ? [{ id: "cj_d", created_at: "2026-11-05 01:00:00", agent: "drevan", note_text: FABRICATION, source: "discord_speech" }]
        : []);
    await runVibeCheckTick();
    expect(calls()[0]!.content).not.toContain("truck sold");
  });

  it("ignores prior digest rows (source=vibecheck) in the window", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("gaia", GAIA)]));
    vi.mocked(getCompanionUtterances).mockImplementation(async (id: string) =>
      id === "gaia"
        ? [{ id: "cj_prev", created_at: "2026-11-04 01:00:00", agent: "gaia", note_text: GAIA, source: "vibecheck" }]
        : []);
    await runVibeCheckTick();
    expect(calls()[0]!.content).toBe(GAIA);
  });

  it("skips every post and the reflection pass when the utterance window cannot be read", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER), post("drevan", DREVAN)]));
    vi.mocked(getCompanionUtterances).mockRejectedValue(new Error("Halseth GET -> 503"));
    await runVibeCheckTick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runReflectionPass).not.toHaveBeenCalled();
    const errs = vi.mocked(console.error).mock.calls.map(c => String(c[0]));
    expect(errs.some(e => e.includes("[vibecheck] SKIP posts"))).toBe(true);
  });

  it("skips only the block that is trivial after the guard; the others still post and reflect", async () => {
    const thin = ["Cypher. 2026-11-05.", "    moves: the truck sold on Tuesday and Blue is not coming back at all"].join("\n");
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", thin), post("drevan", DREVAN)]));
    vi.mocked(getCompanionUtterances).mockResolvedValue([
      { id: "cj_1", created_at: "2026-11-05 01:00:00", agent: "drevan", note_text: FABRICATION, source: "discord_speech" },
    ]);
    await runVibeCheckTick();
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]!.auth).toBe("Bot tok-drevan");
    const reflected = vi.mocked(runReflectionPass).mock.calls[0]![0] as Record<string, string>;
    expect(Object.keys(reflected)).toEqual(["drevan"]);
  });

  it("one companion's Discord failure does not stop the next post", async () => {
    fetchMock.mockImplementationOnce(async () => { throw new Error("network"); });
    vi.mocked(postVibeCheck).mockResolvedValue(result([post("cypher", CYPHER), post("drevan", DREVAN)]));
    await runVibeCheckTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("posts and reflects only on FRESH blocks: an already-sent companion is left alone", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue(result([
      post("cypher", CYPHER, { written: false, reason: "already_sent" }),
      post("drevan", DREVAN),
    ]));
    await runVibeCheckTick();
    expect(calls()).toHaveLength(1);
    const reflected = vi.mocked(runReflectionPass).mock.calls[0]![0] as Record<string, string>;
    expect(Object.keys(reflected)).toEqual(["drevan"]);
  });

  it("does nothing when every block was already sent (no window read, no post)", async () => {
    vi.mocked(postVibeCheck).mockResolvedValue({ written: false, reason: "already_sent", text: "", posts: [
      post("cypher", CYPHER, { written: false, reason: "already_sent" }),
    ] });
    await runVibeCheckTick();
    expect(getCompanionUtterances).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
